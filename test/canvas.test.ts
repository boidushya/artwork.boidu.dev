import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getCanvas, toTrackInput } from '../src/canvas.ts';
import { clearSpotifySearchCache, invalidateSpotifyToken } from '../src/spotify.ts';
import { TransientUpstreamError } from '../src/errors.ts';
import { UpstreamRateLimitedError } from '../src/outboundLimiter.ts';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/spotify/${name}`, import.meta.url), 'utf8');
const EMBED = fixture('embed.html');
const SEARCH = fixture('search-levitating.json');
const CANVAS_HIT = fixture('canvas-hit.json');
const HIT_ID = '39LLxExYz6ewLAcYrzQQyP';
const VIDEO_URL = JSON.parse(CANVAS_HIT).data[HIT_ID].url;

let originalFetch: typeof globalThis.fetch;
let searches: number;

function stub(search: () => Response, canvas: (id: string) => Response = (id) => new Response(JSON.stringify({ data: { [id]: { url: VIDEO_URL } } }))) {
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.host === 'open.spotify.com') return new Response(EMBED);
    if (url.host === 'api-partner.spotify.com') {
      searches++;
      await new Promise((r) => setTimeout(r, 20));
      return search();
    }
    return canvas(url.pathname.split('/').pop()!);
  };
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  searches = 0;
  invalidateSpotifyToken();
  clearSpotifySearchCache();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('getCanvas', () => {
  test('a canvas hit returns trackId and videoUrl', async () => {
    stub(() => new Response(SEARCH));
    assert.deepEqual(await getCanvas({ song: 'Levitating', artist: 'Dua Lipa', albumName: 'Future Nostalgia', duration: 204 }, 'priority'), {
      trackId: HIT_ID,
      videoUrl: VIDEO_URL,
    });
  });

  test('a track without canvas returns a null videoUrl', async () => {
    stub(
      () => new Response(SEARCH),
      (id) => new Response(JSON.stringify({ data: { [id]: null } }))
    );
    assert.deepEqual(await getCanvas({ song: 'Levitating', artist: 'Dua Lipa', duration: 204 }, 'priority'), {
      trackId: HIT_ID,
      videoUrl: null,
    });
  });

  test('no match returns the usual error body', async () => {
    stub(() => new Response(SEARCH));
    assert.deepEqual(await getCanvas({ song: 'Enter Sandman', artist: 'Metallica' }, 'priority'), {
      error: 'No matching tracks found',
    });
  });

  describe('invariants', () => {
    test('concurrent requests for one track share one lookup', async () => {
      stub(() => new Response(SEARCH));
      const results = await Promise.all([
        getCanvas({ song: 'Levitating', artist: 'Dua Lipa', duration: 204 }, 'priority'),
        getCanvas({ song: 'LEVITATING', artist: 'dua lipa', duration: 204 }, 'priority'),
        getCanvas({ song: 'Levitating!', artist: 'Dua Lipa ', duration: 204 }, 'standard'),
      ]);
      assert.equal(searches, 1);
      assert.equal(new Set(results.map((r) => JSON.stringify(r))).size, 1);
    });

    test('a finished lookup does not block the next one', async () => {
      stub(() => new Response(SEARCH));
      await getCanvas({ song: 'Levitating', artist: 'Dua Lipa', duration: 204 }, 'priority');
      clearSpotifySearchCache();
      await getCanvas({ song: 'Levitating', artist: 'Dua Lipa', duration: 204 }, 'priority');
      assert.equal(searches, 2, 'no DATABASE_URL in tests, so the second call looks up again');
    });

    test('a failed lookup does not block the next one', async () => {
      stub(() => new Response('', { status: 500 }));
      await assert.rejects(getCanvas({ song: 'Levitating', artist: 'Dua Lipa' }, 'priority'));
      stub(() => new Response(SEARCH));
      assert.ok('trackId' in (await getCanvas({ song: 'Levitating', artist: 'Dua Lipa' }, 'priority')));
    });
  });

  describe('error paths', () => {
    test('a rate limit without a stale row is rethrown as a rate limit', async () => {
      stub(() => new Response('', { status: 429 }));
      await assert.rejects(getCanvas({ song: 'Levitating', artist: 'Dua Lipa' }, 'priority'), UpstreamRateLimitedError);
      stub(() => new Response(SEARCH));
      await getCanvas({ song: 'Levitating', artist: 'Dua Lipa' }, 'priority');
    });

    test('a canvas store failure after a match becomes a transient error', async () => {
      stub(
        () => new Response(SEARCH),
        () => new Response('', { status: 502 })
      );
      await assert.rejects(getCanvas({ song: 'Levitating', artist: 'Dua Lipa' }, 'priority'), TransientUpstreamError);
    });

    test('other failures become a transient error', async () => {
      stub(() => new Response('', { status: 500 }));
      await assert.rejects(getCanvas({ song: 'Levitating', artist: 'Dua Lipa' }, 'priority'), (err: unknown) => {
        assert.ok(err instanceof TransientUpstreamError);
        assert.equal((err as Error).message, 'Canvas lookup failed');
        return true;
      });
    });
  });
});

describe('toTrackInput', () => {
  test('converts seconds to milliseconds', () => {
    assert.deepEqual(toTrackInput({ song: 'a', artist: 'b', albumName: 'c', duration: 204 }), {
      title: 'a',
      artist: 'b',
      album: 'c',
      durationMs: 204000,
    });
  });

  describe('edge cases', () => {
    test('missing, zero, negative and NaN durations are unknown', () => {
      for (const duration of [undefined, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
        assert.equal(toTrackInput({ song: 'a', artist: 'b', duration }).durationMs, 0, String(duration));
      }
    });

    test('missing album is empty', () => {
      assert.equal(toTrackInput({ song: 'a', artist: 'b' }).album, '');
    });
  });
});

describe('regressions', () => {
  test('regression: a junk duration shares the unknown-duration lookup instead of a key of its own', async () => {
    stub(() => new Response(SEARCH));
    await Promise.all([
      getCanvas({ song: 'Levitating', artist: 'Dua Lipa' }, 'priority'),
      getCanvas({ song: 'Levitating', artist: 'Dua Lipa', duration: Number.NaN }, 'priority'),
      getCanvas({ song: 'Levitating', artist: 'Dua Lipa', duration: -3 }, 'priority'),
    ]);
    assert.equal(searches, 1);
  });
});

describe('input limits', () => {
  describe('regressions', () => {
    test('regression: a duration past one day is unknown instead of overflowing the integer column', async () => {
      stub(() => new Response(SEARCH));
      await Promise.all([
        getCanvas({ song: 'Levitating', artist: 'Dua Lipa' }, 'priority'),
        getCanvas({ song: 'Levitating', artist: 'Dua Lipa', duration: 99999999999 }, 'priority'),
        getCanvas({ song: 'Levitating', artist: 'Dua Lipa', duration: 86401 }, 'priority'),
      ]);
      assert.equal(searches, 1);
      assert.equal(toTrackInput({ song: 'a', artist: 'b', duration: 99999999999 }).durationMs, 0);
    });

    test('regression: an oversize key answers no match without any request', async () => {
      stub(() => {
        throw new Error('must not search');
      });
      for (const req of [
        { song: 'a'.repeat(5000), artist: 'Dua Lipa' },
        { song: 'Levitating', artist: 'b'.repeat(5000) },
        { song: 'Levitating', artist: 'Dua Lipa', albumName: 'c'.repeat(5000) },
        { song: 'ﷺ'.repeat(200), artist: 'x' },
      ]) {
        assert.deepEqual(await getCanvas(req, 'priority'), { error: 'No matching tracks found' });
      }
      assert.equal(searches, 0);
    });
  });

  describe('edge cases', () => {
    test('a long but valid title still looks up', async () => {
      stub(() => new Response(SEARCH));
      await getCanvas({ song: 'Levitating '.repeat(30), artist: 'Dua Lipa' }, 'priority');
      assert.ok(searches >= 1);
    });
  });
});
