import { log, Tag } from './logger';
import type { TokenSource } from './token';
import type { Tier } from './priority';

const SCRAPE_BURST = parseInt(process.env.APPLE_BURST || '5', 10);
const SCRAPE_RATE_PER_SEC = parseFloat(process.env.APPLE_RATE || '1');
const MINT_BURST = parseInt(process.env.APPLE_MINT_BURST || '200', 10);
const MINT_RATE_PER_SEC = parseFloat(process.env.APPLE_MINT_RATE || '100');
const RETRY_ATTEMPTS = parseInt(process.env.APPLE_RETRY_ATTEMPTS || '3', 10);
const RETRY_BASE_MS = parseInt(process.env.APPLE_RETRY_BASE_MS || '500', 10);
const MAX_QUEUE_WAIT_MS = parseInt(process.env.APPLE_MAX_QUEUE_WAIT_MS || '10000', 10);
const CIRCUIT_THRESHOLD = parseInt(process.env.APPLE_CIRCUIT_THRESHOLD || '3', 10);
const CIRCUIT_BASE_OPEN_MS = parseInt(process.env.APPLE_CIRCUIT_BASE_OPEN_MS || '300000', 10);
const CIRCUIT_MAX_OPEN_MS = parseInt(process.env.APPLE_CIRCUIT_MAX_OPEN_MS || '14400000', 10);
const CIRCUIT_MULTIPLIER = parseFloat(process.env.APPLE_CIRCUIT_MULTIPLIER || '4');
const PRIORITY_RESERVE = parseInt(process.env.APPLE_PRIORITY_RESERVE || '2', 10);
const STANDARD_MAX_QUEUE_WAIT_MS = parseInt(process.env.APPLE_STANDARD_MAX_WAIT_MS || '1500', 10);
const PRIORITY_ACTIVE_WINDOW_MS = parseInt(process.env.APPLE_PRIORITY_WINDOW_MS || '5000', 10);
const SPOTIFY_BURST = parseInt(process.env.SPOTIFY_BURST || '4', 10);
const SPOTIFY_RATE_PER_SEC = parseFloat(process.env.SPOTIFY_RATE || '1');
const CANVAS_STORE_BURST = parseInt(process.env.CANVAS_STORE_BURST || '10', 10);
const CANVAS_STORE_RATE_PER_SEC = parseFloat(process.env.CANVAS_STORE_RATE || '5');
const SPOTIFY_RETRY_ATTEMPTS = parseInt(process.env.SPOTIFY_RETRY_ATTEMPTS || '1', 10);
const SPOTIFY_TIMEOUT_MS = parseInt(process.env.SPOTIFY_TIMEOUT_MS || '5000', 10);
const SPOTIFY_CIRCUIT_THRESHOLD = parseInt(process.env.SPOTIFY_CIRCUIT_THRESHOLD || '3', 10);
const SPOTIFY_CIRCUIT_BASE_OPEN_MS = parseInt(process.env.SPOTIFY_CIRCUIT_BASE_OPEN_MS || '30000', 10);
const SPOTIFY_CIRCUIT_MAX_OPEN_MS = parseInt(process.env.SPOTIFY_CIRCUIT_MAX_OPEN_MS || '600000', 10);
const SPOTIFY_CIRCUIT_MULTIPLIER = parseFloat(process.env.SPOTIFY_CIRCUIT_MULTIPLIER || '2');

const UPSTREAM_ENDPOINTS = ['search', 'searchEdge', 'searchWeb', 'searchWebEdge', 'album', 'spotifySearch', 'canvasStore'] as const;
export type UpstreamEndpoint = (typeof UPSTREAM_ENDPOINTS)[number];
export type SpotifyEndpoint = Extract<UpstreamEndpoint, 'spotifySearch' | 'canvasStore'>;

export class UpstreamRateLimitedError extends Error {
  constructor(public readonly endpoint: UpstreamEndpoint) {
    super(`Upstream rate limited: ${endpoint}`);
    this.name = 'UpstreamRateLimitedError';
  }
}

interface CircuitState {
  consecutiveFailures: number;
  trips: number;
  openUntil: number;
}

export interface CircuitBreaker {
  check(endpoint: UpstreamEndpoint): void;
  recordSuccess(endpoint: UpstreamEndpoint): void;
  recordFailure(endpoint: UpstreamEndpoint): void;
  isOpen(endpoint: UpstreamEndpoint): boolean;
  stateOf(endpoint: UpstreamEndpoint): Readonly<CircuitState>;
}

