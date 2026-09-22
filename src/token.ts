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
const MINT_USER_AGENT = 'artwork.boidu.dev';

export type TokenSource = 'mint' | 'scrape';
export interface TokenResult {
  token: string;
  source: TokenSource;
  storefront?: string;
  storefrontId?: string;
}

const APPLE_STOREFRONT_CODES: Record<string, string> = {
  '143441': 'us', '143442': 'fr', '143443': 'de', '143444': 'gb', '143445': 'at',
  '143446': 'be', '143447': 'fi', '143448': 'gr', '143449': 'ie', '143450': 'it',
  '143451': 'lu', '143452': 'nl', '143453': 'pt', '143454': 'es', '143455': 'ca',
  '143456': 'se', '143457': 'no', '143458': 'dk', '143459': 'ch', '143460': 'au',
  '143461': 'nz', '143462': 'jp', '143463': 'hk', '143464': 'sg', '143465': 'cn',
  '143466': 'kr', '143467': 'in', '143468': 'mx', '143469': 'ru', '143470': 'tw',
  '143471': 'vn', '143472': 'za', '143473': 'my', '143474': 'ph', '143475': 'th',
  '143476': 'id', '143477': 'pk', '143478': 'pl', '143479': 'sa', '143480': 'tr',
  '143481': 'ae', '143482': 'hu', '143483': 'cl', '143484': 'np', '143485': 'pa',
  '143486': 'lk', '143487': 'ro', '143488': 'mv', '143489': 'cz', '143490': 'bd',
  '143491': 'il', '143492': 'ua', '143493': 'kw', '143494': 'hr', '143495': 'cr',
  '143496': 'sk', '143497': 'lb', '143498': 'qa', '143499': 'si', '143500': 'rs',
  '143501': 'co', '143502': 've', '143503': 'br', '143504': 'gt', '143505': 'ar',
  '143506': 'sv', '143507': 'pe', '143508': 'do', '143509': 'ec', '143510': 'hn',
  '143511': 'jm', '143512': 'ni', '143513': 'py', '143514': 'uy', '143515': 'mo',
  '143516': 'eg', '143517': 'kz', '143518': 'ee', '143519': 'lv', '143520': 'lt',
  '143521': 'mt', '143522': 'li', '143523': 'md', '143524': 'am', '143525': 'bw',
  '143526': 'bg', '143527': 'ci', '143528': 'jo', '143529': 'ke', '143530': 'mk',
  '143531': 'mg', '143532': 'ml', '143533': 'mu', '143534': 'ne', '143535': 'sn',
  '143536': 'tn', '143537': 'ug', '143538': 'ai', '143539': 'bs', '143540': 'ag',
  '143541': 'bb', '143542': 'bm', '143543': 'vg', '143544': 'ky', '143545': 'dm',
  '143546': 'gd', '143547': 'ms', '143548': 'kn', '143549': 'lc', '143550': 'vc',
  '143551': 'tt', '143552': 'tc', '143553': 'gy', '143554': 'sr', '143555': 'bz',
  '143556': 'bo', '143557': 'cy', '143558': 'is', '143559': 'bh', '143560': 'bn',
  '143561': 'ng', '143562': 'om', '143563': 'dz', '143564': 'ao', '143565': 'by',
  '143566': 'uz', '143568': 'az', '143572': 'tz', '143573': 'gh',
};

export function mintedStorefrontCode(storefrontId: string): string | undefined {
  const cut = storefrontId.search(/[-,]/);
  const numeric = cut >= 0 ? storefrontId.slice(0, cut) : storefrontId;
  return APPLE_STOREFRONT_CODES[numeric];
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
      const result: TokenResult = { token: parsed.token, source: parsed.source };
      if (parsed.source === 'mint' && typeof parsed.storefront === 'string' && typeof parsed.storefrontId === 'string') {
        result.storefront = parsed.storefront;
        result.storefrontId = parsed.storefrontId;
      }
      return result;
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

async function mintToken(): Promise<{ token: string; ttlSeconds: number; storefront: string; storefrontId: string }> {
  const res = await fetch(AM_MINT_URL, {
    signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
    headers: { Accept: 'application/json', 'User-Agent': MINT_USER_AGENT },
  });
  if (!res.ok) throw new Error(`mint failed: ${res.status}`);
  const data = (await res.json()) as { token?: string; cache_ttl_seconds?: number; storefront_id?: string };
  if (!data.token) throw new Error('mint response missing token');
  const storefrontId = data.storefront_id ?? '';
  const storefront = mintedStorefrontCode(storefrontId);
  if (!storefront) throw new Error(`mint returned unmappable storefront ${JSON.stringify(storefrontId)}`);
  return {
    token: data.token,
    ttlSeconds: clampTokenTtl(data.cache_ttl_seconds ?? MIN_TTL_SECONDS),
    storefront,
    storefrontId,
  };
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
    result = { token: minted.token, source: 'mint', storefront: minted.storefront, storefrontId: minted.storefrontId };
    ttlSeconds = minted.ttlSeconds;
    log.info(Tag.TOKEN, 'token source=mint', { ttlSeconds, chars: minted.token.length, storefront: minted.storefront });
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
