import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createCircuitBreaker, UpstreamRateLimitedError } from '../src/outboundLimiter.ts';

function makeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function makeBreaker(clock: { now: () => number }, overrides: Partial<{
  threshold: number;
  baseOpenMs: number;
  maxOpenMs: number;
  multiplier: number;
}> = {}) {
  return createCircuitBreaker({
    threshold: overrides.threshold ?? 3,
    baseOpenMs: overrides.baseOpenMs ?? 300_000,
    maxOpenMs: overrides.maxOpenMs ?? 14_400_000,
    multiplier: overrides.multiplier ?? 4,
    now: clock.now,
  });
}

describe('createCircuitBreaker — trip conditions', () => {
  test('starts closed for all endpoints', () => {
    const clock = makeClock();
    const cb = makeBreaker(clock);
    assert.doesNotThrow(() => cb.check('search'));
    assert.doesNotThrow(() => cb.check('album'));
    assert.deepEqual(cb.stateOf('search'), { consecutiveFailures: 0, trips: 0, openUntil: 0 });
  });

  test('does not trip before reaching threshold', () => {
    const clock = makeClock();
    const cb = makeBreaker(clock, { threshold: 3 });
    cb.recordFailure('search');
    cb.recordFailure('search');
    assert.doesNotThrow(() => cb.check('search'));
    assert.equal(cb.stateOf('search').trips, 0);
  });

  test('trips exactly at threshold', () => {
    const clock = makeClock();
    const cb = makeBreaker(clock, { threshold: 3, baseOpenMs: 300_000 });
    cb.recordFailure('search');
    cb.recordFailure('search');
    cb.recordFailure('search');
    assert.throws(() => cb.check('search'), UpstreamRateLimitedError);
    const state = cb.stateOf('search');
    assert.equal(state.trips, 1);
    assert.equal(state.consecutiveFailures, 0);
    assert.equal(state.openUntil, clock.now() + 300_000);
  });
});

describe('createCircuitBreaker — cooldown and escalation', () => {
  test('check throws while within open window', () => {
    const clock = makeClock();
    const cb = makeBreaker(clock, { threshold: 1, baseOpenMs: 60_000 });
    cb.recordFailure('search');
    assert.throws(() => cb.check('search'), UpstreamRateLimitedError);
    clock.advance(30_000);
    assert.throws(() => cb.check('search'), UpstreamRateLimitedError);
    clock.advance(29_999);
    assert.throws(() => cb.check('search'), UpstreamRateLimitedError);
  });

  test('check transitions to closed after cooldown elapses but keeps trips count', () => {
    const clock = makeClock();
    const cb = makeBreaker(clock, { threshold: 1, baseOpenMs: 60_000 });
    cb.recordFailure('search');
    clock.advance(60_001);
    assert.doesNotThrow(() => cb.check('search'));
    const state = cb.stateOf('search');
    assert.equal(state.openUntil, 0);
    assert.equal(state.consecutiveFailures, 0);
    assert.equal(state.trips, 1, 'trips count persists across cooldown expiry');
  });

  test('second trip uses multiplier × base (4x by default)', () => {
    const clock = makeClock();
    const cb = makeBreaker(clock, { threshold: 1, baseOpenMs: 300_000, multiplier: 4 });

    cb.recordFailure('search');
    assert.equal(cb.stateOf('search').openUntil, clock.now() + 300_000);

    clock.advance(300_001);
    cb.check('search');

    cb.recordFailure('search');
    assert.equal(cb.stateOf('search').openUntil, clock.now() + 1_200_000);
    assert.equal(cb.stateOf('search').trips, 2);
  });

  test('third trip = base × multiplier^2 (5m → 20m → 80m ladder)', () => {
    const clock = makeClock();
    const cb = makeBreaker(clock, { threshold: 1, baseOpenMs: 300_000, multiplier: 4 });

    cb.recordFailure('search');
    assert.equal(cb.stateOf('search').openUntil - clock.now(), 300_000);
    clock.advance(300_001);
    cb.check('search');

    cb.recordFailure('search');
    assert.equal(cb.stateOf('search').openUntil - clock.now(), 1_200_000);
    clock.advance(1_200_001);
    cb.check('search');

    cb.recordFailure('search');
    assert.equal(cb.stateOf('search').openUntil - clock.now(), 4_800_000);
    assert.equal(cb.stateOf('search').trips, 3);
  });

  test('cooldown caps at maxOpenMs', () => {
    const clock = makeClock();
    const cb = makeBreaker(clock, {
      threshold: 1,
      baseOpenMs: 300_000,
      multiplier: 4,
      maxOpenMs: 14_400_000,
    });
    for (let i = 0; i < 10; i++) {
      cb.recordFailure('search');
      clock.advance(20_000_000);
      cb.check('search');
    }
    cb.recordFailure('search');
    const remaining = cb.stateOf('search').openUntil - clock.now();
    assert.equal(remaining, 14_400_000, 'cooldown capped at maxOpenMs');
  });
});

