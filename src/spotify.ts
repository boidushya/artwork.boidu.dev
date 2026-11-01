import { log, Tag } from './logger';
import { TransientUpstreamError } from './errors';
import { fetchSpotifyWithRetry, UpstreamRateLimitedError } from './outboundLimiter';
import { BROWSER_USER_AGENT } from './token';
import type { Tier } from './priority';
import { buildSearchQueries, resolve, type SpotifyCandidate, type TrackInput } from './spotifyMatcher';

const EMBED_URL = 'https://open.spotify.com/embed/track/4uLU6hMCjMI75M1A2tKUQC';
const PATHFINDER_URL = 'https://api-partner.spotify.com/pathfinder/v1/query';
const SEARCH_SHA256 = 'eff59fa0a3d026b88b56fddbcf4bdfa16a186b8175a5c1a358c072e053c2e5b0';
const CANVAS_STORE_URL = 'https://regional.canvasstore.slnode.spicylyrics.org/provider/canvaslist';
const CLIENT_ID = 'artwork.boidu.dev';
const EMBED_TIMEOUT_MS = 5000;
const EXPIRY_SKEW_MS = 60_000;
const TRACK_ID = /^[A-Za-z0-9]{22}$/;
const MAX_SEARCH_TERM_LENGTH = 250;
const SEARCH_CACHE_TTL_MS = 3600_000;
const SEARCH_CACHE_MAX_ENTRIES = 2000;

export class SpotifyHashRotatedError extends TransientUpstreamError {
  constructor() {
    super('Spotify rotated the persisted search query hash');
    this.name = 'SpotifyHashRotatedError';
  }
}

export class SpotifyTokenError extends TransientUpstreamError {
  constructor(message: string) {
    super(message);
    this.name = 'SpotifyTokenError';
  }
}

interface PathfinderTrack {
  id?: string;
  uri?: string;
  name?: string;
  artists?: { items?: Array<{ profile?: { name?: string } }> };
  albumOfTrack?: { name?: string };
  duration?: { totalMilliseconds?: number };
}

interface PathfinderSearchBody {
  errors?: Array<{ message?: string }>;
  data?: { searchV2?: { tracksV2?: { items?: Array<{ item?: { data?: PathfinderTrack } }> } } };
}

let session: { token: string; expiresAt: number } | null = null;
let sessionInFlight: Promise<string> | null = null;

export async function getSpotifyToken(): Promise<string> {
  if (session && session.expiresAt - EXPIRY_SKEW_MS > Date.now()) return session.token;
  sessionInFlight ??= fetchSession().finally(() => {
    sessionInFlight = null;
  });
  return sessionInFlight;
}

export function invalidateSpotifyToken(token?: string): void {
  if (!token || session?.token === token) session = null;
}

