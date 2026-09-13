import type { Env } from './types';
import * as cache from './cache';
import { log, Tag } from './logger';

const TOKEN_CACHE_KEY = 'apple_music_token';
const TOKEN_TTL_SECONDS = 3600;

const AM_MINT_URL = process.env.AM_MINT_URL || 'https://am-mint.binimum.org/token';
const MINT_TIMEOUT_MS = 5000;
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 3600;

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export type TokenSource = 'mint' | 'scrape';
export interface TokenResult {
  token: string;
  source: TokenSource;
}

export function clampTokenTtl(ttl: number): number {
  if (!Number.isFinite(ttl)) return MIN_TTL_SECONDS;
  return Math.max(MIN_TTL_SECONDS, Math.min(MAX_TTL_SECONDS, Math.floor(ttl)));
}

async function readCachedToken(env?: Env): Promise<TokenResult | null> {
  const raw = env?.CACHE ? await env.CACHE.get(TOKEN_CACHE_KEY) : cache.get(TOKEN_CACHE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<TokenResult>;
    if (typeof parsed.token === 'string' && (parsed.source === 'mint' || parsed.source === 'scrape')) {
      return { token: parsed.token, source: parsed.source };
    }
  } catch {
    return null;
  }
  return null;
}

async function writeCachedToken(
  env: Env | undefined,
  result: TokenResult,
  ttlSeconds: number
): Promise<void> {
  const raw = JSON.stringify(result);
  if (env?.CACHE) {
    await env.CACHE.put(TOKEN_CACHE_KEY, raw, { expirationTtl: ttlSeconds });
  } else {
    cache.set(TOKEN_CACHE_KEY, raw, ttlSeconds);
  }
}

async function mintToken(): Promise<{ token: string; ttlSeconds: number }> {
  const res = await fetch(AM_MINT_URL, {
    signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`mint failed: ${res.status}`);
  const data = (await res.json()) as { token?: string; cache_ttl_seconds?: number };
  if (!data.token) throw new Error('mint response missing token');
  return { token: data.token, ttlSeconds: clampTokenTtl(data.cache_ttl_seconds ?? MIN_TTL_SECONDS) };
}

export async function getToken(env?: Env): Promise<TokenResult> {
  const cached = await readCachedToken(env);
  if (cached) {
    log.debug(Tag.TOKEN, `cache hit (${env?.CACHE ? 'kv' : 'memory'})`, { source: cached.source });
    return cached;
  }

  let result: TokenResult;
  let ttlSeconds: number;
  try {
    const minted = await mintToken();
    result = { token: minted.token, source: 'mint' };
    ttlSeconds = minted.ttlSeconds;
    log.info(Tag.TOKEN, 'token source=mint', { ttlSeconds, chars: minted.token.length });
  } catch (err) {
    log.warn(Tag.TOKEN, 'mint failed, falling back to scrape', err);
    const token = await scrapeToken();
    result = { token, source: 'scrape' };
    ttlSeconds = TOKEN_TTL_SECONDS;
    log.info(Tag.TOKEN, 'token source=scrape', { ttlSeconds, chars: token.length });
  }

  await writeCachedToken(env, result, ttlSeconds);
  return result;
}

async function scrapeToken(): Promise<string> {
  const browseStart = Date.now();
  log.debug(Tag.TOKEN, '→ GET music.apple.com/us/browse');
  const browseResponse = await fetch('https://music.apple.com/us/browse', {
    headers: {
      'User-Agent': BROWSER_USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });
  log.debug(Tag.TOKEN, '← browse', { status: browseResponse.status, ms: Date.now() - browseStart });

  if (!browseResponse.ok) {
    throw new Error(`Failed to fetch Apple Music browse page: ${browseResponse.status}`);
  }

  const html = await browseResponse.text();

  const jsPathMatch = html.match(/\/assets\/index[~-][a-zA-Z0-9]+\.js/);
  if (!jsPathMatch) {
    log.error(Tag.TOKEN, 'js bundle path not found in browse HTML');
    throw new Error('Could not find JS bundle path in Apple Music page');
  }

  const jsPath = jsPathMatch[0];
  const jsUrl = `https://music.apple.com${jsPath}`;
  log.debug(Tag.TOKEN, 'found bundle', { path: jsPath });

  const jsStart = Date.now();
  log.debug(Tag.TOKEN, '→ GET js bundle');
  const jsResponse = await fetch(jsUrl, {
    headers: { 'User-Agent': BROWSER_USER_AGENT },
  });
  log.debug(Tag.TOKEN, '← bundle', { status: jsResponse.status, ms: Date.now() - jsStart });

  if (!jsResponse.ok) {
    throw new Error(`Failed to fetch JS bundle: ${jsResponse.status}`);
  }

  const jsContent = await jsResponse.text();

  const tokenMatch = jsContent.match(/"(eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6[^"]+)"/);
  if (tokenMatch) {
    log.info(Tag.TOKEN, 'extracted JWT (ES256)', { chars: tokenMatch[1].length });
    return tokenMatch[1];
  }

  const jwtMatch = jsContent.match(/"(eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})"/);
  if (jwtMatch) {
    log.info(Tag.TOKEN, 'extracted JWT (fallback regex)', { chars: jwtMatch[1].length });
    return jwtMatch[1];
  }

  log.error(Tag.TOKEN, 'JWT pattern not found in bundle');
  throw new Error('Could not extract JWT token from JS bundle');
}

export async function invalidateToken(env?: Env): Promise<void> {
  log.warn(Tag.TOKEN, 'invalidating cached token');
  if (env?.CACHE) {
    await env.CACHE.delete(TOKEN_CACHE_KEY);
  } else {
    cache.del(TOKEN_CACHE_KEY);
  }
}
