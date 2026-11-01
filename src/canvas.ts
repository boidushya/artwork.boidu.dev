import { log, Tag } from './logger';
import { TransientUpstreamError } from './errors';
import { UpstreamRateLimitedError } from './outboundLimiter';
import { getCanvasIndex, trackKey, upsertCanvasIndex, type CanvasIndexRow, type TrackKey } from './resultCache';
import { lookupCanvas } from './spotify';
import type { TrackInput } from './spotifyMatcher';
import type { Tier } from './priority';

export type CanvasResponse = { trackId: string; videoUrl: string | null } | { error: string };

const inFlight = new Map<string, Promise<CanvasIndexRow>>();

export async function getCanvas(req: TrackKey, tier: Tier): Promise<CanvasResponse> {
  const row = (await getCanvasIndex(req)) ?? (await lookupOnce(req, tier));
  return row.trackId ? { trackId: row.trackId, videoUrl: row.videoUrl } : { error: 'No matching tracks found' };
}

export function toTrackInput(req: TrackKey): TrackInput {
  const d = req.duration;
  return {
    title: req.song,
    artist: req.artist,
    album: req.albumName ?? '',
    durationMs: d !== undefined && Number.isFinite(d) && d > 0 ? d * 1000 : 0,
  };
}

function lookupOnce(req: TrackKey, tier: Tier): Promise<CanvasIndexRow> {
  const id = trackKey(req).join('|');
  let pending = inFlight.get(id);
  if (!pending) {
    pending = lookupAndStore(req, tier).finally(() => inFlight.delete(id));
    inFlight.set(id, pending);
  }
  return pending;
}

async function lookupAndStore(req: TrackKey, tier: Tier): Promise<CanvasIndexRow> {
  try {
    const result = await lookupCanvas(toTrackInput(req), tier);
    const row: CanvasIndexRow =
      result.kind === 'matched' ? { trackId: result.trackId, videoUrl: result.videoUrl } : { trackId: null, videoUrl: null };
    await upsertCanvasIndex(req, row);
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
