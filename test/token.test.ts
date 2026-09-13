import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getToken, invalidateToken, clampTokenTtl } from '../src/token.ts';

const SCRAPED_JWT =
  'eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6RkFLRSJ9.eyJmYWtlIjp0cnVlfQ.sig';
const BROWSE_HTML =
  '<html><head><script src="/assets/index-abc123.js"></script></head></html>';
const BUNDLE_JS = `globalThis.__t="${SCRAPED_JWT}";`;

let originalFetch: typeof globalThis.fetch;
let calls: string[];

function mintOk(token = 'MINT_TOKEN_123', ttl = 120): Response {
  return new Response(
    JSON.stringify({ storefront_id: '143478-2,31', token, token_type: 'Bearer', cache_ttl_seconds: ttl }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}

function route(handlers: Array<[string, () => Response | Promise<Response>]>): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    for (const [needle, resp] of handlers) {
      if (url.includes(needle)) return resp();
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof globalThis.fetch;
}

const scrapeRoutes: Array<[string, () => Response]> = [
  ['music.apple.com/us/browse', () => new Response(BROWSE_HTML, { status: 200 })],
  ['index-abc123.js', () => new Response(BUNDLE_JS, { status: 200 })],
];

beforeEach(async () => {
  originalFetch = globalThis.fetch;
  calls = [];
  await invalidateToken();
});
afterEach(async () => {
  globalThis.fetch = originalFetch;
  await invalidateToken();
});

describe('clampTokenTtl', () => {
  test('clamps below-min up to 60', () => assert.equal(clampTokenTtl(10), 60));
  test('clamps above-max down to 3600', () => assert.equal(clampTokenTtl(5000), 3600));
  test('passes through in-range value', () => assert.equal(clampTokenTtl(120), 120));
  test('floors fractional values', () => assert.equal(clampTokenTtl(120.9), 120));
  test('falls back to 60 for non-finite', () => assert.equal(clampTokenTtl(NaN), 60));
});

describe('getToken', () => {
  test('mint success returns source=mint', async () => {
    route([['am-mint', () => mintOk('MINT_A')]]);
    const r = await getToken();
    assert.equal(r.token, 'MINT_A');
    assert.equal(r.source, 'mint');
  });

  test('reuses cached token without re-fetching within TTL', async () => {
    route([['am-mint', () => mintOk('MINT_B')]]);
    await getToken();
    const countAfterFirst = calls.length;
    const r2 = await getToken();
    assert.equal(r2.token, 'MINT_B');
    assert.equal(r2.source, 'mint');
    assert.equal(calls.length, countAfterFirst);
  });

  test('falls back to scrape when mint throws', async () => {
    route([
      ['am-mint', () => { throw new Error('network down'); }],
      ...scrapeRoutes,
    ]);
    const r = await getToken();
    assert.equal(r.token, SCRAPED_JWT);
    assert.equal(r.source, 'scrape');
  });

  test('falls back to scrape on non-2xx mint', async () => {
    route([
      ['am-mint', () => new Response('nope', { status: 500 })],
      ...scrapeRoutes,
    ]);
    const r = await getToken();
    assert.equal(r.source, 'scrape');
  });

  test('falls back to scrape when mint json lacks token', async () => {
    route([
      ['am-mint', () => new Response(JSON.stringify({ cache_ttl_seconds: 120 }), { status: 200 })],
      ...scrapeRoutes,
    ]);
    const r = await getToken();
    assert.equal(r.source, 'scrape');
  });

  test('re-fetches after invalidateToken', async () => {
    route([['am-mint', () => mintOk('MINT_C')]]);
    await getToken();
    const countBefore = calls.length;
    await invalidateToken();
    await getToken();
    assert.ok(calls.length > countBefore);
  });
});
