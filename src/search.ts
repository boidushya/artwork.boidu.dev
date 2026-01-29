import type { AppleMusicSearchResponse, AppleMusicTrack, SearchResult } from './types';

const API_BASE = 'https://amp-api.music.apple.com/v1';
const MIN_SCORE_THRESHOLD = 0.6;
const DURATION_MATCH_DELTA_MS = 2000;

export async function searchTrack(
  song: string,
  artist: string,
  token: string,
  storefront: string = 'us',
  albumName?: string,
  duration?: number
): Promise<SearchResult | null> {
  const query = `${song} ${artist}`.trim();
  const searchUrl = `${API_BASE}/catalog/${storefront}/search?term=${encodeURIComponent(query)}&types=songs&limit=10`;

  const response = await fetch(searchUrl, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Origin': 'https://music.apple.com',
      'Referer': 'https://music.apple.com/',
    },
  });

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error('TOKEN_EXPIRED');
    }
    throw new Error(`Search failed: ${response.status}`);
  }

  const data: AppleMusicSearchResponse = await response.json();
  let tracks = data.results?.songs?.data;

  if (!tracks || tracks.length === 0) {
    return null;
  }

  // Filter by duration if provided
  if (duration !== undefined) {
    const filtered = tracks.filter(
      (track) => Math.abs(track.attributes.durationInMillis - duration) <= DURATION_MATCH_DELTA_MS
    );
    if (filtered.length > 0) {
      tracks = filtered;
    }
  }

  // Score and rank tracks
  const scored = tracks
    .map((track) => scoreTrack(track, song, artist, albumName))
    .filter((result): result is SearchResult => result !== null)
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best || best.score < MIN_SCORE_THRESHOLD) {
    return null;
  }

  return best;
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

function normalize(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
