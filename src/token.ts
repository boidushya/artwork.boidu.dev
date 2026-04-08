import type { Env } from './types';
import * as cache from './cache';
import { log, Tag } from './logger';

const TOKEN_CACHE_KEY = 'apple_music_token';
const TOKEN_TTL_SECONDS = 3600;

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export async function getToken(env?: Env): Promise<string> {
  if (env?.CACHE) {
    const cached = await env.CACHE.get(TOKEN_CACHE_KEY);
    if (cached) {
      log.debug(Tag.TOKEN, 'cache hit (kv)');
      return cached;
    }
  } else {
    const cached = cache.get(TOKEN_CACHE_KEY);
    if (cached) {
      log.debug(Tag.TOKEN, 'cache hit (memory)');
      return cached;
    }
  }

  log.info(Tag.TOKEN, 'cache miss — scraping fresh token');
  const token = await scrapeToken();

  if (env?.CACHE) {
    await env.CACHE.put(TOKEN_CACHE_KEY, token, { expirationTtl: TOKEN_TTL_SECONDS });
  } else {
    cache.set(TOKEN_CACHE_KEY, token, TOKEN_TTL_SECONDS);
  }
  log.info(Tag.TOKEN, 'cached', { ttlSeconds: TOKEN_TTL_SECONDS, chars: token.length });

  return token;
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
