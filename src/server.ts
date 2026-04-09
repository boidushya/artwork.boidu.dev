import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import type { ArtworkResponse, ErrorResponse } from './types';
import { getToken, invalidateToken } from './token';
import { searchTrack } from './search';
import { fetchAlbum, parseAlbumIdFromUrl } from './album';
import { resolveVideoUrl } from './m3u8';
import { runMigrations } from './db';
import {
  getSearchIndex,
  upsertSearchIndex,
  getAlbumCache,
  upsertAlbumCache,
} from './resultCache';
import { artworkRateLimit } from './rateLimit';
import { UpstreamRateLimitedError } from './outboundLimiter';
import { log, Tag } from './logger';

const MEDIA_USER_TOKEN = process.env.MEDIA_USER_TOKEN;
log.info(
  Tag.MUT,
  MEDIA_USER_TOKEN ? 'env loaded' : 'env NOT set — requests will be anonymous',
  MEDIA_USER_TOKEN ? { chars: MEDIA_USER_TOKEN.length } : undefined
);

try {
  await runMigrations();
} catch (err) {
  log.error(Tag.DB, 'startup migration failed — continuing without cache', err);
}

const app = new Hono();

app.use('*', cors());

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

app.get('/', handleArtwork);
app.get('/artwork', handleArtwork);

async function handleArtwork(c: any): Promise<Response> {
  try {
    const result = await handleArtworkRequest(c.req.url);
    return c.json(result);
  } catch (error) {
    if (error instanceof UpstreamRateLimitedError) {
      log.warn(Tag.HTTP, 'upstream rate limited → 503', { endpoint: error.endpoint });
      return c.json({ error: 'Upstream rate limited, try again shortly' }, 503);
    }
    log.error(Tag.HTTP, 'unhandled request error', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
}

async function handleArtworkRequest(
  requestUrl: string
): Promise<ArtworkResponse | ErrorResponse> {
  const url = new URL(requestUrl);
  const song = url.searchParams.get('s') || url.searchParams.get('song');
  const artist = url.searchParams.get('a') || url.searchParams.get('artist');
  const albumIdParam = url.searchParams.get('id');
  const appleUrl = url.searchParams.get('url');
  const storefront = url.searchParams.get('storefront') || 'vn';
  const albumName =
    url.searchParams.get('al') || url.searchParams.get('albumName') || undefined;
  const durationParam = url.searchParams.get('d') || url.searchParams.get('duration');
  const duration = durationParam ? parseInt(durationParam, 10) : undefined;

  let resolvedAlbumId: string | null = null;
  let trackName: string | null = null;
  let trackArtist: string | null = null;

  if (albumIdParam) {
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
      let token: string;
      try {
        token = await getToken();
      } catch (error) {
        log.error(Tag.TOKEN, 'failed to get token', error);
        return { error: 'Failed to authenticate with Apple Music' };
      }
      try {
        const searchResult = await searchWithRetry(song, artist, token, storefront, albumName, duration, MEDIA_USER_TOKEN);
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
        if (error instanceof UpstreamRateLimitedError) throw error;
        log.error(Tag.SEARCH, 'search failed', error);
        return { error: 'Search failed' };
      }
    }
  } else {
    return {
      error: 'Missing parameters. Use: ?s=song&a=artist, ?id=albumId, or ?url=appleMusicUrl',
    };
  }

  const cachedAlbum = await getAlbumCache(storefront, resolvedAlbumId);
  if (cachedAlbum) {
    if (cachedAlbum.notFound) {
      return { error: 'Album not found' };
    }
    return {
      name: trackName || cachedAlbum.name || '',
      artist: trackArtist || cachedAlbum.artist || '',
      albumId: cachedAlbum.albumId,
      static: cachedAlbum.staticUrl || '',
      animated: cachedAlbum.animatedUrl,
      videoUrl: cachedAlbum.videoUrl,
    };
  }

  let token: string;
  try {
    token = await getToken();
  } catch (error) {
    log.error(Tag.TOKEN, 'failed to get token', error);
    return { error: 'Failed to authenticate with Apple Music' };
  }

  try {
    const albumData = await fetchAlbumWithRetry(resolvedAlbumId, token, storefront, MEDIA_USER_TOKEN);
    if (!albumData) {
      await upsertAlbumCache({
        storefront,
        albumId: resolvedAlbumId,
        name: null,
        artist: null,
        staticUrl: null,
        animatedUrl: null,
        videoUrl: null,
        hasAnimated: false,
        notFound: true,
        recheckCount: 0,
      });
      return { error: 'Album not found' };
    }

    let videoUrl: string | null = null;
    if (albumData.animatedUrl) {
      videoUrl = await resolveVideoUrl(albumData.animatedUrl);
    }

    await upsertAlbumCache({
      storefront,
      albumId: albumData.albumId,
      name: albumData.name,
      artist: albumData.artist,
      staticUrl: albumData.staticUrl,
      animatedUrl: albumData.animatedUrl,
      videoUrl,
      hasAnimated: albumData.animatedUrl !== null,
      notFound: false,
      recheckCount: 0,
    });

    return {
      name: trackName || albumData.name,
      artist: trackArtist || albumData.artist,
      albumId: albumData.albumId,
      static: albumData.staticUrl,
      animated: albumData.animatedUrl,
      videoUrl,
    };
  } catch (error) {
    if (error instanceof UpstreamRateLimitedError) throw error;
    log.error(Tag.ALBUM, 'fetch failed', error);
    return { error: 'Failed to fetch album data' };
  }
}

async function searchWithRetry(
  song: string,
  artist: string,
  token: string,
  storefront: string,
  albumName?: string,
  duration?: number,
  mut?: string
) {
  try {
    return await searchTrack(song, artist, token, storefront, albumName, duration, mut);
  } catch (error) {
    if (error instanceof Error && error.message === 'TOKEN_EXPIRED') {
      log.warn(Tag.SEARCH, 'TOKEN_EXPIRED, retrying with fresh token');
      invalidateToken();
      const newToken = await getToken();
      return await searchTrack(song, artist, newToken, storefront, albumName, duration, mut);
    }
    throw error;
  }
}

async function fetchAlbumWithRetry(
  albumId: string,
  token: string,
  storefront: string,
  mut?: string
) {
  try {
    return await fetchAlbum(albumId, token, storefront, mut);
  } catch (error) {
    if (error instanceof Error && error.message === 'TOKEN_EXPIRED') {
      log.warn(Tag.ALBUM, 'TOKEN_EXPIRED, retrying with fresh token');
      invalidateToken();
      const newToken = await getToken();
      return await fetchAlbum(albumId, newToken, storefront, mut);
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
