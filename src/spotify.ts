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

export class SpotifyHashRotatedError extends TransientUpstreamError {
  constructor() {
    super('Spotify rotated the persisted search query hash');
    this.name = 'SpotifyHashRotatedError';
  }
}

export type CanvasLookup =
  | { kind: 'noMatch' }
  | { kind: 'matched'; trackId: string; videoUrl: string | null };

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
  const res = await fetch(EMBED_URL, {
    signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
    headers: { 'User-Agent': BROWSER_USER_AGENT },
  });
  if (!res.ok) throw new TransientUpstreamError(`Spotify embed HTTP ${res.status}`);
  const parsed = parseEmbedSession(await res.text());
  if (!parsed) throw new TransientUpstreamError('Spotify embed page had no session token');
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
    searchTerm: query,
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

async function searchWithToken(url: string, token: string, tier: Tier): Promise<Response> {
  const res = await fetchSpotifyWithRetry(
    url,
    { headers: { Authorization: `Bearer ${token}`, 'app-platform': 'WebPlayer' } },
    'spotifySearch',
    Tag.SPOTIFY,
    tier
  );
  if (res.status === 401) invalidateSpotifyToken(token);
  return res;
}

export async function fetchCanvasUrl(trackId: string, tier: Tier): Promise<string | null> {
  if (!TRACK_ID.test(trackId)) return null;
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
  if (!body.data || !(trackId in body.data)) {
    log.error(Tag.CANVAS, 'canvas store response shape changed', { trackId });
    throw new TransientUpstreamError('Canvas store response shape changed');
  }
  const url = body.data[trackId]?.url;
  const videoUrl = typeof url === 'string' && url.startsWith('https://') ? url : null;
  log.info(Tag.CANVAS, '← ok', { trackId, ms, canvas: videoUrl !== null });
  return videoUrl;
}

export async function lookupCanvas(track: TrackInput, tier: Tier): Promise<CanvasLookup> {
  const candidates: SpotifyCandidate[] = [];
  let failure: unknown = null;
  for (const query of buildSearchQueries(track)) {
    try {
      candidates.push(...(await searchSpotify(query, tier)));
    } catch (error) {
      failure = error;
      // Later queries hit the same wall and spend more of the shared budget.
      if (error instanceof UpstreamRateLimitedError || error instanceof SpotifyHashRotatedError) break;
      continue;
    }
    const match = resolve(track, candidates);
    if (match.kind === 'matched') {
      const trackId = match.track.candidate.id;
      return { kind: 'matched', trackId, videoUrl: await fetchCanvasUrl(trackId, tier) };
    }
  }
  if (failure) throw failure;
  return { kind: 'noMatch' };
}
