import { log, Tag } from './logger';
import { TransientUpstreamError } from './errors';
import { UpstreamRateLimitedError } from './outboundLimiter';
import {
  getCanvasByTrackId,
  getCanvasIndex,
  trackKey,
  upsertCanvasIndex,
  type CanvasIndexRow,
  type TrackKey,
} from './resultCache';
import { fetchCanvasUrl, matchTrack } from './spotify';
import type { TrackInput } from './spotifyMatcher';
import type { Tier } from './priority';

export type CanvasResponse = { trackId: string; videoUrl: string | null } | { error: string };

const NO_MATCH = { error: 'No matching tracks found' } as const;
const MAX_DURATION_S = 86400;
// Postgres rejects btree rows over ~2.7 kB, and an uncacheable key would cost a lookup every time.
const MAX_KEY_BYTES = 2000;

type TrackCanvas = CanvasIndexRow & { expiresAt?: Date };

const lookupsInFlight = new Map<string, Promise<CanvasIndexRow>>();
const tracksInFlight = new Map<string, Promise<TrackCanvas>>();

export async function getCanvas(request: TrackKey, tier: Tier): Promise<CanvasResponse> {
  const req = { ...request, duration: knownDuration(request.duration) };
  if (Buffer.byteLength(trackKey(req).slice(0, 3).join('')) > MAX_KEY_BYTES) return NO_MATCH;
  const row = (await getCanvasIndex(req)) ?? (await lookupOnce(req, tier));
  return row.trackId ? { trackId: row.trackId, videoUrl: row.videoUrl } : NO_MATCH;
}

export function toTrackInput(req: TrackKey): TrackInput {
  return {
    title: req.song,
    artist: req.artist,
    album: req.albumName ?? '',
    durationMs: (knownDuration(req.duration) ?? 0) * 1000,
  };
}

function knownDuration(d: number | undefined): number | undefined {
  return d !== undefined && Number.isFinite(d) && d > 0 && d <= MAX_DURATION_S ? d : undefined;
}

function singleFlight<T>(inFlight: Map<string, Promise<T>>, key: string, run: () => Promise<T>): Promise<T> {
  let pending = inFlight.get(key);
  if (!pending) {
    pending = run().finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }
  return pending;
}

function lookupOnce(req: TrackKey, tier: Tier): Promise<CanvasIndexRow> {
  return singleFlight(lookupsInFlight, trackKey(req).join('|'), () => lookupAndStore(req, tier));
}

function canvasForTrack(trackId: string, tier: Tier): Promise<TrackCanvas> {
  return singleFlight(tracksInFlight, trackId, async () => {
    return (await getCanvasByTrackId(trackId)) ?? { trackId, videoUrl: await fetchCanvasUrl(trackId, tier) };
  });
}

async function lookupAndStore(req: TrackKey, tier: Tier): Promise<CanvasIndexRow> {
  try {
    const trackId = await matchTrack(toTrackInput(req), tier);
    const { expiresAt, ...row }: TrackCanvas = trackId ? await canvasForTrack(trackId, tier) : { trackId: null, videoUrl: null };
    await upsertCanvasIndex(req, row, expiresAt);
    return row;
  } catch (error) {
    if (error instanceof UpstreamRateLimitedError) {
      const stale = await getCanvasIndex(req, { includeExpired: true });
      if (stale) return stale;
      throw error;
    }
    log.error(Tag.CANVAS, 'lookup failed', error);
    throw new TransientUpstreamError('Canvas lookup failed');
  }
}
