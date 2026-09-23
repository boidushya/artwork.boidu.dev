import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { cacheControlFor } from '../src/httpCache.ts';

const artwork = { name: 'Nights', artist: 'Frank Ocean', albumId: '1146195596', static: 'x', animated: null, videoUrl: null };

describe('cacheControlFor', () => {
  test('artwork is cached at the edge for a day and served stale on origin errors', () => {
    const value = cacheControlFor(200, artwork);
    assert.match(value!, /public/);
    assert.match(value!, /s-maxage=86400/);
    assert.match(value!, /stale-if-error=604800/);
  });

  test('definitive 200 errors are cached briefly', () => {
    assert.equal(cacheControlFor(200, { error: 'No matching tracks found' }), 'public, max-age=3600, s-maxage=3600');
  });

  describe('error paths', () => {
    test('5xx responses are never stored', () => {
      for (const status of [500, 502, 503]) {
        assert.equal(cacheControlFor(status, { error: 'x' }), 'no-store');
      }
    });

    test('4xx responses get no caching header', () => {
      assert.equal(cacheControlFor(429, { error: 'Rate limit exceeded' }), null);
      assert.equal(cacheControlFor(400, { error: 'bad' }), null);
    });
  });

  describe('invariants', () => {
    test('only 200 responses are ever marked public', () => {
      for (const status of [201, 204, 301, 400, 404, 429, 500, 502, 503]) {
        const value = cacheControlFor(status, artwork);
        assert.ok(value === null || !value.includes('public'), `status ${status}`);
      }
    });

    test('error bodies never get the long artwork ttl', () => {
      assert.doesNotMatch(cacheControlFor(200, { error: 'Album not found' })!, /86400/);
    });
  });
});
