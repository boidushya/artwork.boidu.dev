import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import type { ArtworkResponse, ErrorResponse } from './types';
import { getToken, invalidateToken, storefrontHeaderId } from './token';
import { searchTrack, searchWebLane } from './search';
import { fetchAlbum, isAppleAlbumId, parseAlbumIdFromUrl } from './album';
import { resolveVideoUrl } from './m3u8';
import { runMigrations } from './db';
import {
  getSearchIndex,
  getSearchIndexAnywhere,
  upsertSearchIndex,
  getAlbumCache,
  getAlbumByIdAnywhere,
  albumRowToResponse,
  upsertAlbumCache,
} from './resultCache';
import { artworkRateLimit, mintRateLimit } from './rateLimit';
import { UpstreamRateLimitedError } from './outboundLimiter';
import { TransientUpstreamError, errorHttpResponse, USAGE } from './errors';
import type { TokenResult } from './token';
import { resolveTier, mintToken, gatingEnabled } from './priority';
import type { Tier } from './priority';
import { createPowChallenge, verifyPowSolution, mintGateEnabled } from './mintGate';
import { log, Tag } from './logger';

const MEDIA_USER_TOKEN = process.env.MEDIA_USER_TOKEN;
log.info(
  Tag.MUT,
  MEDIA_USER_TOKEN ? 'env loaded' : 'env NOT set, requests will be anonymous',
  MEDIA_USER_TOKEN ? { chars: MEDIA_USER_TOKEN.length } : undefined
);

try {
  await runMigrations();
} catch (err) {
  log.error(Tag.DB, 'startup migration failed, continuing without cache', err);
}

const app = new Hono();

if (gatingEnabled() !== mintGateEnabled()) {
  log.warn(Tag.SERVER, 'priority gating half-configured: set both BLS_JWT_SECRET and BLS_ALTCHA_HMAC or neither; gating stays off');
}

function priorityEnabled(): boolean {
  return gatingEnabled() && mintGateEnabled();
}

app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400,
}));

app.use('*', async (c, next) => {
  const start = Date.now();
  const method = c.req.method;
  const path = new URL(c.req.url).pathname + (new URL(c.req.url).search || '');
  log.debug(Tag.HTTP, '→ request', { method, path });
  await next();
  const ms = Date.now() - start;
  const status = c.res.status;
  const line = `${method} ${path} ${status}`;
  const meta = { ms };
  if (status >= 500) log.error(Tag.HTTP, line, meta);
  else if (status >= 400) log.warn(Tag.HTTP, line, meta);
  else log.info(Tag.HTTP, line, meta);
});

app.use('*', artworkRateLimit);

app.get('/health', (c) => c.json({ status: 'ok' }));

app.get('/challenge', mintRateLimit, async (c) => {
  if (!priorityEnabled()) return c.json({ error: 'Not found' }, 404);
  const challenge = await createPowChallenge();
  return c.json(challenge);
});

app.post('/mint', mintRateLimit, async (c) => {
  if (!priorityEnabled()) return c.json({ error: 'Not found' }, 404);
  let body: { challenge?: unknown; solution?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid body' }, 400);
  }
  if (!body.challenge || !body.solution) {
    return c.json({ error: 'Missing challenge or solution' }, 400);
  }
  const ok = await verifyPowSolution({
    challenge: body.challenge as Parameters<typeof verifyPowSolution>[0]['challenge'],
    solution: body.solution,
  });
  if (!ok) return c.json({ error: 'Invalid solution' }, 401);
  return c.json({ token: mintToken() });
});

app.get('/', handleArtwork);
app.get('/artwork', handleArtwork);

async function handleArtwork(c: any): Promise<Response> {
  try {
    const tier = priorityEnabled() ? resolveTier(c.req.header('authorization') ?? null) : 'priority';
    const result = await handleArtworkRequest(c.req.url, tier);
    return c.json(result);
  } catch (error) {
    if (error instanceof UpstreamRateLimitedError) {
      log.warn(Tag.HTTP, 'upstream rate limited → 503', { endpoint: error.endpoint });
    } else if (error instanceof TransientUpstreamError) {
      log.warn(Tag.HTTP, 'transient upstream failure → 502', { error: error.message });
    } else {
      log.error(Tag.HTTP, 'unhandled request error', error);
    }
    const { status, body } = errorHttpResponse(error);
    return c.json(body, status);
  }
}

