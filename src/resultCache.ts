import { query } from './db';
import { normalize } from './search';
import { log, Tag } from './logger';

const DAY = 86400;
const SEARCH_POSITIVE_TTL = 30 * DAY;
const SEARCH_NEGATIVE_TTL = 7 * DAY;
const ALBUM_ANIMATED_TTL = 365 * DAY;
const ALBUM_NO_ANIMATED_TTL = 7 * DAY;
const ALBUM_NOT_FOUND_TTL = 7 * DAY;
const ALBUM_VIDEO_RESOLUTION_FAILED_TTL = 1 * DAY;

export interface AlbumCacheRow {
  storefront: string;
  albumId: string;
  name: string | null;
  artist: string | null;
  staticUrl: string | null;
  animatedUrl: string | null;
  videoUrl: string | null;
  hasAnimated: boolean;
  notFound: boolean;
}

export interface SearchIndexHit {
  albumId: string | null;
  trackName: string | null;
  trackArtist: string | null;
}

export interface SearchKey {
  storefront: string;
  song: string;
  artist: string;
  albumName?: string;
  duration?: number;
}

export const TTL = {
  SEARCH_POSITIVE: SEARCH_POSITIVE_TTL,
  SEARCH_NEGATIVE: SEARCH_NEGATIVE_TTL,
  ALBUM_ANIMATED: ALBUM_ANIMATED_TTL,
  ALBUM_NO_ANIMATED: ALBUM_NO_ANIMATED_TTL,
  ALBUM_NOT_FOUND: ALBUM_NOT_FOUND_TTL,
  ALBUM_VIDEO_RESOLUTION_FAILED: ALBUM_VIDEO_RESOLUTION_FAILED_TTL,
} as const;

export function buildSearchKey(k: SearchKey): [string, string, string, string, number] {
  return [
    k.storefront,
    normalize(k.song),
    normalize(k.artist),
    k.albumName ? normalize(k.albumName) : '',
    k.duration ?? -1,
  ];
}

export async function getSearchIndex(k: SearchKey): Promise<SearchIndexHit | null> {
  const key = buildSearchKey(k);
  const result = await query<{
    album_id: string | null;
    track_name: string | null;
    track_artist: string | null;
  }>(
    `SELECT album_id, track_name, track_artist
     FROM search_index
     WHERE storefront = $1 AND song = $2 AND artist = $3 AND album = $4 AND duration = $5
       AND expires_at > now()`,
    key
  );
  if (!result || result.rows.length === 0) {
    log.info(Tag.CACHE_MISS, 'search_index', {
      storefront: key[0], song: key[1], artist: key[2], album: key[3], duration: key[4],
    });
    return null;
  }
  const row = result.rows[0];
  const hit: SearchIndexHit = {
    albumId: row.album_id,
    trackName: row.track_name,
    trackArtist: row.track_artist,
  };
  log.info(Tag.CACHE_HIT, 'search_index', {
    key: `${key[1]}|${key[2]}|${key[3]}|${key[4]}`,
    albumId: hit.albumId ?? 'NEGATIVE',
  });
  return hit;
}

export async function upsertSearchIndex(
  k: SearchKey,
  hit: SearchIndexHit
): Promise<void> {
  const ttl = hit.albumId ? SEARCH_POSITIVE_TTL : SEARCH_NEGATIVE_TTL;
  const [storefront, song, artist, album, duration] = buildSearchKey(k);
  await query(
    `INSERT INTO search_index
       (storefront, song, artist, album, duration, album_id, track_name, track_artist, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + ($9 || ' seconds')::interval)
     ON CONFLICT (storefront, song, artist, album, duration) DO UPDATE SET
       album_id     = EXCLUDED.album_id,
       track_name   = EXCLUDED.track_name,
       track_artist = EXCLUDED.track_artist,
       expires_at   = EXCLUDED.expires_at`,
    [storefront, song, artist, album, duration, hit.albumId, hit.trackName, hit.trackArtist, ttl]
  );
  log.info(Tag.CACHE_UPSERT, 'search_index', {
    key: `${song}|${artist}|${album}|${duration}`,
    albumId: hit.albumId ?? 'NEGATIVE',
    ttlDays: Math.round(ttl / DAY),
  });
}

export async function getAlbumCache(
  storefront: string,
  albumId: string
): Promise<AlbumCacheRow | null> {
  const result = await query<{
    name: string | null;
    artist: string | null;
    static_url: string | null;
    animated_url: string | null;
    video_url: string | null;
    has_animated: boolean;
    not_found: boolean;
  }>(
    `SELECT name, artist, static_url, animated_url, video_url, has_animated, not_found
     FROM album_cache
     WHERE storefront = $1 AND album_id = $2 AND expires_at > now()`,
    [storefront, albumId]
  );
  if (!result || result.rows.length === 0) {
    log.info(Tag.CACHE_MISS, 'album_cache', { storefront, albumId });
    return null;
  }
  const row = result.rows[0];
  const mapped: AlbumCacheRow = {
    storefront,
    albumId,
    name: row.name,
    artist: row.artist,
    staticUrl: row.static_url,
    animatedUrl: row.animated_url,
    videoUrl: row.video_url,
    hasAnimated: row.has_animated,
    notFound: row.not_found,
  };
  log.info(Tag.CACHE_HIT, 'album_cache', {
    storefront,
    albumId,
    status: mapped.notFound ? 'NOT_FOUND' : mapped.hasAnimated ? (mapped.videoUrl ? 'ANIMATED' : 'ANIMATED_NO_VIDEO') : 'NO_ANIMATED',
  });
  return mapped;
}

export function computeAlbumTtl(row: Pick<AlbumCacheRow, 'notFound' | 'hasAnimated' | 'videoUrl'>): number {
  if (row.notFound) return ALBUM_NOT_FOUND_TTL;
  if (!row.hasAnimated) return ALBUM_NO_ANIMATED_TTL;
  if (!row.videoUrl) return ALBUM_VIDEO_RESOLUTION_FAILED_TTL;
  return ALBUM_ANIMATED_TTL;
}

export async function upsertAlbumCache(row: AlbumCacheRow): Promise<void> {
  const ttl = computeAlbumTtl(row);
  const status = row.notFound
    ? 'NOT_FOUND'
    : row.hasAnimated
      ? row.videoUrl ? 'ANIMATED' : 'ANIMATED_NO_VIDEO'
      : 'NO_ANIMATED';
  log.info(Tag.CACHE_UPSERT, 'album_cache', {
    storefront: row.storefront,
    albumId: row.albumId,
    status,
    ttlDays: Math.round(ttl / DAY),
  });
  await query(
    `INSERT INTO album_cache
       (storefront, album_id, name, artist, static_url, animated_url, video_url, has_animated, not_found, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() + ($10 || ' seconds')::interval)
     ON CONFLICT (storefront, album_id) DO UPDATE SET
       name         = EXCLUDED.name,
       artist       = EXCLUDED.artist,
       static_url   = EXCLUDED.static_url,
       animated_url = EXCLUDED.animated_url,
       video_url    = EXCLUDED.video_url,
       has_animated = EXCLUDED.has_animated,
       not_found    = EXCLUDED.not_found,
       expires_at   = EXCLUDED.expires_at`,
    [
      row.storefront,
      row.albumId,
      row.name,
      row.artist,
      row.staticUrl,
      row.animatedUrl,
      row.videoUrl,
      row.hasAnimated,
      row.notFound,
      ttl,
    ]
  );
}
