import type {
  AppleMusicSearchResponse,
  AppleMusicSuggestionsResponse,
  AppleMusicTrack,
  SearchResult,
} from './types';
import { log, Tag } from './logger';
import { fetchAppleWithRetry, UpstreamRateLimitedError } from './outboundLimiter';

const API_BASE = 'https://amp-api.music.apple.com/v1';
const SUGGESTIONS_API_BASE = 'https://amp-api-edge.music.apple.com/v1';
const MIN_SCORE_THRESHOLD = 0.6;
const DURATION_MATCH_DELTA_MS = 2000;

export async function searchTrack(
  song: string,
  artist: string,
  token: string,
  storefront: string = 'vn',
  albumName?: string,
  duration?: number,
  mut?: string
): Promise<SearchResult | null> {
  const query = `${song} ${artist}`.trim();
  const headers = makeAppleHeaders(token, mut);

  log.info(Tag.SEARCH, 'search start', { storefront, query, mut: !!mut, albumName, duration });

  const suggestionTracks = await fetchSuggestionTracks(query, storefront, headers);
  if (suggestionTracks.length > 0) {
    const suggestionBest = selectBestTrack(suggestionTracks, song, artist, albumName, duration);
    if (suggestionBest) {
      logBestMatch('suggestions best match', suggestionBest);
      return suggestionBest;
    }
    log.info(Tag.SEARCH, 'suggestions below score threshold; falling back to search');
  } else {
    log.info(Tag.SEARCH, 'no song results from suggestions; falling back to search');
  }

  const searchTracks = await fetchSearchTracks(query, storefront, headers);
  if (searchTracks.length === 0) {
    log.info(Tag.SEARCH, 'no results from apple search');
    return null;
  }

  const best = selectBestTrack(searchTracks, song, artist, albumName, duration);
  if (!best) {
    return null;
  }

  logBestMatch('search best match', best);
  return best;
}

function makeAppleHeaders(token: string, mut?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${token}`,
    'Origin': 'https://music.apple.com',
    'Referer': 'https://music.apple.com/',
  };
  if (mut) {
    headers['media-user-token'] = mut;
  }
  return headers;
}

async function fetchSuggestionTracks(
  query: string,
  storefront: string,
  headers: Record<string, string>
): Promise<AppleMusicTrack[]> {
  const url = buildSuggestionsUrl(query, storefront);
  log.info(Tag.SEARCH, '→ apple suggestions', { storefront, query });
  const start = Date.now();
  const response = await fetchAppleWithRetry(url, { headers }, 'search', Tag.SEARCH);
  const ms = Date.now() - start;

  if (!response.ok) {
    if (response.status === 401) {
      log.warn(Tag.SEARCH, '← suggestions 401 TOKEN_EXPIRED', { ms });
      throw new Error('TOKEN_EXPIRED');
    }
    if (response.status === 429) {
      log.error(Tag.SEARCH, '← suggestions 429 rate limited after retries', { ms });
      throw new UpstreamRateLimitedError('search');
    }
    log.warn(Tag.SEARCH, '← suggestions error; falling back to search', { status: response.status, ms });
    return [];
  }

  const data: AppleMusicSuggestionsResponse = await response.json();
  const tracks = extractSuggestionTracks(data);
  log.info(Tag.SEARCH, '← suggestions ok', { status: response.status, ms, tracks: tracks.length });
  return tracks;
}

function buildSuggestionsUrl(query: string, storefront: string): string {
  const params = new URLSearchParams({
    'art[url]': 'f',
    'fields[albums]': 'artistName,artwork,contentRating,name,playParams,url',
    'fields[artists]': 'url,name,artwork',
    'fields[songs]': 'albumName,artistName,artwork,contentRating,durationInMillis,name,playParams,url',
    'format[resources]': 'map',
    kinds: 'terms,topResults',
    l: 'en-US',
    'limit[results:terms]': '5',
    'limit[results:topResults]': '10',
    'omit[resource]': 'autos',
    platform: 'web',
    term: query,
    types:
      'activities,albums,artists,editorial-items,music-movies,music-videos,playlists,record-labels,songs,stations,tv-episodes',
    with: 'naturalLanguage',
  });
  return `${SUGGESTIONS_API_BASE}/catalog/${storefront}/search/suggestions?${params.toString()}`;
}

function extractSuggestionTracks(data: AppleMusicSuggestionsResponse): AppleMusicTrack[] {
  const songResources = data.resources?.songs ?? {};
  const seen = new Set<string>();
  const tracks: AppleMusicTrack[] = [];

  for (const suggestion of data.results?.suggestions ?? []) {
    if (suggestion.kind !== 'topResults' || suggestion.content?.type !== 'songs') continue;
    const id = suggestion.content.id;
    const track = songResources[id];
    if (!track || seen.has(id)) continue;
    tracks.push(track);
    seen.add(id);
  }

  return tracks;
}

async function fetchSearchTracks(
  query: string,
  storefront: string,
  headers: Record<string, string>
): Promise<AppleMusicTrack[]> {
  const searchUrl = `${API_BASE}/catalog/${storefront}/search?term=${encodeURIComponent(query)}&types=songs&limit=10`;

  log.info(Tag.SEARCH, '→ apple search', { storefront, query });
  const start = Date.now();
  const response = await fetchAppleWithRetry(searchUrl, { headers }, 'search', Tag.SEARCH);
  const ms = Date.now() - start;

  if (!response.ok) {
    if (response.status === 401) {
      log.warn(Tag.SEARCH, '← search 401 TOKEN_EXPIRED', { ms });
      throw new Error('TOKEN_EXPIRED');
    }
    if (response.status === 429) {
      log.error(Tag.SEARCH, '← search 429 rate limited after retries', { ms });
      throw new UpstreamRateLimitedError('search');
    }
    log.error(Tag.SEARCH, '← search error', { status: response.status, ms });
    throw new Error(`Search failed: ${response.status}`);
  }

  const data: AppleMusicSearchResponse = await response.json();
  const tracks = data.results?.songs?.data ?? [];
  log.info(Tag.SEARCH, '← search ok', { status: response.status, ms, tracks: tracks.length });
  return tracks;
}

function selectBestTrack(
  rawTracks: AppleMusicTrack[],
  song: string,
  artist: string,
  albumName?: string,
  duration?: number
): SearchResult | null {
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
    logBelowThreshold(best);
    return null;
  }

  return best;
}

function logBelowThreshold(best: SearchResult | null): void {
  log.info(Tag.SEARCH, 'below score threshold', {
    bestScore: best?.score.toFixed(3) ?? 'none',
    threshold: MIN_SCORE_THRESHOLD,
  });
}

function logBestMatch(message: string, best: SearchResult): void {
  log.info(Tag.SEARCH, message, {
    albumId: best.albumId,
    name: best.track.attributes.name,
    artist: best.track.attributes.artistName,
    score: best.score.toFixed(3),
  });
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

  // Variant penalties (scaled to 0–1 range)
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