async function handleArtworkRequest(
  requestUrl: string,
  tier: Tier
): Promise<ArtworkResponse | ErrorResponse> {
  const url = new URL(requestUrl);
  const song = url.searchParams.get('s') || url.searchParams.get('song');
  const artist = url.searchParams.get('a') || url.searchParams.get('artist');
  const albumIdParam = url.searchParams.get('id');
  const appleUrl = url.searchParams.get('url');
  const albumName =
    url.searchParams.get('al') || url.searchParams.get('albumName') || undefined;
  const durationParam = url.searchParams.get('d') || url.searchParams.get('duration');
  const duration = durationParam ? parseInt(durationParam, 10) : undefined;

  let tokenResult: TokenResult | null = null;
  try {
    tokenResult = await getToken();
  } catch (error) {
    log.error(Tag.TOKEN, 'failed to get token', error);
  }
  const storefront = tokenResult?.storefront || 'vn';

  let resolvedAlbumId: string | null = null;
  let trackName: string | null = null;
  let trackArtist: string | null = null;

  if (albumIdParam) {
    if (!isAppleAlbumId(albumIdParam)) {
      log.info(Tag.HTTP, 'rejected non-apple album id', { albumId: albumIdParam });
      return { error: 'Invalid album id' };
    }
    log.debug(Tag.HTTP, 'route: direct id', { albumId: albumIdParam });
    resolvedAlbumId = albumIdParam;
  } else if (appleUrl) {
    log.debug(Tag.HTTP, 'route: apple url', { appleUrl });
    resolvedAlbumId = parseAlbumIdFromUrl(appleUrl);
    if (!resolvedAlbumId) {
      log.warn(Tag.HTTP, 'invalid apple music url', { appleUrl });
      return { error: 'Invalid Apple Music URL' };
    }
  } else if (song && artist) {
    log.debug(Tag.HTTP, 'route: search', { song, artist, storefront, albumName, duration });
    const cachedSearch = await getSearchIndex({ storefront, song, artist, albumName, duration });
    if (cachedSearch) {
      if (cachedSearch.albumId === null) {
        return { error: 'No matching tracks found' };
      }
      resolvedAlbumId = cachedSearch.albumId;
      trackName = cachedSearch.trackName;
      trackArtist = cachedSearch.trackArtist;
    } else {
      const crossSearch = await getSearchIndexAnywhere({ storefront, song, artist, albumName, duration });
      if (crossSearch) {
        resolvedAlbumId = crossSearch.albumId;
        trackName = crossSearch.trackName;
        trackArtist = crossSearch.trackArtist;
      } else if (!tokenResult) {
        throw new TransientUpstreamError('Failed to authenticate with Apple Music');
      } else {
        try {
          const searchResult = await searchWithRetry(song, artist, tokenResult, storefront, albumName, duration, tier);
          if (!searchResult) {
            await upsertSearchIndex(
              { storefront, song, artist, albumName, duration },
              { albumId: null, trackName: null, trackArtist: null }
            );
            return { error: 'No matching tracks found' };
          }
          resolvedAlbumId = searchResult.albumId;
          trackName = searchResult.track.attributes.name;
          trackArtist = searchResult.track.attributes.artistName;
          await upsertSearchIndex(
            { storefront, song, artist, albumName, duration },
            { albumId: resolvedAlbumId, trackName, trackArtist }
          );
        } catch (error) {
          if (error instanceof UpstreamRateLimitedError) {
            const stale = await getSearchIndexAnywhere({ storefront, song, artist, albumName, duration }, { includeExpired: true });
            if (!stale) throw error;
            resolvedAlbumId = stale.albumId;
            trackName = stale.trackName;
            trackArtist = stale.trackArtist;
          } else {
            log.error(Tag.SEARCH, 'search failed', error);
            throw new TransientUpstreamError('Search failed');
          }
        }
      }
    }
  } else {
    return USAGE;
  }

  const cachedAlbum = await getAlbumCache(storefront, resolvedAlbumId);
  if (cachedAlbum) {
    if (cachedAlbum.notFound) {
      return { error: 'Album not found' };
    }
    return albumRowToResponse(cachedAlbum, trackName, trackArtist);
  }

  const crossAlbum = await getAlbumByIdAnywhere(resolvedAlbumId);
  if (crossAlbum) {
    return albumRowToResponse(crossAlbum, trackName, trackArtist);
  }

  if (!tokenResult) {
    throw new TransientUpstreamError('Failed to authenticate with Apple Music');
  }

  try {
    const albumData = await fetchAlbumWithRetry(resolvedAlbumId, tokenResult, storefront, tier);
    if (!albumData) {
      await upsertAlbumCache({
        storefront,
        albumId: resolvedAlbumId,
        name: null,
        artist: null,
        staticUrl: null,
        animatedUrl: null,
        animatedVerticalUrl: null,
        videoUrl: null,
        videoVerticalUrl: null,
        hasAnimated: false,
        notFound: true,
        recheckCount: 0,
      });
      return { error: 'Album not found' };
    }

    const [videoUrl, videoVerticalUrl] = await Promise.all([
      albumData.animatedUrl ? resolveVideoUrl(albumData.animatedUrl) : Promise.resolve(null),
      albumData.animatedVerticalUrl ? resolveVideoUrl(albumData.animatedVerticalUrl) : Promise.resolve(null),
    ]);

    await upsertAlbumCache({
      storefront,
      albumId: albumData.albumId,
      name: albumData.name,
      artist: albumData.artist,
      staticUrl: albumData.staticUrl,
      animatedUrl: albumData.animatedUrl,
      animatedVerticalUrl: albumData.animatedVerticalUrl,
      videoUrl,
      videoVerticalUrl,
      hasAnimated: albumData.animatedUrl !== null || albumData.animatedVerticalUrl !== null,
      notFound: false,
      recheckCount: 0,
    });

    return {
      name: trackName || albumData.name,
      artist: trackArtist || albumData.artist,
      albumId: albumData.albumId,
      static: albumData.staticUrl,
      animated: albumData.animatedUrl,
      animatedVertical: albumData.animatedVerticalUrl,
      videoUrl,
      videoUrlVertical: videoVerticalUrl,
    };
  } catch (error) {
    if (error instanceof UpstreamRateLimitedError) {
      const stale = await getAlbumByIdAnywhere(resolvedAlbumId, { includeExpired: true });
      if (stale) return albumRowToResponse(stale, trackName, trackArtist);
      throw error;
    }
    log.error(Tag.ALBUM, 'fetch failed', error);
    throw new TransientUpstreamError('Failed to fetch album data');
  }
}

