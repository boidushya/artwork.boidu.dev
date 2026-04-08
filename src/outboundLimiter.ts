import { log, Tag } from './logger';

const BURST = parseInt(process.env.APPLE_BURST || '5', 10);
const RATE_PER_SEC = parseFloat(process.env.APPLE_RATE || '1');
const RETRY_ATTEMPTS = parseInt(process.env.APPLE_RETRY_ATTEMPTS || '3', 10);
const RETRY_BASE_MS = parseInt(process.env.APPLE_RETRY_BASE_MS || '500', 10);
const MAX_QUEUE_WAIT_MS = parseInt(process.env.APPLE_MAX_QUEUE_WAIT_MS || '10000', 10);
const CIRCUIT_THRESHOLD = parseInt(process.env.APPLE_CIRCUIT_THRESHOLD || '3', 10);
const CIRCUIT_BASE_OPEN_MS = parseInt(process.env.APPLE_CIRCUIT_BASE_OPEN_MS || '300000', 10);
const CIRCUIT_MAX_OPEN_MS = parseInt(process.env.APPLE_CIRCUIT_MAX_OPEN_MS || '14400000', 10);
const CIRCUIT_MULTIPLIER = parseFloat(process.env.APPLE_CIRCUIT_MULTIPLIER || '4');

export type AppleEndpoint = 'search' | 'album';

export class UpstreamRateLimitedError extends Error {
  constructor(public readonly endpoint: AppleEndpoint) {
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
  check(endpoint: AppleEndpoint): void;
  recordSuccess(endpoint: AppleEndpoint): void;
  recordFailure(endpoint: AppleEndpoint): void;
  stateOf(endpoint: AppleEndpoint): Readonly<CircuitState>;
}

export function createCircuitBreaker(opts: {
  threshold: number;
  baseOpenMs: number;
  maxOpenMs: number;
  multiplier: number;
  now?: () => number;
}): CircuitBreaker {
  const now = opts.now ?? Date.now;
  const states: Record<AppleEndpoint, CircuitState> = {
    search: { consecutiveFailures: 0, trips: 0, openUntil: 0 },
    album: { consecutiveFailures: 0, trips: 0, openUntil: 0 },
  };

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

  tryConsume(now = Date.now()): boolean {
    this.refill(now);
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  msUntilNextToken(now = Date.now()): number {
    this.refill(now);
    if (this.tokens >= 1) return 0;
    return Math.ceil(((1 - this.tokens) * 1000) / this.refillPerSecond);
  }
}

const appleBucket = new TokenBucket(BURST, RATE_PER_SEC);

export class QueueTimeoutError extends Error {
  constructor(public readonly waitedMs: number) {
    super(`outbound throttle queue wait exceeded ${waitedMs}ms`);
    this.name = 'QueueTimeoutError';
  }
}

export async function acquireAppleSlot(maxWaitMs = MAX_QUEUE_WAIT_MS): Promise<number> {
  const start = Date.now();
  while (true) {
    if (appleBucket.tryConsume()) {
      return Date.now() - start;
    }
    const waited = Date.now() - start;
    if (waited >= maxWaitMs) {
      throw new QueueTimeoutError(waited);
    }
    const tokenWaitMs = appleBucket.msUntilNextToken();
    const sleepMs = Math.min(tokenWaitMs, maxWaitMs - waited);
    await new Promise<void>((r) => setTimeout(r, sleepMs));
  }
}

export async function fetchAppleWithRetry(
  url: string,
  init: RequestInit,
  endpoint: AppleEndpoint,
  tag: string
): Promise<Response> {
  circuitBreaker.check(endpoint);

  for (let attempt = 0; ; attempt++) {
    let waited: number;
    try {
      waited = await acquireAppleSlot();
    } catch (err) {
      if (err instanceof QueueTimeoutError) {
        log.warn(Tag.RATELIMIT, 'queue timeout — failing fast', {
          endpoint,
          waitedMs: err.waitedMs,
          maxWaitMs: MAX_QUEUE_WAIT_MS,
        });
        throw new UpstreamRateLimitedError(endpoint);
      }
      throw err;
    }
    if (waited > 2000) {
      log.warn(Tag.RATELIMIT, 'throttle wait', { endpoint, waitedMs: waited });
    } else if (waited > 50) {
      log.info(Tag.RATELIMIT, 'throttle wait', { endpoint, waitedMs: waited });
    }
    const res = await fetch(url, init);

    if (res.status === 429) {
      if (attempt < RETRY_ATTEMPTS - 1) {
        const backoffMs = RETRY_BASE_MS * Math.pow(2, attempt);
        log.warn(tag, '429 from apple, backing off', {
          attempt: attempt + 1,
          of: RETRY_ATTEMPTS,
          backoffMs,
        });
        await new Promise<void>((r) => setTimeout(r, backoffMs));
        continue;
      }
      circuitBreaker.recordFailure(endpoint);
      return res;
    }

    circuitBreaker.recordSuccess(endpoint);
    return res;
  }
}

// TODO: wire into a /metrics or /health endpoint. Kept exported so the hook
// is ready when that lands — consume via `getCircuitState('search' | 'album')`.
export function getCircuitState(endpoint: AppleEndpoint) {
  return circuitBreaker.stateOf(endpoint);
}

// TODO: wire into a /metrics or /health endpoint. Calls refill() first so the
// returned token count reflects the current state, not the last consume.
export function getBucketStats() {
  appleBucket.refill();
  return {
    tokens: Math.floor(appleBucket.tokens),
    capacity: appleBucket.capacity,
    refillPerSecond: appleBucket.refillPerSecond,
  };
}
