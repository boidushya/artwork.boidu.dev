import type { AppleMusicAlbumResponse, AppleMusicAlbum } from './types';
import { log, Tag } from './logger';

const API_BASE = 'https://amp-api.music.apple.com/v1';

export interface AlbumData {
  name: string;
  artist: string;
  albumId: string;
  staticUrl: string;
  animatedUrl: string | null;
}

export async function fetchAlbum(
  albumId: string,
  token: string,
  storefront: string = 'vn',
  mut?: string
): Promise<AlbumData | null> {
  const url = `${API_BASE}/catalog/${storefront}/albums/${albumId}?extend=editorialVideo`;

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${token}`,
    'Origin': 'https://music.apple.com',
    'Referer': 'https://music.apple.com/',
  };
  if (mut) {
    headers['media-user-token'] = mut;
  }

  log.info(Tag.ALBUM, '→ apple', { storefront, albumId, mut: !!mut });
  const start = Date.now();
  const response = await fetch(url, { headers });
  const ms = Date.now() - start;

  if (!response.ok) {
    if (response.status === 401) {
      log.warn(Tag.ALBUM, '← 401 TOKEN_EXPIRED', { ms });
      throw new Error('TOKEN_EXPIRED');
    }
    if (response.status === 404) {
      log.info(Tag.ALBUM, '← 404 not found', { albumId, ms });
      return null;
    }
    log.error(Tag.ALBUM, '← error', { status: response.status, ms });
    throw new Error(`Album fetch failed: ${response.status}`);
  }

  const data: AppleMusicAlbumResponse = await response.json();
  const album = data.data?.[0];

  if (!album) {
    log.warn(Tag.ALBUM, '← ok but empty data array', { ms });
    return null;
  }

  const extracted = extractAlbumData(album);
  log.info(Tag.ALBUM, '← ok', {
    status: response.status,
    ms,
    name: extracted.name,
    artist: extracted.artist,
    hasAnimated: extracted.animatedUrl !== null,
  });
  return extracted;
}

function extractAlbumData(album: AppleMusicAlbum): AlbumData {
  const attrs = album.attributes;

  // Build static artwork URL (replace {w}x{h} with 1200x1200)
  let staticUrl = attrs.artwork.url;
  staticUrl = staticUrl.replace('{w}', '1200').replace('{h}', '1200');

  // Extract animated video URL if available
  let animatedUrl: string | null = null;
  const editorialVideo = attrs.editorialVideo;

  if (editorialVideo) {
    // Prefer motionDetailSquare, fallback to motionSquareVideo1x1
    animatedUrl = editorialVideo.motionDetailSquare?.video
      || editorialVideo.motionSquareVideo1x1?.video
      || null;
  }

  return {
    name: attrs.name,
    artist: attrs.artistName,
    albumId: album.id,
    staticUrl,
    animatedUrl,
  };
}

export function parseAlbumIdFromUrl(url: string): string | null {
  // Handle various Apple Music URL formats:
  // https://music.apple.com/us/album/album-name/1234567890
  // https://music.apple.com/us/album/1234567890
  // https://music.apple.com/album/album-name/1234567890?i=trackId

  const match = url.match(/\/album\/(?:[^/]+\/)?(\d+)/);
  return match ? match[1] : null;
}