async function searchWithRetry(
  song: string,
  artist: string,
  tokenResult: TokenResult,
  storefront: string,
  albumName: string | undefined,
  duration: number | undefined,
  tier: Tier
) {
  try {
    return await searchWithToken(song, artist, tokenResult, storefront, albumName, duration, tier);
  } catch (error) {
    if (!(error instanceof UpstreamRateLimitedError) || tokenResult.source !== 'mint') throw error;
    log.info(Tag.SEARCH, 'mint token rate limited, trying web token');
    try {
      return await searchWebLane(song, artist, albumName, duration, tier);
    } catch (webError) {
      log.warn(Tag.SEARCH, 'web token search failed', webError);
      throw error;
    }
  }
}

async function searchWithToken(
  song: string,
  artist: string,
  tokenResult: TokenResult,
  storefront: string,
  albumName: string | undefined,
  duration: number | undefined,
  tier: Tier
) {
  const mut = tokenResult.source === 'scrape' ? MEDIA_USER_TOKEN : undefined;
  const storefrontId = storefrontHeaderId(tokenResult, storefront);
  try {
    return await searchTrack(song, artist, tokenResult.token, storefront, albumName, duration, mut, tokenResult.source, tier, storefrontId);
  } catch (error) {
    if (error instanceof Error && error.message === 'TOKEN_EXPIRED') {
      log.warn(Tag.SEARCH, 'TOKEN_EXPIRED, retrying with fresh token');
      await invalidateToken();
      const fresh = await getToken();
      const freshMut = fresh.source === 'scrape' ? MEDIA_USER_TOKEN : undefined;
      return await searchTrack(song, artist, fresh.token, storefront, albumName, duration, freshMut, fresh.source, tier, storefrontHeaderId(fresh, storefront));
    }
    throw error;
  }
}

async function fetchAlbumWithRetry(
  albumId: string,
  tokenResult: TokenResult,
  storefront: string,
  tier: Tier
) {
  const mut = tokenResult.source === 'scrape' ? MEDIA_USER_TOKEN : undefined;
  const storefrontId = storefrontHeaderId(tokenResult, storefront);
  try {
    return await fetchAlbum(albumId, tokenResult.token, storefront, mut, tokenResult.source, tier, storefrontId);
  } catch (error) {
    if (error instanceof Error && error.message === 'TOKEN_EXPIRED') {
      log.warn(Tag.ALBUM, 'TOKEN_EXPIRED, retrying with fresh token');
      await invalidateToken();
      const fresh = await getToken();
      const freshMut = fresh.source === 'scrape' ? MEDIA_USER_TOKEN : undefined;
      return await fetchAlbum(albumId, fresh.token, storefront, freshMut, fresh.source, tier, storefrontHeaderId(fresh, storefront));
    }
    throw error;
  }
}

const port = parseInt(process.env.PORT || '3000', 10);

log.info(Tag.SERVER, 'starting', { port });

serve({
  fetch: app.fetch,
  port,
});

log.info(Tag.SERVER, 'listening', { url: `http://localhost:${port}` });
