import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { TransientUpstreamError, errorHttpResponse, USAGE, CANVAS_USAGE } from '../src/errors.ts';
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

describe('CANVAS_USAGE', () => {
  test('keeps the missing parameters error shape and names the canvas route', () => {
    assert.match(CANVAS_USAGE.error, /^Missing parameters/);
    assert.match(CANVAS_USAGE.error, /\/canvas\?s=/);
  });

  test('shares the parameter docs with the artwork route', () => {
    assert.equal(CANVAS_USAGE.params, USAGE.params);
  });

  test('the artwork usage lists the canvas endpoint', () => {
    assert.match(USAGE.endpoints.canvas, /^GET \/canvas\?s=/);
  });

  test('tells clients what each answer means and which to cache', () => {
    const responses = JSON.stringify(CANVAS_USAGE.responses);
    assert.match(responses, /trackId/);
    assert.match(responses, /cache/i);
    assert.match(responses, /retry/i);
  });
});