export function createCircuitBreaker(opts: {
  threshold: number;
  baseOpenMs: number;
  maxOpenMs: number;
  multiplier: number;
  now?: () => number;
}): CircuitBreaker {
  const now = opts.now ?? Date.now;
  const states = Object.fromEntries(
    UPSTREAM_ENDPOINTS.map((e) => [e, { consecutiveFailures: 0, trips: 0, openUntil: 0 }])
  ) as Record<UpstreamEndpoint, CircuitState>;

  function cooldownMsForTrips(trips: number): number {
    const ms = opts.baseOpenMs * Math.pow(opts.multiplier, Math.max(0, trips - 1));
    return Math.min(ms, opts.maxOpenMs);
  }

  return {
    check(endpoint) {
      const c = states[endpoint];
      if (c.openUntil === 0) return;
      const t = now();
      if (t < c.openUntil) {
        throw new UpstreamRateLimitedError(endpoint);
      }
      log.info(Tag.RATELIMIT, 'circuit closed after cooldown', {
        endpoint,
        trips: c.trips,
      });
      c.openUntil = 0;
      c.consecutiveFailures = 0;
    },
    recordSuccess(endpoint) {
      const c = states[endpoint];
      if (c.consecutiveFailures > 0 || c.trips > 0 || c.openUntil > 0) {
        log.info(Tag.RATELIMIT, 'circuit reset on success', { endpoint });
      }
      c.consecutiveFailures = 0;
      c.trips = 0;
      c.openUntil = 0;
    },
    recordFailure(endpoint) {
      const c = states[endpoint];
      c.consecutiveFailures += 1;
      if (c.consecutiveFailures >= opts.threshold) {
        c.trips += 1;
        const cooldown = cooldownMsForTrips(c.trips);
        c.openUntil = now() + cooldown;
        log.error(Tag.RATELIMIT, 'circuit OPEN', {
          endpoint,
          trips: c.trips,
          cooldownMs: cooldown,
          cooldownMin: Math.round(cooldown / 60000),
        });
        c.consecutiveFailures = 0;
      } else {
        log.warn(Tag.RATELIMIT, 'upstream failure recorded', {
          endpoint,
          consecutiveFailures: c.consecutiveFailures,
          threshold: opts.threshold,
        });
      }
    },
    isOpen(endpoint) {
      return now() < states[endpoint].openUntil;
    },
    stateOf(endpoint) {
      return { ...states[endpoint] };
    },
  };
}

const circuitBreaker = createCircuitBreaker({
  threshold: CIRCUIT_THRESHOLD,
  baseOpenMs: CIRCUIT_BASE_OPEN_MS,
  maxOpenMs: CIRCUIT_MAX_OPEN_MS,
  multiplier: CIRCUIT_MULTIPLIER,
});

const spotifyCircuitBreaker = createCircuitBreaker({
  threshold: SPOTIFY_CIRCUIT_THRESHOLD,
  baseOpenMs: SPOTIFY_CIRCUIT_BASE_OPEN_MS,
  maxOpenMs: SPOTIFY_CIRCUIT_MAX_OPEN_MS,
  multiplier: SPOTIFY_CIRCUIT_MULTIPLIER,
});

function breakerFor(endpoint: UpstreamEndpoint): CircuitBreaker {
  return endpoint === 'spotifySearch' || endpoint === 'canvasStore' ? spotifyCircuitBreaker : circuitBreaker;
}

export class TokenBucket {
  tokens: number;
  lastRefill: number;

  constructor(
    public readonly capacity: number,
    public readonly refillPerSecond: number,
    now = Date.now()
  ) {
    this.tokens = capacity;
    this.lastRefill = now;
  }

  refill(now = Date.now()): void {
    const elapsed = (now - this.lastRefill) / 1000;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSecond);
    this.lastRefill = now;
  }

  tryConsume(now = Date.now(), reserve = 0): boolean {
    this.refill(now);
    if (this.tokens >= 1 + reserve) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  msUntilNextToken(now = Date.now(), reserve = 0): number {
    this.refill(now);
    const need = 1 + reserve;
    if (this.tokens >= need) return 0;
    return Math.ceil(((need - this.tokens) * 1000) / this.refillPerSecond);
  }
}

const scrapeBucket = new TokenBucket(SCRAPE_BURST, SCRAPE_RATE_PER_SEC);
const mintBucket = new TokenBucket(MINT_BURST, MINT_RATE_PER_SEC);
const spotifyBuckets: Record<SpotifyEndpoint, TokenBucket> = {
  spotifySearch: new TokenBucket(SPOTIFY_BURST, SPOTIFY_RATE_PER_SEC),
  canvasStore: new TokenBucket(CANVAS_STORE_BURST, CANVAS_STORE_RATE_PER_SEC),
};

export function bucketForSource(source: TokenSource): TokenBucket {
  return source === 'mint' ? mintBucket : scrapeBucket;
}

export class QueueTimeoutError extends Error {
  constructor(
    public readonly waitedMs: number,
    public readonly maxWaitMs: number
  ) {
    super(`outbound throttle queue wait exceeded ${waitedMs}ms`);
    this.name = 'QueueTimeoutError';
  }
}

export function reserveFor(tier: Tier, priorityActive: boolean, reserve = PRIORITY_RESERVE): number {
  return tier === 'standard' && priorityActive ? reserve : 0;
}

export interface PriorityWindow {
  lastAt: number;
}

export function createPriorityWindow(): PriorityWindow {
  return { lastAt: 0 };
}

const applePriority = createPriorityWindow();
const spotifyPriority = createPriorityWindow();

