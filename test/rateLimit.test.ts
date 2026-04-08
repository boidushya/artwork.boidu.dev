import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createPenaltyTracker, effectiveLimit } from '../src/rateLimit.ts';

describe('effectiveLimit', () => {
  test('clean IP returns full base limit', () => {
    assert.equal(effectiveLimit(0, 60, 5), 60);
  });

  test('one violation halves the limit', () => {
    assert.equal(effectiveLimit(1, 60, 5), 30);
  });

  test('escalates exponentially per violation', () => {
    assert.equal(effectiveLimit(2, 60, 5), 15);
    assert.equal(effectiveLimit(3, 60, 5), 7);
    assert.equal(effectiveLimit(4, 60, 5), 3);
    assert.equal(effectiveLimit(5, 60, 5), 1);
  });

  test('caps escalation at maxLevel even when violations exceed it', () => {
    const atCap = effectiveLimit(5, 60, 5);
    const overCap = effectiveLimit(99, 60, 5);
    assert.equal(overCap, atCap, 'over-cap violations must not escalate further');
  });

  test('never returns below 1', () => {
    assert.equal(effectiveLimit(20, 5, 20), 1);
    assert.equal(effectiveLimit(100, 1, 100), 1);
  });

  test('floors fractional results (small base)', () => {
    assert.equal(effectiveLimit(1, 5, 5), 2);
    assert.equal(effectiveLimit(2, 5, 5), 1);
  });
});

describe('createPenaltyTracker', () => {
  function makeClock(start = 1_000_000) {
    let t = start;
    return {
      now: () => t,
      advance: (ms: number) => {
        t += ms;
      },
    };
  }

  test('unknown IP starts at zero violations', () => {
    const t = createPenaltyTracker({ baseMs: 60000, maxLevel: 5 });
    assert.equal(t.getViolations('1.1.1.1'), 0);
  });

  test('first violation sets level to 1', () => {
    const t = createPenaltyTracker({ baseMs: 60000, maxLevel: 5 });
    t.recordViolation('1.1.1.1');
    assert.equal(t.getViolations('1.1.1.1'), 1);
  });

  test('subsequent violations within active penalty escalate', () => {
    const clock = makeClock();
    const t = createPenaltyTracker({ baseMs: 60000, maxLevel: 5, now: clock.now });
    t.recordViolation('ip');
    assert.equal(t.getViolations('ip'), 1);
    clock.advance(100);
    t.recordViolation('ip');
    assert.equal(t.getViolations('ip'), 2);
    clock.advance(100);
    t.recordViolation('ip');
    assert.equal(t.getViolations('ip'), 3);
  });

  test('escalation caps at maxLevel', () => {
    const clock = makeClock();
    const t = createPenaltyTracker({ baseMs: 60000, maxLevel: 3, now: clock.now });
    for (let i = 0; i < 10; i++) {
      t.recordViolation('ip');
      clock.advance(10);
    }
    assert.equal(t.getViolations('ip'), 3);
  });

  test('cooldown duration doubles per violation level', () => {
    const clock = makeClock();
    const t = createPenaltyTracker({ baseMs: 1000, maxLevel: 5, now: clock.now });

    t.recordViolation('ip');
    clock.advance(999);
    assert.equal(t.getViolations('ip'), 1, 'still active just before 1st cooldown ends');
    clock.advance(2);
    assert.equal(t.getViolations('ip'), 0, 'expired after 1st cooldown (1000ms)');

    t.recordViolation('ip');
    clock.advance(999);
    assert.equal(t.getViolations('ip'), 1, 'first violation again after decay');

    t.recordViolation('ip');
    assert.equal(t.getViolations('ip'), 2);
    clock.advance(1999);
    assert.equal(t.getViolations('ip'), 2, 'still active just before 2nd cooldown ends');
    clock.advance(2);
    assert.equal(t.getViolations('ip'), 0, 'expired after 2nd cooldown (2000ms)');
  });

  test('penalty decay restarts escalation at level 1', () => {
    const clock = makeClock();
    const t = createPenaltyTracker({ baseMs: 1000, maxLevel: 5, now: clock.now });
    t.recordViolation('ip');
    t.recordViolation('ip');
    assert.equal(t.getViolations('ip'), 2);
    clock.advance(10_000);
    assert.equal(t.getViolations('ip'), 0);
    t.recordViolation('ip');
    assert.equal(t.getViolations('ip'), 1, 'new violation after decay starts fresh');
  });

  test('getViolations evicts expired entries', () => {
    const clock = makeClock();
    const t = createPenaltyTracker({ baseMs: 1000, maxLevel: 5, now: clock.now });
    t.recordViolation('ip');
    clock.advance(10_000);
    t.getViolations('ip');
    clock.advance(10_000);
    t.recordViolation('ip');
    assert.equal(t.getViolations('ip'), 1, 'fresh entry after eviction starts at 1');
  });

  test('different IPs are independent', () => {
    const t = createPenaltyTracker({ baseMs: 60000, maxLevel: 5 });
    t.recordViolation('a');
    t.recordViolation('a');
    t.recordViolation('b');
    assert.equal(t.getViolations('a'), 2);
    assert.equal(t.getViolations('b'), 1);
  });

  test('sweep removes expired entries', () => {
    const clock = makeClock();
    const t = createPenaltyTracker({ baseMs: 1000, maxLevel: 5, now: clock.now });
    t.recordViolation('a');
    t.recordViolation('b');
    clock.advance(500);
    t.recordViolation('c');
    clock.advance(600);
    t.sweep();
    assert.equal(t.getViolations('a'), 0);
    assert.equal(t.getViolations('b'), 0);
    assert.equal(t.getViolations('c'), 1);
  });
});
