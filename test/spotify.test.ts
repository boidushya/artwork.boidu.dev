import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  fetchCanvasUrl,
  getSpotifyToken,
  invalidateSpotifyToken,
  matchTrack,
  clearSpotifySearchCache,
  searchSpotify,
  SpotifyHashRotatedError,
  SpotifyTokenError,
} from '../src/spotify.ts';
import { TransientUpstreamError } from '../src/errors.ts';
import { UpstreamRateLimitedError } from '../src/outboundLimiter.ts';
import type { TrackInput } from '../src/spotifyMatcher.ts';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/spotify/${name}`, import.meta.url), 'utf8');
const EMBED = fixture('embed.html');
const SEARCH = fixture('search-levitating.json');
const HASH_ROTATED = fixture('search-hash-rotated.json');
const CANVAS_HIT = fixture('canvas-hit.json');
const CANVAS_NULL = fixture('canvas-null.json');
const ORIGINAL_ID = '39LLxExYz6ewLAcYrzQQyP';
const NO_CANVAS_ID = '4vq7KUT7qvqw9owOCtEyKx';
const SANDMAN: TrackInput = { title: 'Enter Sandman', artist: 'Metallica', album: 'The Black Album', durationMs: 331000 };
const LEVITATING: TrackInput = { title: 'Levitating', artist: 'Dua Lipa', album: 'Future Nostalgia', durationMs: 204000 };

type Route = (url: URL, init?: RequestInit) => Response | Promise<Response>;
interface Call {
  url: URL;
  init?: RequestInit;
}

let originalFetch: typeof globalThis.fetch;
let calls: Call[];

function stub(routes: { embed?: Route; search?: Route; canvas?: Route }) {
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    const route =
      url.host === 'open.spotify.com' ? routes.embed : url.host === 'api-partner.spotify.com' ? routes.search : routes.canvas;
    if (!route) throw new Error(`unexpected fetch ${url}`);
    return route(url, init);
  };
}

const ok = (body: string) => () => new Response(body, { status: 200 });
const status = (code: number, body = '{}') => () => new Response(body, { status: code });
const hostCalls = (host: string) => calls.filter((c) => c.url.host === host);
const embedCalls = () => hostCalls('open.spotify.com');
const searchCalls = () => hostCalls('api-partner.spotify.com');
const canvasCalls = () => hostCalls('regional.canvasstore.slnode.spicylyrics.org');
const header = (c: Call, name: string) => new Headers(c.init?.headers).get(name);

beforeEach(() => {
  originalFetch = globalThis.fetch;
  calls = [];
  invalidateSpotifyToken();
  clearSpotifySearchCache();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('getSpotifyToken', () => {
  test('reads the session token from the embed page', async () => {
    stub({ embed: ok(EMBED) });
    assert.equal(await getSpotifyToken(), 'fixture-token');
  });

  test('concurrent callers share one embed fetch', async () => {
    stub({ embed: ok(EMBED) });
    const tokens = await Promise.all(Array.from({ length: 5 }, () => getSpotifyToken()));
    assert.deepEqual(new Set(tokens), new Set(['fixture-token']));
    assert.equal(embedCalls().length, 1);
  });

  test('reuses a cached token', async () => {
    stub({ embed: ok(EMBED) });
    await getSpotifyToken();
    await getSpotifyToken();
    assert.equal(embedCalls().length, 1);
  });

  describe('edge cases', () => {
    test('refetches when the token is within a minute of expiry', async () => {
      stub({ embed: ok(EMBED.replace('4102444800000', String(Date.now() + 30_000))) });
      await getSpotifyToken();
      await getSpotifyToken();
      assert.equal(embedCalls().length, 2);
    });
  });

  describe('error paths', () => {
    test('non-200 embed page is a transient failure', async () => {
      stub({ embed: status(503, 'down') });
      await assert.rejects(getSpotifyToken(), TransientUpstreamError);
    });

    test('page without __NEXT_DATA__ is a transient failure', async () => {
      stub({ embed: ok('<html><body>nothing</body></html>') });
      await assert.rejects(getSpotifyToken(), TransientUpstreamError);
    });

    test('malformed __NEXT_DATA__ JSON is a transient failure, not a SyntaxError', async () => {
      stub({ embed: ok('<script id="__NEXT_DATA__" type="application/json">{oops</script>') });
      await assert.rejects(getSpotifyToken(), TransientUpstreamError);
    });

    test('a failed fetch does not poison later calls', async () => {
      stub({ embed: status(500) });
      await assert.rejects(getSpotifyToken());
      stub({ embed: ok(EMBED) });
      assert.equal(await getSpotifyToken(), 'fixture-token');
    });
  });
});

describe('searchSpotify', () => {
  test('parses track candidates', async () => {
    stub({ embed: ok(EMBED), search: ok(SEARCH) });
    const candidates = await searchSpotify('Levitating Dua Lipa', 'priority');
    assert.equal(candidates.length, 20);
    assert.deepEqual(candidates[0], {
      id: ORIGINAL_ID,
      title: 'Levitating',
      artists: ['Dua Lipa'],
      album: 'Future Nostalgia',
      durationMs: 203807,
    });
  });

  test('sends the token, platform header, operation and persisted query', async () => {
    stub({ embed: ok(EMBED), search: ok(SEARCH) });
    await searchSpotify('Levitating Dua Lipa', 'priority');
    const [call] = searchCalls();
    assert.equal(header(call, 'Authorization'), 'Bearer fixture-token');
    assert.equal(header(call, 'app-platform'), 'WebPlayer');
    assert.equal(call.url.searchParams.get('operationName'), 'searchDesktop');
    assert.equal(JSON.parse(call.url.searchParams.get('variables')!).searchTerm, 'Levitating Dua Lipa');
    assert.equal(
      JSON.parse(call.url.searchParams.get('extensions')!).persistedQuery.sha256Hash,
      'eff59fa0a3d026b88b56fddbcf4bdfa16a186b8175a5c1a358c072e053c2e5b0'
    );
  });

  test('a 401 refreshes the token once and retries', async () => {
    let n = 0;
    stub({ embed: ok(EMBED), search: () => (n++ === 0 ? new Response('', { status: 401 }) : new Response(SEARCH)) });
    const candidates = await searchSpotify('Levitating Dua Lipa', 'priority');
    assert.equal(candidates.length, 20);
    assert.equal(embedCalls().length, 2);
    assert.equal(searchCalls().length, 2);
  });

  describe('edge cases', () => {
    test('skips items without id, name, artists or duration', async () => {
      const body = JSON.parse(SEARCH);
      const items = body.data.searchV2.tracksV2.items;
      delete items[0].item.data.id;
      delete items[0].item.data.uri;
      delete items[1].item.data.name;
      items[2].item.data.artists.items = [];
      delete items[3].item.data.duration;
      items[4] = {};
      stub({ embed: ok(EMBED), search: ok(JSON.stringify(body)) });
      const candidates = await searchSpotify('x', 'priority');
      assert.equal(candidates.length, 15);
    });

    test('falls back to the uri when id is missing', async () => {
      const body = JSON.parse(SEARCH);
      delete body.data.searchV2.tracksV2.items[0].item.data.id;
      stub({ embed: ok(EMBED), search: ok(JSON.stringify(body)) });
      assert.equal((await searchSpotify('x', 'priority'))[0].id, ORIGINAL_ID);
    });
  });

  describe('regressions', () => {
    test('regression: search terms are cut to the 250 character API limit without splitting a character', async () => {
      stub({ embed: ok(EMBED), search: ok(SEARCH) });
      for (const query of ['a'.repeat(400), `${'x'.repeat(249)}\u{1F480}tail`, '\u{1F480}'.repeat(200)]) {
        await searchSpotify(query, 'priority');
      }
      for (const call of searchCalls()) {
        const term: string = JSON.parse(call.url.searchParams.get('variables')!).searchTerm;
        assert.ok(term.length <= 250, `length ${term.length}`);
        assert.equal(term, term.toWellFormed(), 'no lone surrogates');
      }
      assert.equal(JSON.parse(searchCalls()[1].url.searchParams.get('variables')!).searchTerm, 'x'.repeat(249));
    });
  });

  describe('error paths', () => {
    test('two 401s in a row is a transient failure', async () => {
      stub({ embed: ok(EMBED), search: status(401) });
      await assert.rejects(searchSpotify('x', 'priority'), TransientUpstreamError);
      assert.equal(searchCalls().length, 2);
    });

    test('PersistedQueryNotFound is a hash rotation error', async () => {
      stub({ embed: ok(EMBED), search: ok(HASH_ROTATED) });
      await assert.rejects(searchSpotify('x', 'priority'), (err: unknown) => {
        assert.ok(err instanceof SpotifyHashRotatedError);
        assert.ok(err instanceof TransientUpstreamError);
        return true;
      });
    });

    test('a changed response shape is a transient failure', async () => {
      stub({ embed: ok(EMBED), search: ok('{"data":{"searchV2":{}}}') });
      await assert.rejects(searchSpotify('x', 'priority'), TransientUpstreamError);
    });

    test('a non-JSON body is a transient failure', async () => {
      stub({ embed: ok(EMBED), search: ok('<html>') });
      await assert.rejects(searchSpotify('x', 'priority'), TransientUpstreamError);
    });

    test('a 500 is a transient failure', async () => {
      stub({ embed: ok(EMBED), search: status(500) });
      await assert.rejects(searchSpotify('x', 'priority'), TransientUpstreamError);
    });

    test('a 429 is a rate limit on spotifySearch', async () => {
      stub({ embed: ok(EMBED), search: status(429) });
      await assert.rejects(
        searchSpotify('x', 'priority'),
        (err: unknown) => err instanceof UpstreamRateLimitedError && err.endpoint === 'spotifySearch'
      );
      stub({ embed: ok(EMBED), search: ok(SEARCH) });
      await searchSpotify('x', 'priority');
    });
  });
});

describe('fetchCanvasUrl', () => {
  test('returns the canvas video url and identifies itself', async () => {
    stub({ canvas: ok(CANVAS_HIT) });
    const url = await fetchCanvasUrl(ORIGINAL_ID, 'priority');
    assert.match(url!, /^https:\/\/canvaz\.scdn\.co\/.+\.mp4$/);
    const [call] = canvasCalls();
    assert.equal(call.url.pathname, `/provider/canvaslist/${ORIGINAL_ID}`);
    assert.equal(header(call, 'X-Client'), 'artwork.boidu.dev');
  });

  test('a null entry means the track has no canvas', async () => {
    stub({ canvas: ok(CANVAS_NULL) });
    assert.equal(await fetchCanvasUrl(NO_CANVAS_ID, 'priority'), null);
  });

  describe('regressions', () => {
    test('regression: an invalid track id is a failure without any request, never a cached miss', async () => {
      stub({});
      for (const id of ['abc', '', `${ORIGINAL_ID}x`, '../../etc/passwd/aaaaaa']) {
        await assert.rejects(fetchCanvasUrl(id, 'priority'), TransientUpstreamError);
      }
      assert.equal(calls.length, 0);
    });

    test('regression: an entry without a usable https url is a failure, only null means no canvas', async () => {
      for (const entry of [{}, { url: '' }, { url: 42 }, { url: 'http://canvaz.scdn.co/x.mp4' }]) {
        stub({ canvas: ok(JSON.stringify({ data: { [ORIGINAL_ID]: entry } })) });
        await assert.rejects(fetchCanvasUrl(ORIGINAL_ID, 'priority'), TransientUpstreamError, JSON.stringify(entry));
      }
    });
  });

  describe('error paths', () => {
    for (const code of [500, 404, 403]) {
      test(`HTTP ${code} is a failure, never a miss`, async () => {
        stub({ canvas: status(code) });
        await assert.rejects(fetchCanvasUrl(ORIGINAL_ID, 'priority'), TransientUpstreamError);
      });
    }

    test('a 429 is a rate limit on canvasStore', async () => {
      stub({ canvas: status(429) });
      await assert.rejects(
        fetchCanvasUrl(ORIGINAL_ID, 'priority'),
        (err: unknown) => err instanceof UpstreamRateLimitedError && err.endpoint === 'canvasStore'
      );
      stub({ canvas: ok(CANVAS_HIT) });
      await fetchCanvasUrl(ORIGINAL_ID, 'priority');
    });

    test('a 200 without an entry for the track is a failure', async () => {
      stub({ canvas: ok('{"data":{}}') });
      await assert.rejects(fetchCanvasUrl(ORIGINAL_ID, 'priority'), TransientUpstreamError);
    });

    test('a non-JSON 200 is a failure', async () => {
      stub({ canvas: ok('<html>') });
      await assert.rejects(fetchCanvasUrl(ORIGINAL_ID, 'priority'), TransientUpstreamError);
    });
  });
});

describe('matchTrack', () => {
  test('stops at the first query that matches and makes no canvas call', async () => {
    stub({ embed: ok(EMBED), search: ok(SEARCH) });
    assert.equal(await matchTrack(LEVITATING, 'priority'), ORIGINAL_ID);
    assert.equal(searchCalls().length, 1);
    assert.equal(canvasCalls().length, 0);
  });

  test('a failed query followed by a match returns the match', async () => {
    let n = 0;
    stub({ embed: ok(EMBED), search: () => (n++ === 0 ? new Response('', { status: 500 }) : new Response(SEARCH)) });
    assert.equal(await matchTrack(LEVITATING, 'priority'), ORIGINAL_ID);
    assert.equal(searchCalls().length, 2);
  });

  test('no match on any query is null', async () => {
    stub({ embed: ok(EMBED), search: ok(SEARCH) });
    assert.equal(await matchTrack(SANDMAN, 'priority'), null);
    assert.equal(searchCalls().length, 2);
  });

  describe('invariants', () => {
    test('the same query is answered from memory, so a different duration costs no search', async () => {
      stub({ embed: ok(EMBED), search: ok(SEARCH) });
      await matchTrack(LEVITATING, 'priority');
      await matchTrack({ ...LEVITATING, durationMs: 203000 }, 'priority');
      await matchTrack({ ...LEVITATING, durationMs: 0 }, 'priority');
      assert.equal(searchCalls().length, 1);
    });

    test('failed searches are not remembered', async () => {
      stub({ embed: ok(EMBED), search: status(500) });
      await assert.rejects(matchTrack(LEVITATING, 'priority'));
      stub({ embed: ok(EMBED), search: ok(SEARCH) });
      assert.equal(await matchTrack(LEVITATING, 'priority'), ORIGINAL_ID);
    });
  });

  describe('error paths', () => {
    test('a failure and no match is a failure, not a miss', async () => {
      let n = 0;
      stub({ embed: ok(EMBED), search: () => (n++ === 0 ? new Response('', { status: 500 }) : new Response(SEARCH)) });
      await assert.rejects(matchTrack(SANDMAN, 'priority'), TransientUpstreamError);
    });

    test('hash rotation stops after one search', async () => {
      stub({ embed: ok(EMBED), search: ok(HASH_ROTATED) });
      await assert.rejects(matchTrack(LEVITATING, 'priority'), SpotifyHashRotatedError);
      assert.equal(searchCalls().length, 1);
    });

    test('a rate limit stops after one search', async () => {
      stub({ embed: ok(EMBED), search: status(429) });
      await assert.rejects(matchTrack(LEVITATING, 'priority'), UpstreamRateLimitedError);
      assert.equal(searchCalls().length, 1);
      stub({ embed: ok(EMBED), search: ok(SEARCH) });
      await matchTrack(LEVITATING, 'priority');
    });

    test('regression: a token failure stops after one embed fetch and no search', async () => {
      stub({ embed: status(500), search: ok(SEARCH) });
      await assert.rejects(matchTrack(LEVITATING, 'priority'), SpotifyTokenError);
      assert.equal(embedCalls().length, 1);
      assert.equal(searchCalls().length, 0);
    });
  });
});
