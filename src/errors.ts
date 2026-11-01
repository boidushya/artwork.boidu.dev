import { UpstreamRateLimitedError } from './outboundLimiter';

export class TransientUpstreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransientUpstreamError';
  }
}

export function errorHttpResponse(error: unknown): { status: 500 | 502 | 503; body: { error: string } } {
  if (error instanceof UpstreamRateLimitedError) {
    return { status: 503, body: { error: 'Upstream rate limited, try again shortly' } };
  }
  if (error instanceof TransientUpstreamError) {
    return { status: 502, body: { error: error.message } };
  }
  return { status: 500, body: { error: error instanceof Error ? error.message : 'Unknown error' } };
}

export const USAGE = {
  error: 'Missing parameters. Use: ?s=song&a=artist, ?id=albumId, or ?url=appleMusicUrl',
  endpoints: {
    search: 'GET /?s=<track title>&a=<artist>&al=<album>&d=<duration in seconds>',
    albumId: 'GET /?id=<numeric Apple Music album id>',
    albumUrl: 'GET /?url=<music.apple.com album url>',
    canvas: 'GET /canvas?s=<track title>&a=<artist>&al=<album>&d=<duration in seconds>',
  },
  params: {
    s: 'Track title as your source shows it.',
    a: 'Artist name. The primary artist is enough.',
    al: 'Album name exactly as your source shows it. Leave it out when you do not know it. Never send view counts, dates or other metadata here.',
    d: 'Track duration in whole seconds. Used to pick the right version of a track.',
  },
  responses: {
    '200 with videoUrl': 'Animated artwork found. Safe to cache.',
    '200 with videoUrl null': 'Album found without animated artwork. Safe to cache for a few days.',
    '200 with error': 'Definitive answer, e.g. no matching track or album not found. Safe to cache for a few days.',
    '429': 'You are sending too many requests. Slow down and cache on your side.',
    '502 or 503': 'Temporary failure. Retry later and do not cache.',
  },
} as const;

export const CANVAS_USAGE = {
  error: 'Missing parameters. Use: /canvas?s=song&a=artist',
  endpoint: USAGE.endpoints.canvas,
  params: USAGE.params,
  responses: {
    '200 with videoUrl': 'Canvas video found. Safe to cache.',
    '200 with trackId and videoUrl null': 'Track found without a canvas. Safe to cache for a few days.',
    '200 with error': 'No matching track. Safe to cache for a few days.',
    '429': 'You are sending too many requests. Slow down and cache on your side.',
    '502 or 503': 'Temporary failure. Retry later and do not cache.',
  },
} as const;
