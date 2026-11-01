export interface TrackInput {
  title: string;
  artist: string;
  album: string;
  durationMs: number;
}

export interface SpotifyCandidate {
  id: string;
  title: string;
  artists: string[];
  album: string;
  durationMs: number;
}

export interface ScoredCandidate {
  candidate: SpotifyCandidate;
  score: number;
  titleSim: number;
  artistSim: number;
  durationDelta: number;
  versionConflict: boolean;
}

export type ResolveResult =
  | { kind: 'matched'; track: ScoredCandidate }
  | { kind: 'ambiguous'; candidates: ScoredCandidate[] }
  | { kind: 'notFound' };

const MIN_SCORE = 82;
const MIN_TITLE_SIM = 0.78;
const MIN_ARTIST_SIM = 0.55;
const MAX_DURATION_DELTA_MS = 8000;
const WINNER_MARGIN = 4;
const DURATION_WINDOW_MS = 15000;
const SAME_RECORDING_MS = 2000;

const VERSION_TERMS = new Set([
  'acoustic',
  'cover',
  'demo',
  'english',
  'inst',
  'japanese',
  'extended',
  'instrumental',
  'karaoke',
  'live',
  'mix',
  'remix',
  'slowed',
  'sped',
]);

const NOISE =
  /\s*[([【](?:[^)\]】]*\b(?:official|audio|video|lyrics?|visuali[sz]er|mv|hd|4k|hq|m\/v)\b[^)\]】]*)[)\]】]/gi;

const ROMAN_NUMERALS: Record<string, string> = {
  i: '1',
  ii: '2',
  iii: '3',
  iv: '4',
  v: '5',
  vi: '6',
  vii: '7',
  viii: '8',
  ix: '9',
  x: '10',
};

const PART_NUMBER = /\b(?:pt|part|vol|volume|chapter|ch) ([0-9]+|[ivx]+)\b/g;

