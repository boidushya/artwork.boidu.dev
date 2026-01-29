import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import type { ArtworkResponse, ErrorResponse } from './types';
import { getToken, invalidateToken } from './token';
import { searchTrack } from './search';
import { fetchAlbum, parseAlbumIdFromUrl } from './album';
import { resolveVideoUrl } from './m3u8';

const app = new Hono();

// Enable CORS
app.use('*', cors());

// Health check
app.get('/health', (c) => c.json({ status: 'ok' }));

// Main artwork endpoint
app.get('/', handleArtwork);
app.get('/artwork', handleArtwork);

async function handleArtwork(c: any): Promise<Response> {
  try {
    const result = await handleArtworkRequest(c.req.url);
    return c.json(result);
  } catch (error) {
    console.error('Error handling request:', error);
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
  const albumId = url.searchParams.get('id');
  const appleUrl = url.searchParams.get('url');
  const storefront = url.searchParams.get('storefront') || 'us';
  const albumName = url.searchParams.get('albumName') || undefined;
  const durationParam = url.searchParams.get('duration');
  const duration = durationParam ? parseInt(durationParam, 10) : undefined;

  let resolvedAlbumId: string | null = null;
  let trackName: string | null = null;
  let trackArtist: string | null = null;

  // Get token (with automatic caching)
  let token: string;
  try {
    token = await getToken();
  } catch (error) {
    console.error('Failed to get token:', error);
    return { error: 'Failed to authenticate with Apple Music' };
  }

  // Route 1: Direct album ID
  if (albumId) {
    resolvedAlbumId = albumId;
  }
  // Route 2: Apple Music URL
  else if (appleUrl) {
    resolvedAlbumId = parseAlbumIdFromUrl(appleUrl);
    if (!resolvedAlbumId) {
      return { error: 'Invalid Apple Music URL' };
    }
  }
  // Route 3: Search by song + artist
  else if (song && artist) {
    try {
      const searchResult = await searchWithRetry(song, artist, token, storefront, albumName, duration);
      if (!searchResult) {
        return { error: 'No matching tracks found' };
      }
      resolvedAlbumId = searchResult.albumId;
      trackName = searchResult.track.attributes.name;
      trackArtist = searchResult.track.attributes.artistName;
    } catch (error) {
      console.error('Search failed:', error);
      return { error: 'Search failed' };
    }
  }
  // No valid parameters
  else {
    return {
      error: 'Missing parameters. Use: ?s=song&a=artist, ?id=albumId, or ?url=appleMusicUrl',
    };
  }

  // Fetch album data
  try {
    const albumData = await fetchAlbumWithRetry(resolvedAlbumId, token, storefront);
    if (!albumData) {
      return { error: 'Album not found' };
    }

    // Resolve video URL if animated artwork exists
    let videoUrl: string | null = null;
    if (albumData.animatedUrl) {
      videoUrl = await resolveVideoUrl(albumData.animatedUrl);
    }

    return {
      name: trackName || albumData.name,
      artist: trackArtist || albumData.artist,
      albumId: albumData.albumId,
      static: albumData.staticUrl,
      animated: albumData.animatedUrl,
      videoUrl,
    };
  } catch (error) {
    console.error('Album fetch failed:', error);
    return { error: 'Failed to fetch album data' };
  }
}

async function searchWithRetry(
  song: string,
  artist: string,
  token: string,
  storefront: string,
  albumName?: string,
  duration?: number
) {
  try {
    return await searchTrack(song, artist, token, storefront, albumName, duration);
  } catch (error) {
    if (error instanceof Error && error.message === 'TOKEN_EXPIRED') {
      // Invalidate token and retry once
      invalidateToken();
      const newToken = await getToken();
      return await searchTrack(song, artist, newToken, storefront, albumName, duration);
    }
    throw error;
  }
}

async function fetchAlbumWithRetry(
  albumId: string,
  token: string,
  storefront: string
) {
  try {
    return await fetchAlbum(albumId, token, storefront);
  } catch (error) {
    if (error instanceof Error && error.message === 'TOKEN_EXPIRED') {
      // Invalidate token and retry once
      invalidateToken();
      const newToken = await getToken();
      return await fetchAlbum(albumId, newToken, storefront);
    }
    throw error;
  }
}

const port = parseInt(process.env.PORT || '3000', 10);

console.log(`Server starting on port ${port}...`);

serve({
  fetch: app.fetch,
  port,
});

console.log(`Server running at http://localhost:${port}`);
