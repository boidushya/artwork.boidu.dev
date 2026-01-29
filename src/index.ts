import type { Env, ArtworkResponse, ErrorResponse } from './types';
import { getToken, invalidateToken } from './token';
import { searchTrack } from './search';
import { fetchAlbum, parseAlbumIdFromUrl } from './album';
import { resolveVideoUrl } from './m3u8';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return corsResponse(new Response(null, { status: 204 }));
    }

    // Only allow GET requests
    if (request.method !== 'GET') {
      return corsResponse(jsonResponse({ error: 'Method not allowed' }, 405));
    }

    const url = new URL(request.url);

    // Health check endpoint
    if (url.pathname === '/health') {
      return corsResponse(jsonResponse({ status: 'ok' }));
    }

    // Main artwork endpoint
    if (url.pathname === '/' || url.pathname === '/artwork') {
      try {
        const result = await handleArtworkRequest(url, env);
        return corsResponse(jsonResponse(result));
      } catch (error) {
        console.error('Error handling request:', error);
        const message = error instanceof Error ? error.message : 'Unknown error';
        return corsResponse(jsonResponse({ error: message }, 500));
      }
    }

    return corsResponse(jsonResponse({ error: 'Not found' }, 404));
  },
};

async function handleArtworkRequest(
  url: URL,
  env: Env
): Promise<ArtworkResponse | ErrorResponse> {
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
    token = await getToken(env);
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
      const searchResult = await searchWithRetry(song, artist, token, storefront, env, albumName, duration);
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
    const albumData = await fetchAlbumWithRetry(resolvedAlbumId, token, storefront, env);
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
  env: Env,
  albumName?: string,
  duration?: number
) {
  try {
    return await searchTrack(song, artist, token, storefront, albumName, duration);
  } catch (error) {
    if (error instanceof Error && error.message === 'TOKEN_EXPIRED') {
      // Invalidate token and retry once
      await invalidateToken(env);
      const newToken = await getToken(env);
      return await searchTrack(song, artist, newToken, storefront, albumName, duration);
    }
    throw error;
  }
}

async function fetchAlbumWithRetry(
  albumId: string,
  token: string,
  storefront: string,
  env: Env
) {
  try {
    return await fetchAlbum(albumId, token, storefront);
  } catch (error) {
    if (error instanceof Error && error.message === 'TOKEN_EXPIRED') {
      // Invalidate token and retry once
      await invalidateToken(env);
      const newToken = await getToken(env);
      return await fetchAlbum(albumId, newToken, storefront);
    }
    throw error;
  }
}

function jsonResponse(data: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

function corsResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type');
  headers.set('Access-Control-Max-Age', '86400');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