// Differs from search.ts normalize on purpose: that one builds cache keys and must stay stable.
function foldForMatch(value: string | null | undefined): string {
  return (value ?? '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function bigrams(s: string): string[] {
  if (s.length <= 1) return s ? [s] : [];
  const result: string[] = [];
  for (let i = 0; i < s.length - 1; i++) {
    result.push(s.slice(i, i + 2));
  }
  return result;
}

export function similarity(a: string, b: string): number {
  const l = foldForMatch(a);
  const r = foldForMatch(b);
  if (l === r) return 1;
  if (!l || !r) return 0;
  const lb = bigrams(l);
  const pool = bigrams(r);
  const total = lb.length + pool.length;
  let hit = 0;
  for (const g of lb) {
    const idx = pool.indexOf(g);
    if (idx >= 0) {
      hit++;
      pool.splice(idx, 1);
    }
  }
  return (2 * hit) / total;
}

export function cleanTitle(title: string, artist: string): string {
  let t = title
    .replace(NOISE, ' ')
    .replace(/\s+(?:ft|feat|featuring)\.?\s.*$/i, '')
    .trim();
  const dash = t.split(/\s+[-\u2013\u2014]\s+/);
  if (dash.length === 2 && similarity(dash[0], artist) >= 0.6) {
    t = dash[1];
  }
  return t.replace(/\s+/g, ' ').trim();
}

export function buildSearchQueries(track: TrackInput): string[] {
  const clean = cleanTitle(track.title, track.artist);
  const queries = [
    `${track.title} ${track.artist}`.trim(),
    track.album ? `${track.title} ${track.album}`.trim() : '',
    clean !== track.title ? `${clean} ${track.artist}`.trim() : '',
  ].filter(Boolean);
  return Array.from(new Set(queries));
}

function titleParts(t: string): string[] {
  return Array.from(new Set([t, ...t.split(/\s+[-\u2013\u2014|/]\s+|[／｜()[\]（）【】「」]/)].map((s) => s.trim()))).filter(
    (s) => foldForMatch(s) && !/^(feat|featuring|ft|with|prod)\b/.test(foldForMatch(s))
  );
}

function splitArtists(v: string): string[] {
  return Array.from(
    new Set([v, ...v.split(/\s+(?:feat(?:uring)?|ft|with|x)\.?\s+|\s+&\s+|[,;/]/i)].map(foldForMatch).filter(Boolean))
  );
}

function artistSimilarity(local: string, remote: string[]): number {
  const lp = splitArtists(local);
  const rp = remote.flatMap(splitArtists);
  if (!lp.length || !rp.length) return 0;
  return Math.max(...lp.map((l) => Math.max(...rp.map((r) => similarity(l, r)))));
}

function versionTerms(v: string): string {
  const folded = foldForMatch(v);
  return Array.from(
    new Set([
      ...folded.split(' ').filter((t) => VERSION_TERMS.has(t)),
      ...Array.from(folded.matchAll(PART_NUMBER), (m) => `part ${ROMAN_NUMERALS[m[1]] ?? m[1]}`),
    ])
  )
    .sort()
    .join(',');
}

export function score(src: TrackInput, candidate: SpotifyCandidate): ScoredCandidate {
  const lp = titleParts(src.title);
  const rp = titleParts(candidate.title);
  const titleSim = lp.length && rp.length ? Math.max(...lp.map((l) => Math.max(...rp.map((r) => similarity(l, r))))) : 0;
  const unexplained = rp.slice(1).filter((r) => !lp.some((l) => similarity(l, r) >= 0.5)).length;
  const artistSim = artistSimilarity(src.artist, candidate.artists);
  const knownDuration = src.durationMs > 0;
  const durationDelta = knownDuration ? Math.abs(src.durationMs - candidate.durationMs) : 0;
  const durationScore = knownDuration ? Math.max(0, 1 - durationDelta / DURATION_WINDOW_MS) : 0;
  const versionConflict = versionTerms(src.title) !== versionTerms(candidate.title);
  const weighted = 100 * (titleSim * 0.55 + artistSim * 0.3 + durationScore * 0.15);
  const finalScore = Math.round(weighted - (versionConflict ? 18 : 0) - 10 * unexplained);
  return {
    candidate,
    score: Math.min(100, Math.max(0, finalScore)),
    titleSim,
    artistSim,
    durationDelta,
    versionConflict,
  };
}

function isPlausible(t: ScoredCandidate): boolean {
  return (
    t.score >= MIN_SCORE &&
    t.titleSim >= MIN_TITLE_SIM &&
    t.artistSim >= MIN_ARTIST_SIM &&
    t.durationDelta <= MAX_DURATION_DELTA_MS &&
    !t.versionConflict
  );
}

function isSameRecording(a: SpotifyCandidate, b: SpotifyCandidate): boolean {
  const ta = new Set(titleParts(a.title).map(foldForMatch));
  const aa = new Set(a.artists.map(foldForMatch));
  return (
    titleParts(b.title).some((t) => ta.has(foldForMatch(t))) &&
    b.artists.some((x) => aa.has(foldForMatch(x))) &&
    Math.abs(a.durationMs - b.durationMs) <= SAME_RECORDING_MS
  );
}

export function resolve(src: TrackInput, candidates: SpotifyCandidate[]): ResolveResult {
  const seen = new Set<string>();
  const ranked = candidates
    .filter((c) => {
      if (seen.has(c.id)) return false;
      seen.add(c.id);
      return true;
    })
    .map((c) => score(src, c))
    .filter(isPlausible)
    // Stable sort: full ties keep search rank, where Spotify lists the canonical copy first.
    .sort((a, b) => b.score - a.score || a.durationDelta - b.durationDelta);

  let winner = ranked[0];
  if (!winner) return { kind: 'notFound' };

  const runner = ranked[1];
  if (runner && winner.score - runner.score < WINNER_MARGIN) {
    const close = ranked.filter((t) => winner.score - t.score < WINNER_MARGIN);
    const title = foldForMatch(src.title);
    const exactTitle = close.filter((t) => foldForMatch(t.candidate.title) === title);
    const tied = exactTitle.length ? exactTitle : close;
    const album = foldForMatch(src.album);
    const albumMatches = album ? tied.filter((t) => foldForMatch(t.candidate.album) === album) : [];
    const pool = albumMatches.length ? albumMatches : tied;
    if (!pool.every((t) => isSameRecording(pool[0].candidate, t.candidate))) {
      return { kind: 'ambiguous', candidates: ranked.slice(0, 5) };
    }
    winner = pool[0];
  }

  return { kind: 'matched', track: winner };
}