export async function acquireSlot(
  bucket: TokenBucket,
  tier: Tier,
  window: PriorityWindow,
  maxWaitMs?: number
): Promise<number> {
  if (tier === 'priority') window.lastAt = Date.now();
  const priorityActive = Date.now() - window.lastAt < PRIORITY_ACTIVE_WINDOW_MS;
  const reserve = reserveFor(tier, priorityActive);
  const cap = maxWaitMs ?? (tier === 'standard' ? STANDARD_MAX_QUEUE_WAIT_MS : MAX_QUEUE_WAIT_MS);
  const start = Date.now();
  while (true) {
    if (bucket.tryConsume(Date.now(), reserve)) {
      return Date.now() - start;
    }
    const waited = Date.now() - start;
    if (waited >= cap) {
      throw new QueueTimeoutError(waited, cap);
    }
    const tokenWaitMs = bucket.msUntilNextToken(Date.now(), reserve);
    const sleepMs = Math.min(tokenWaitMs, cap - waited);
    await new Promise<void>((r) => setTimeout(r, sleepMs));
  }
}

interface Lane {
  bucket: TokenBucket;
  breaker: CircuitBreaker;
  priority: PriorityWindow;
  retryAttempts: number;
  timeoutMs?: number;
  countServerErrors?: boolean;
  label: string;
}

export async function fetchAppleWithRetry(
  url: string,
  init: RequestInit,
  endpoint: UpstreamEndpoint,
  tag: string,
  source: TokenSource,
  tier: Tier
): Promise<Response> {
  return fetchWithRetry(url, init, endpoint, tag, tier, {
    bucket: bucketForSource(source),
    breaker: circuitBreaker,
    priority: applePriority,
    retryAttempts: RETRY_ATTEMPTS,
    label: source,
  });
}

export async function fetchSpotifyWithRetry(
  url: string,
  init: RequestInit,
  endpoint: SpotifyEndpoint,
  tag: string,
  tier: Tier
): Promise<Response> {
  return fetchWithRetry(url, init, endpoint, tag, tier, {
    bucket: spotifyBuckets[endpoint],
    breaker: spotifyCircuitBreaker,
    priority: spotifyPriority,
    retryAttempts: SPOTIFY_RETRY_ATTEMPTS,
    timeoutMs: SPOTIFY_TIMEOUT_MS,
    countServerErrors: true,
    label: 'spotify',
  });
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  endpoint: UpstreamEndpoint,
  tag: string,
  tier: Tier,
  lane: Lane
): Promise<Response> {
  lane.breaker.check(endpoint);

  for (let attempt = 0; ; attempt++) {
    let waited: number;
    try {
      waited = await acquireSlot(lane.bucket, tier, lane.priority);
    } catch (err) {
      if (err instanceof QueueTimeoutError) {
        log.warn(Tag.RATELIMIT, 'queue timeout, failing fast', {
          endpoint,
          source: lane.label,
          waitedMs: err.waitedMs,
          maxWaitMs: err.maxWaitMs,
        });
        throw new UpstreamRateLimitedError(endpoint);
      }
      throw err;
    }
    if (waited > 2000) {
      log.warn(Tag.RATELIMIT, 'throttle wait', { endpoint, source: lane.label, waitedMs: waited });
    } else if (waited > 50) {
      log.info(Tag.RATELIMIT, 'throttle wait', { endpoint, source: lane.label, waitedMs: waited });
    }
    let res: Response;
    try {
      res = await fetch(url, lane.timeoutMs ? { ...init, signal: AbortSignal.timeout(lane.timeoutMs) } : init);
    } catch (err) {
      if (lane.countServerErrors) lane.breaker.recordFailure(endpoint);
      throw err;
    }

    if (res.status === 429) {
      if (attempt < lane.retryAttempts - 1) {
        const backoffMs = RETRY_BASE_MS * Math.pow(2, attempt);
        log.warn(tag, '429, backing off', {
          attempt: attempt + 1,
          of: lane.retryAttempts,
          backoffMs,
        });
        await new Promise<void>((r) => setTimeout(r, backoffMs));
        continue;
      }
      lane.breaker.recordFailure(endpoint);
      return res;
    }

    if (lane.countServerErrors && res.status >= 500) {
      lane.breaker.recordFailure(endpoint);
      return res;
    }

    lane.breaker.recordSuccess(endpoint);
    return res;
  }
}

export function isCircuitOpen(endpoint: UpstreamEndpoint): boolean {
  return breakerFor(endpoint).isOpen(endpoint);
}

// TODO: wire into a /metrics or /health endpoint. Kept exported so the hook
// is ready when that lands; consume via `getCircuitState('search' | 'album')`.
export function getCircuitState(endpoint: UpstreamEndpoint) {
  return breakerFor(endpoint).stateOf(endpoint);
}

// TODO: wire into a /metrics or /health endpoint. Calls refill() first so the
// returned token count reflects the current state, not the last consume.
export function getBucketStats() {
  return { mint: statsFor(mintBucket), scrape: statsFor(scrapeBucket) };
}

function statsFor(bucket: TokenBucket) {
  bucket.refill();
  return {
    tokens: Math.floor(bucket.tokens),
    capacity: bucket.capacity,
    refillPerSecond: bucket.refillPerSecond,
  };
}
