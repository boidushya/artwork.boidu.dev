import type { AppleMusicSearchResponse, AppleMusicTrack, SearchResult } from './types';
import { getWebToken, invalidateWebToken, type TokenSource } from './token';
import type { Tier } from './priority';
import { log, Tag } from './logger';
import { fetchAppleWithRetry, isCircuitOpen, UpstreamRateLimitedError, type AppleEndpoint } from './outboundLimiter';

// Apple rate-limits search per (token, host), so edge and amp are separate budgets.
const SEARCH_HOSTS: { name: string; base: string; endpoint: Record<TokenSource, AppleEndpoint> }[] = [
  { name: 'edge', base: 'https://amp-api-edge.music.apple.com/v1', endpoint: { mint: 'searchEdge', scrape: 'searchWebEdge' } },
  { name: 'amp', base: 'https://amp-api.music.apple.com/v1', endpoint: { mint: 'search', scrape: 'searchWeb' } },
];
const WEB_STOREFRONT = 'us';
const MIN_SCORE_THRESHOLD = 0.6;
const DURATION_MATCH_DELTA_MS = 2000;

export async function searchTrack(
  song: string,
  artist: string,
  token: string,
  storefront: string = 'vn',
  albumName?: string,
  duration?: number,
  mut?: string,
  source: TokenSource = 'scrape',
  tier: Tier = 'priority',
  storefrontId?: string
): Promise<SearchResult | null> {
  const query = `${song} ${artist}`.trim();
  const path = `/catalog/${storefront}/search?term=${encodeURIComponent(query)}&types=songs&limit=10&with=serverBubbles`;

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${token}`,
    'Origin': 'https://music.apple.com',
    'Referer': 'https://music.apple.com/',
  };
  if (mut) {
    headers['media-user-token'] = mut;
  }
  if (storefrontId) {
    headers['X-Apple-Store-Front'] = storefrontId;
  }

  const hosts = SEARCH_HOSTS.filter((h, i) => i === SEARCH_HOSTS.length - 1 || !isCircuitOpen(h.endpoint[source]));
  let response: Response | undefined;
  let host = '';
  let ms = 0;
  for (const [i, h] of hosts.entries()) {
    host = h.name;
    log.info(Tag.SEARCH, '→ apple', { host, storefront, query, mut: !!mut, albumName, duration, token: source });
    const start = Date.now();
    response = await fetchAppleWithRetry(`${h.base}${path}`, { headers }, h.endpoint[source], Tag.SEARCH, source, tier);
    ms = Date.now() - start;
    if (response.status !== 429) break;
    log.error(Tag.SEARCH, '← 429 rate limited after retries', { host, ms, token: source });
    if (i === hosts.length - 1) throw new UpstreamRateLimitedError(h.endpoint[source]);
  }
  if (!response) throw new UpstreamRateLimitedError(SEARCH_HOSTS[SEARCH_HOSTS.length - 1].endpoint[source]);

  if (!response.ok) {
    if (response.status === 401) {
      log.warn(Tag.SEARCH, '← 401 TOKEN_EXPIRED', { host, ms });
      throw new Error('TOKEN_EXPIRED');
    }
    log.error(Tag.SEARCH, '← error', { host, status: response.status, ms });
    throw new Error(`Search failed: ${response.status}`);
  }

  const data: AppleMusicSearchResponse = await response.json();
  const rawTracks = data.results?.song?.data ?? data.results?.songs?.data ?? [];
  log.info(Tag.SEARCH, '← ok', { host, status: response.status, ms, tracks: rawTracks.length, token: source });

  if (rawTracks.length === 0) {
    log.info(Tag.SEARCH, 'no results from apple');
    return null;
  }

  let tracks = rawTracks;
  if (duration !== undefined) {
    const durationMs = duration * 1000;
    const filtered = tracks.filter(
      (track) => Math.abs(track.attributes.durationInMillis - durationMs) <= DURATION_MATCH_DELTA_MS
    );
    if (filtered.length > 0) {
      log.debug(Tag.SEARCH, 'duration filter', { kept: filtered.length, of: tracks.length });
      tracks = filtered;
    } else {
      log.debug(Tag.SEARCH, 'duration filter bypassed (no matches within delta)');
    }
  }

  const scored = tracks
    .map((track) => scoreTrack(track, song, artist, albumName))
    .filter((result): result is SearchResult => result !== null)
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best || best.score < MIN_SCORE_THRESHOLD) {
    log.info(Tag.SEARCH, 'below score threshold', {
      bestScore: best?.score.toFixed(3) ?? 'none',
      threshold: MIN_SCORE_THRESHOLD,
    });
    return null;
  }

  log.info(Tag.SEARCH, 'best match', {
    albumId: best.albumId,
    name: best.track.attributes.name,
    artist: best.track.attributes.artistName,
    score: best.score.toFixed(3),
  });
  return best;
}

export async function searchWebLane(
  song: string,
  artist: string,
  albumName: string | undefined,
  duration: number | undefined,
  tier: Tier
): Promise<SearchResult | null> {
  const token = await getWebToken();
  try {
    return await searchTrack(song, artist, token, WEB_STOREFRONT, albumName, duration, undefined, 'scrape', tier);
  } catch (error) {
    if (error instanceof Error && error.message === 'TOKEN_EXPIRED') invalidateWebToken();
    throw error;
  }
}

function scoreTrack(
  track: AppleMusicTrack,
  querySong: string,
  queryArtist: string,
  queryAlbum?: string
): SearchResult | null {
  // Extract album ID from relationships or URL
  let albumId = track.relationships?.albums?.data?.[0]?.id;

  if (!albumId) {
    const urlMatch = track.attributes.url.match(/\/album\/[^/]+\/(\d+)/);
    if (urlMatch) {
      albumId = urlMatch[1];
    }
  }

  if (!albumId) {
    return null;
  }

  const trackName = normalize(track.attributes.name);
  const trackArtist = normalize(track.attributes.artistName);
  const trackAlbum = normalize(track.attributes.albumName);
  const searchSong = normalize(querySong);
  const searchArtist = normalize(queryArtist);

  const songSim = stringSimilarity(trackName, searchSong);
  const artistSim = stringSimilarity(trackArtist, searchArtist);

  let score: number;
  if (queryAlbum) {
    const searchAlbum = normalize(queryAlbum);
    const albumSim = stringSimilarity(trackAlbum, searchAlbum);
    score = songSim * 0.5 + artistSim * 0.375 + albumSim * 0.125;
  } else {
    // Redistribute album weight proportionally: song 50/(50+37.5) ≈ 57.1%, artist 37.5/(50+37.5) ≈ 42.9%
    score = songSim * (50 / 87.5) + artistSim * (37.5 / 87.5);
  }

  // Variant penalties (scaled to 0 to 1 range)
  const lowerTrackName = trackName.toLowerCase();
  if (!searchSong.includes('remix') && lowerTrackName.includes('remix')) {
    score -= 0.15;
  }
  if (!searchSong.includes('live') && (lowerTrackName.includes('live') || lowerTrackName.includes('(live'))) {
    score -= 0.10;
  }
  if (!searchSong.includes('acoustic') && lowerTrackName.includes('acoustic')) {
    score -= 0.075;
  }

  return {
    track,
    albumId,
    score,
  };
}

export function stringSimilarity(s1: string, s2: string): number {
  if (s1 === s2) return 1.0;

  if (s1.includes(s2) || s2.includes(s1)) {
    const shorter = Math.min(s1.length, s2.length);
    const longer = Math.max(s1.length, s2.length);
    return 0.7 + 0.3 * (shorter / longer);
  }

  // Character overlap via frequency maps
  const freq1 = charFrequency(s1);
  const freq2 = charFrequency(s2);
  let overlap = 0;
  for (const [ch, count] of freq1) {
    overlap += Math.min(count, freq2.get(ch) || 0);
  }

  return (overlap * 2) / (s1.length + s2.length);
}

function charFrequency(str: string): Map<string, number> {
  const freq = new Map<string, number>();
  for (const ch of str) {
    freq.set(ch, (freq.get(ch) || 0) + 1);
  }
  return freq;
}

export function normalize(str: string): string {
  return str
    .normalize('NFKD')
    .toLowerCase()
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim();
}