async function fetchSession(): Promise<string> {
  let res: Response;
  try {
    res = await fetch(EMBED_URL, {
      signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
      headers: { 'User-Agent': BROWSER_USER_AGENT },
    });
  } catch (error) {
    throw new SpotifyTokenError(`Spotify embed fetch failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!res.ok) throw new SpotifyTokenError(`Spotify embed HTTP ${res.status}`);
  const parsed = parseEmbedSession(await res.text());
  if (!parsed) throw new SpotifyTokenError('Spotify embed page had no session token');
  session = parsed;
  log.info(Tag.SPOTIFY, 'token refreshed', { expiresInS: Math.round((parsed.expiresAt - Date.now()) / 1000) });
  return parsed.token;
}

function parseEmbedSession(html: string): { token: string; expiresAt: number } | null {
  const json = html.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i)?.[1];
  if (!json) return null;
  let s: { accessToken?: unknown; accessTokenExpirationTimestampMs?: unknown } | undefined;
  try {
    s = JSON.parse(json)?.props?.pageProps?.state?.settings?.session;
  } catch {
    return null;
  }
  if (typeof s?.accessToken !== 'string' || typeof s.accessTokenExpirationTimestampMs !== 'number') return null;
  return { token: s.accessToken, expiresAt: s.accessTokenExpirationTimestampMs };
}

async function readJson<T>(res: Response, what: string): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch {
    throw new TransientUpstreamError(`${what} returned invalid JSON`);
  }
}

export async function searchSpotify(query: string, tier: Tier): Promise<SpotifyCandidate[]> {
  const variables = {
    searchTerm: clampSearchTerm(query),
    offset: 0,
    limit: 20,
    numberOfTopResults: 5,
    includeAudiobooks: false,
    includePreReleases: true,
    includeAlbumPreReleases: false,
    includeAuthors: false,
    includeEpisodeContentRatingsV2: false,
  };
  const extensions = { persistedQuery: { version: 1, sha256Hash: SEARCH_SHA256 } };
  const url =
    `${PATHFINDER_URL}?operationName=searchDesktop` +
    `&variables=${encodeURIComponent(JSON.stringify(variables))}` +
    `&extensions=${encodeURIComponent(JSON.stringify(extensions))}`;

  log.info(Tag.SPOTIFY, '→ spotify', { query });
  const start = Date.now();
  let res = await searchWithToken(url, await getSpotifyToken(), tier);
  if (res.status === 401) {
    log.warn(Tag.SPOTIFY, '← 401, refreshing token');
    res = await searchWithToken(url, await getSpotifyToken(), tier);
  }
  const ms = Date.now() - start;
  if (res.status === 429) {
    log.error(Tag.SPOTIFY, '← 429 rate limited', { ms });
    throw new UpstreamRateLimitedError('spotifySearch');
  }
  if (!res.ok) {
    log.error(Tag.SPOTIFY, '← error', { status: res.status, ms });
    throw new TransientUpstreamError(`Spotify search HTTP ${res.status}`);
  }

  const body = await readJson<PathfinderSearchBody>(res, 'Spotify search');
  if (body.errors?.some((e) => e.message === 'PersistedQueryNotFound')) {
    log.error(Tag.SPOTIFY, 'persisted query hash rotated, update SEARCH_SHA256 in src/spotify.ts');
    throw new SpotifyHashRotatedError();
  }
  const items = body.data?.searchV2?.tracksV2?.items;
  if (!Array.isArray(items)) {
    log.error(Tag.SPOTIFY, 'search response shape changed', { errors: body.errors?.map((e) => e.message) });
    throw new TransientUpstreamError('Spotify search response shape changed');
  }

  const candidates: SpotifyCandidate[] = [];
  for (const entry of items) {
    const d = entry?.item?.data;
    const id = d?.id ?? d?.uri?.split(':').pop();
    const artists = (d?.artists?.items ?? []).map((a) => a?.profile?.name).filter((n): n is string => Boolean(n));
    const durationMs = d?.duration?.totalMilliseconds;
    if (!id || !d?.name || artists.length === 0 || typeof durationMs !== 'number') continue;
    candidates.push({ id, title: d.name, artists, album: d.albumOfTrack?.name ?? '', durationMs });
  }
  log.info(Tag.SPOTIFY, '← ok', { ms, tracks: candidates.length });
  return candidates;
}

function clampSearchTerm(query: string): string {
  let term = '';
  for (const ch of query) {
    if (term.length + ch.length > MAX_SEARCH_TERM_LENGTH) break;
    term += ch;
  }
  return term;
}

async function searchWithToken(url: string, token: string, tier: Tier): Promise<Response> {
  const res = await fetchSpotifyWithRetry(
    url,
    { headers: { Authorization: `Bearer ${token}`, 'app-platform': 'WebPlayer' } },
    'spotifySearch',
    Tag.SPOTIFY,
    tier
  );
  if (res.status === 401) {
    invalidateSpotifyToken(token);
    await res.body?.cancel();
  }
  return res;
}

export async function fetchCanvasUrl(trackId: string, tier: Tier): Promise<string | null> {
  if (!TRACK_ID.test(trackId)) throw new TransientUpstreamError(`Malformed Spotify track id ${JSON.stringify(trackId)}`);
  const start = Date.now();
  const res = await fetchSpotifyWithRetry(
    `${CANVAS_STORE_URL}/${trackId}`,
    { headers: { 'X-Client': CLIENT_ID } },
    'canvasStore',
    Tag.CANVAS,
    tier
  );
  const ms = Date.now() - start;
  if (res.status === 429) {
    log.error(Tag.CANVAS, '← 429 rate limited', { trackId, ms });
    throw new UpstreamRateLimitedError('canvasStore');
  }
  if (res.status !== 200) {
    log.error(Tag.CANVAS, '← error', { trackId, status: res.status, ms });
    throw new TransientUpstreamError(`Canvas store HTTP ${res.status}`);
  }
  const body = await readJson<{ data?: Record<string, { url?: unknown } | null> }>(res, 'Canvas store');
  const entry = body.data?.[trackId];
  const url = entry?.url;
  const videoUrl = entry === null ? null : typeof url === 'string' && url.startsWith('https://') ? url : undefined;
  if (videoUrl === undefined) {
    log.error(Tag.CANVAS, 'canvas store response shape changed', { trackId });
    throw new TransientUpstreamError('Canvas store response shape changed');
  }
  log.info(Tag.CANVAS, '← ok', { trackId, ms, canvas: videoUrl !== null });
  return videoUrl;
}

const searchCache = new Map<string, { at: number; candidates: SpotifyCandidate[] }>();

export function clearSpotifySearchCache(): void {
  searchCache.clear();
}

async function searchSpotifyCached(query: string, tier: Tier): Promise<SpotifyCandidate[]> {
  const hit = searchCache.get(query);
  if (hit && Date.now() - hit.at < SEARCH_CACHE_TTL_MS) return hit.candidates;
  const candidates = await searchSpotify(query, tier);
  searchCache.delete(query);
  searchCache.set(query, { at: Date.now(), candidates });
  if (searchCache.size > SEARCH_CACHE_MAX_ENTRIES) {
    const oldest = searchCache.keys().next().value;
    if (oldest !== undefined) searchCache.delete(oldest);
  }
  return candidates;
}

export async function matchTrack(track: TrackInput, tier: Tier): Promise<string | null> {
  const candidates: SpotifyCandidate[] = [];
  let failure: unknown = null;
  for (const query of buildSearchQueries(track)) {
    try {
      candidates.push(...(await searchSpotifyCached(query, tier)));
    } catch (error) {
      failure = error;
      // Later queries hit the same wall and spend more of the shared budget.
      if (
        error instanceof UpstreamRateLimitedError ||
        error instanceof SpotifyHashRotatedError ||
        error instanceof SpotifyTokenError
      ) {
        break;
      }
      continue;
    }
    const match = resolve(track, candidates);
    if (match.kind === 'matched') {
      const { candidate, score } = match.track;
      log.info(Tag.SPOTIFY, 'best match', {
        trackId: candidate.id,
        name: candidate.title,
        artist: candidate.artists.join(', '),
        album: candidate.album,
        score,
      });
      return candidate.id;
    }
  }
  if (failure) throw failure;
  log.info(Tag.SPOTIFY, 'no match', { title: track.title, artist: track.artist, candidates: candidates.length });
  return null;
}