describe('createCircuitBreaker — recovery', () => {
  test('recordSuccess fully resets state (failures, trips, openUntil)', () => {
    const clock = makeClock();
    const cb = makeBreaker(clock, { threshold: 1, baseOpenMs: 60_000 });
    cb.recordFailure('search');
    clock.advance(60_001);
    cb.check('search');
    cb.recordFailure('search');
    clock.advance(240_001);
    cb.check('search');

    assert.equal(cb.stateOf('search').trips, 2);

    cb.recordSuccess('search');
    const state = cb.stateOf('search');
    assert.deepEqual(state, { consecutiveFailures: 0, trips: 0, openUntil: 0 });
  });

  test('after success, next trip starts back at base cooldown', () => {
    const clock = makeClock();
    const cb = makeBreaker(clock, { threshold: 1, baseOpenMs: 300_000, multiplier: 4 });

    cb.recordFailure('search');
    clock.advance(300_001);
    cb.check('search');

    cb.recordFailure('search');
    assert.equal(cb.stateOf('search').openUntil - clock.now(), 1_200_000);
    clock.advance(1_200_001);
    cb.check('search');

    cb.recordSuccess('search');

    cb.recordFailure('search');
    assert.equal(
      cb.stateOf('search').openUntil - clock.now(),
      300_000,
      'after success, we start back at base cooldown'
    );
  });

  test('successful call mid-sequence resets consecutiveFailures without tripping', () => {
    const clock = makeClock();
    const cb = makeBreaker(clock, { threshold: 3 });
    cb.recordFailure('search');
    cb.recordFailure('search');
    cb.recordSuccess('search');
    cb.recordFailure('search');
    cb.recordFailure('search');
    assert.doesNotThrow(() => cb.check('search'));
    assert.equal(cb.stateOf('search').trips, 0);
  });
});

describe('createCircuitBreaker — per-endpoint isolation', () => {
  test('search and album have independent state', () => {
    const clock = makeClock();
    const cb = makeBreaker(clock, { threshold: 2, baseOpenMs: 60_000 });

    cb.recordFailure('search');
    cb.recordFailure('search');
    assert.throws(() => cb.check('search'), UpstreamRateLimitedError);
    assert.doesNotThrow(() => cb.check('album'));
  });

  test('tripping search does not affect album', () => {
    const clock = makeClock();
    const cb = makeBreaker(clock, { threshold: 1, baseOpenMs: 60_000 });
    cb.recordFailure('search');
    assert.equal(cb.stateOf('search').trips, 1);
    assert.equal(cb.stateOf('album').trips, 0);
  });

  test('success on one endpoint does not reset the other', () => {
    const clock = makeClock();
    const cb = makeBreaker(clock, { threshold: 3 });
    cb.recordFailure('search');
    cb.recordFailure('search');
    cb.recordSuccess('album');
    assert.equal(cb.stateOf('search').consecutiveFailures, 2);
    assert.equal(cb.stateOf('album').consecutiveFailures, 0);
  });
});

describe('createCircuitBreaker isOpen', () => {
  test('closed breaker is not open', () => {
    const cb = makeBreaker(makeClock());
    assert.equal(cb.isOpen('searchEdge'), false);
  });

  test('open during cooldown, closed after it', () => {
    const clock = makeClock();
    const cb = makeBreaker(clock, { threshold: 1, baseOpenMs: 60_000 });
    cb.recordFailure('searchEdge');
    assert.equal(cb.isOpen('searchEdge'), true);
    clock.advance(60_000);
    assert.equal(cb.isOpen('searchEdge'), false);
  });

  test('does not mutate state', () => {
    const clock = makeClock();
    const cb = makeBreaker(clock, { threshold: 1, baseOpenMs: 60_000 });
    cb.recordFailure('searchEdge');
    clock.advance(60_000);
    const before = cb.stateOf('searchEdge');
    cb.isOpen('searchEdge');
    assert.deepEqual(cb.stateOf('searchEdge'), before);
  });

  test('edge search and amp search trip independently', () => {
    const cb = makeBreaker(makeClock(), { threshold: 1 });
    cb.recordFailure('searchEdge');
    assert.equal(cb.isOpen('searchEdge'), true);
    assert.equal(cb.isOpen('search'), false);
    assert.doesNotThrow(() => cb.check('search'));
  });
});

describe('UpstreamRateLimitedError carries endpoint from check()', () => {
  test('thrown error has correct endpoint name', () => {
    const clock = makeClock();
    const cb = makeBreaker(clock, { threshold: 1 });
    cb.recordFailure('album');
    try {
      cb.check('album');
      assert.fail('expected throw');
    } catch (err) {
      assert.ok(err instanceof UpstreamRateLimitedError);
      assert.equal(err.endpoint, 'album');
    }
  });
});
