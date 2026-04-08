import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { TokenBucket, UpstreamRateLimitedError, QueueTimeoutError } from '../src/outboundLimiter.ts';

describe('TokenBucket.refill', () => {
  test('does not overflow past capacity', () => {
    const b = new TokenBucket(10, 5, 1000);
    b.refill(100_000);
    assert.equal(b.tokens, 10);
  });

  test('adds tokens proportional to elapsed time', () => {
    const b = new TokenBucket(10, 5, 1000);
    b.tokens = 2;
    b.refill(2000);
    assert.equal(b.tokens, 7);
  });

  test('updates lastRefill to provided time', () => {
    const b = new TokenBucket(10, 5, 1000);
    b.refill(5000);
    assert.equal(b.lastRefill, 5000);
  });

  test('is a no-op when elapsed is zero or negative', () => {
    const b = new TokenBucket(10, 5, 1000);
    b.tokens = 3;
    b.refill(1000);
    assert.equal(b.tokens, 3);
    b.refill(500);
    assert.equal(b.tokens, 3);
  });

  test('handles fractional refill', () => {
    const b = new TokenBucket(10, 5, 1000);
    b.tokens = 0;
    b.refill(1500);
    assert.equal(b.tokens, 2.5);
  });
});

describe('TokenBucket.tryConsume', () => {
  test('succeeds when tokens available, decrements by 1', () => {
    const b = new TokenBucket(5, 1, 1000);
    assert.equal(b.tryConsume(1000), true);
    assert.equal(b.tokens, 4);
  });

  test('fails when bucket is empty', () => {
    const b = new TokenBucket(2, 1, 1000);
    assert.equal(b.tryConsume(1000), true);
    assert.equal(b.tryConsume(1000), true);
    assert.equal(b.tryConsume(1000), false);
    assert.equal(b.tokens, 0);
  });

  test('refills before checking on each call', () => {
    const b = new TokenBucket(2, 1, 1000);
    b.tryConsume(1000);
    b.tryConsume(1000);
    assert.equal(b.tryConsume(1000), false);
    assert.equal(b.tryConsume(2100), true);
  });

  test('burst capacity is enforced', () => {
    const b = new TokenBucket(3, 10, 1000);
    assert.equal(b.tryConsume(1000), true);
    assert.equal(b.tryConsume(1000), true);
    assert.equal(b.tryConsume(1000), true);
    assert.equal(b.tryConsume(1000), false);
  });
});

describe('TokenBucket.msUntilNextToken', () => {
  test('returns 0 when tokens are available', () => {
    const b = new TokenBucket(5, 1, 1000);
    assert.equal(b.msUntilNextToken(1000), 0);
  });

  test('returns exact ms needed to refill one token when empty', () => {
    const b = new TokenBucket(2, 2, 1000);
    b.tryConsume(1000);
    b.tryConsume(1000);
    assert.equal(b.msUntilNextToken(1000), 500);
  });

  test('accounts for partial refill when computing wait', () => {
    const b = new TokenBucket(5, 1, 1000);
    b.tryConsume(1000);
    b.tryConsume(1000);
    b.tryConsume(1000);
    b.tryConsume(1000);
    b.tryConsume(1000);
    assert.equal(b.msUntilNextToken(1500), 500);
  });

  test('returns 0 when refill since last call already provides a full token', () => {
    const b = new TokenBucket(5, 1, 1000);
    b.tokens = 0;
    b.lastRefill = 1000;
    assert.equal(b.msUntilNextToken(2000), 0);
  });
});

describe('UpstreamRateLimitedError', () => {
  test('carries endpoint name and is identifiable via instanceof', () => {
    const err = new UpstreamRateLimitedError('search');
    assert.ok(err instanceof UpstreamRateLimitedError);
    assert.ok(err instanceof Error);
    assert.equal(err.endpoint, 'search');
    assert.match(err.message, /search/);
  });

  test('preserves error name', () => {
    const err = new UpstreamRateLimitedError('album');
    assert.equal(err.name, 'UpstreamRateLimitedError');
  });
});

describe('QueueTimeoutError', () => {
  test('carries waitedMs and is identifiable via instanceof', () => {
    const err = new QueueTimeoutError(12345);
    assert.ok(err instanceof QueueTimeoutError);
    assert.ok(err instanceof Error);
    assert.equal(err.waitedMs, 12345);
    assert.match(err.message, /12345/);
  });

  test('preserves error name', () => {
    const err = new QueueTimeoutError(0);
    assert.equal(err.name, 'QueueTimeoutError');
  });
});

