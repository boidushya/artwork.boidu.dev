import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { TransientUpstreamError, errorHttpResponse, USAGE } from '../src/errors.ts';
import { UpstreamRateLimitedError } from '../src/outboundLimiter.ts';

describe('errorHttpResponse', () => {
  test('upstream rate limit maps to 503', () => {
    assert.deepEqual(errorHttpResponse(new UpstreamRateLimitedError('search')), {
      status: 503,
      body: { error: 'Upstream rate limited, try again shortly' },
    });
  });

  test('transient upstream failure maps to 502 and keeps its message', () => {
    assert.deepEqual(errorHttpResponse(new TransientUpstreamError('Search failed')), {
      status: 502,
      body: { error: 'Search failed' },
    });
  });

  describe('error paths', () => {
    test('unknown errors map to 500 with their message', () => {
      assert.deepEqual(errorHttpResponse(new Error('boom')), { status: 500, body: { error: 'boom' } });
    });

    test('non-error values map to 500 with a generic message', () => {
      assert.deepEqual(errorHttpResponse('nope'), { status: 500, body: { error: 'Unknown error' } });
    });
  });

  describe('invariants', () => {
    test('no mapped status is cacheable as a definitive answer', () => {
      for (const err of [new UpstreamRateLimitedError('album'), new TransientUpstreamError('x'), new Error('y')]) {
        assert.ok(errorHttpResponse(err).status >= 500);
      }
    });
  });
});

describe('TransientUpstreamError', () => {
  test('is an Error with a stable name', () => {
    const err = new TransientUpstreamError('Failed to fetch album data');
    assert.ok(err instanceof Error);
    assert.equal(err.name, 'TransientUpstreamError');
    assert.equal(err.message, 'Failed to fetch album data');
  });
});

describe('USAGE', () => {
  test('documents every search parameter the api reads', () => {
    for (const param of ['s', 'a', 'al', 'd']) {
      assert.ok(param in USAGE.params, `missing ${param}`);
    }
  });

  test('keeps the missing parameters error for existing clients', () => {
    assert.match(USAGE.error, /^Missing parameters/);
  });

  test('tells clients which answers are safe to cache', () => {
    assert.match(JSON.stringify(USAGE.responses), /retry/i);
    assert.match(JSON.stringify(USAGE.responses), /cache/i);
  });
});
