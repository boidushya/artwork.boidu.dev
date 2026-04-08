import type { Context } from 'hono';
import { rateLimiter } from 'hono-rate-limiter';
import { log, Tag } from './logger';

const BASE_LIMIT = parseInt(process.env.RATE_LIMIT_BASE || '60', 10);
const WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10);
const PENALTY_BASE_MS = parseInt(process.env.RATE_LIMIT_PENALTY_BASE_MS || '60000', 10);
const PENALTY_MAX = parseInt(process.env.RATE_LIMIT_PENALTY_MAX || '5', 10);

export interface PenaltyTracker {
  getViolations(ip: string): number;
  recordViolation(ip: string): void;
  sweep(): void;
}

export function createPenaltyTracker(opts: {
  baseMs: number;
  maxLevel: number;
  now?: () => number;
}): PenaltyTracker {
  const penalties = new Map<string, { violations: number; expiresAt: number }>();
  const now = opts.now ?? Date.now;

  return {
    getViolations(ip: string): number {
      const p = penalties.get(ip);
      if (!p) return 0;
      if (now() > p.expiresAt) {
        penalties.delete(ip);
        return 0;
      }
      return p.violations;
    },
    recordViolation(ip: string): void {
      const existing = penalties.get(ip);
      const active = existing !== undefined && now() < existing.expiresAt;
      const nextLevel = active ? existing.violations + 1 : 1;
      const violations = Math.min(nextLevel, opts.maxLevel);
      const cooldownMs = opts.baseMs * Math.pow(2, violations - 1);
      penalties.set(ip, {
        violations,
        expiresAt: now() + cooldownMs,
      });
    },
    sweep(): void {
      const t = now();
      for (const [ip, p] of penalties) {
        if (t > p.expiresAt) penalties.delete(ip);
      }
    },
  };
}

export function effectiveLimit(violations: number, baseLimit: number, maxLevel: number): number {
  const capped = Math.min(violations, maxLevel);
  return Math.max(1, Math.floor(baseLimit / Math.pow(2, capped)));
}

export function resolveIp(c: Context): string {
  const xff = c.req.header('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  const xri = c.req.header('x-real-ip');
  if (xri) return xri;
  return 'unknown';
}

const tracker = createPenaltyTracker({
  baseMs: PENALTY_BASE_MS,
  maxLevel: PENALTY_MAX,
});

setInterval(() => tracker.sweep(), 5 * 60 * 1000).unref();

export const artworkRateLimit = rateLimiter({
  windowMs: WINDOW_MS,
  limit: (c) => effectiveLimit(tracker.getViolations(resolveIp(c)), BASE_LIMIT, PENALTY_MAX),
  keyGenerator: (c) => resolveIp(c),
  standardHeaders: 'draft-7',
  skip: (c) => c.req.path === '/health',
  handler: (c) => {
    const ip = resolveIp(c);
    tracker.recordViolation(ip);
    const level = tracker.getViolations(ip);
    const limit = effectiveLimit(level, BASE_LIMIT, PENALTY_MAX);
    log.warn(Tag.RATELIMIT, 'violation', { ip, level, limit });
    return c.json({ error: 'Rate limit exceeded' }, 429);
  },
});
