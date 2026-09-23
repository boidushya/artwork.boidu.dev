import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getToken, invalidateToken, getWebToken, invalidateWebToken, clampTokenTtl, mintedStorefrontCode, storefrontHeaderId } from '../src/token.ts';

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
  invalidateWebToken();
});
afterEach(async () => {
  globalThis.fetch = originalFetch;
  await invalidateToken();
  invalidateWebToken();
});

describe('clampTokenTtl', () => {
  test('clamps below-min up to 60', () => assert.equal(clampTokenTtl(10), 60));
  test('clamps above-max down to 3600', () => assert.equal(clampTokenTtl(5000), 3600));
  test('passes through in-range value', () => assert.equal(clampTokenTtl(120), 120));
  test('floors fractional values', () => assert.equal(clampTokenTtl(120.9), 120));
  test('falls back to 60 for non-finite', () => assert.equal(clampTokenTtl(NaN), 60));
});

function mintRaw(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('mintedStorefrontCode', () => {
  test('maps X-Apple-Store-Front form to two-letter code', () => {
    assert.equal(mintedStorefrontCode('143478-2,31'), 'pl');
  });
  test('maps vietnam', () => {
    assert.equal(mintedStorefrontCode('143471-2,29'), 'vn');
  });
  test('maps a bare numeric id', () => {
    assert.equal(mintedStorefrontCode('143441'), 'us');
  });
  test('strips at comma when no dash present', () => {
    assert.equal(mintedStorefrontCode('143444,31'), 'gb');
  });
  test('returns undefined for an unknown numeric id', () => {
    assert.equal(mintedStorefrontCode('999999-2,31'), undefined);
  });
  test('returns undefined for empty input', () => {
    assert.equal(mintedStorefrontCode(''), undefined);
  });
});

describe('storefrontHeaderId', () => {
  test('returns raw id when the mint storefront matches the query path', () => {
    assert.equal(
      storefrontHeaderId({ token: 'T', source: 'mint', storefront: 'pl', storefrontId: '143478-2,31' }, 'pl'),
      '143478-2,31'
    );
  });
  test('returns undefined when an override storefront differs from the mint binding', () => {
    assert.equal(
      storefrontHeaderId({ token: 'T', source: 'mint', storefront: 'pl', storefrontId: '143478-2,31' }, 'us'),
      undefined
    );
  });
  test('returns undefined for scrape tokens', () => {
    assert.equal(storefrontHeaderId({ token: 'T', source: 'scrape' }, 'vn'), undefined);
  });
});

describe('getToken', () => {
  test('mint success returns source=mint', async () => {
    route([['am-mint', () => mintOk('MINT_A')]]);
    const r = await getToken();
    assert.equal(r.token, 'MINT_A');
    assert.equal(r.source, 'mint');
  });

  test('mint success carries mapped storefront and raw storefrontId', async () => {
    route([['am-mint', () => mintOk('MINT_SF')]]);
    const r = await getToken();
    assert.equal(r.source, 'mint');
    assert.equal(r.storefront, 'pl');
    assert.equal(r.storefrontId, '143478-2,31');
  });

  test('cached mint token round-trips storefront and storefrontId', async () => {
    route([['am-mint', () => mintOk('MINT_RT')]]);
    await getToken();
    const r2 = await getToken();
    assert.equal(r2.storefront, 'pl');
    assert.equal(r2.storefrontId, '143478-2,31');
  });

  test('fails closed to scrape when storefront_id is unmappable', async () => {
    route([
      ['am-mint', () => mintRaw({ token: 'X', storefront_id: '999999-2,31', cache_ttl_seconds: 120 })],
      ...scrapeRoutes,
    ]);
    const r = await getToken();
    assert.equal(r.source, 'scrape');
    assert.equal(r.storefront, undefined);
  });

  test('fails closed to scrape when storefront_id is absent', async () => {
    route([
      ['am-mint', () => mintRaw({ token: 'X', cache_ttl_seconds: 120 })],
      ...scrapeRoutes,
    ]);
    const r = await getToken();
    assert.equal(r.source, 'scrape');
  });

  test('scrape token has no storefront binding', async () => {
    route([
      ['am-mint', () => { throw new Error('down'); }],
      ...scrapeRoutes,
    ]);
    const r = await getToken();
    assert.equal(r.source, 'scrape');
    assert.equal(r.storefront, undefined);
    assert.equal(r.storefrontId, undefined);
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

describe('getToken concurrency', () => {
  test('parallel callers on a cold cache share one mint', async () => {
    route([['am-mint', () => mintOk('MINT_SHARED')]]);
    const results = await Promise.all(Array.from({ length: 20 }, () => getToken()));
    assert.equal(calls.filter((u) => u.includes('am-mint')).length, 1);
    assert.ok(results.every((r) => r.token === 'MINT_SHARED' && r.source === 'mint'));
  });

  test('parallel callers share one scrape when mint fails', async () => {
    route([['am-mint', () => { throw new Error('down'); }], ...scrapeRoutes]);
    const results = await Promise.all(Array.from({ length: 10 }, () => getToken()));
    assert.equal(calls.filter((u) => u.includes('am-mint')).length, 1);
    assert.equal(calls.filter((u) => u.includes('/us/browse')).length, 1);
    assert.ok(results.every((r) => r.source === 'scrape'));
  });

  describe('error paths', () => {
    test('a failed refresh is not reused by the next caller', async () => {
      route([
        ['am-mint', () => { throw new Error('down'); }],
        ['music.apple.com/us/browse', () => new Response('', { status: 500 })],
      ]);
      await assert.rejects(() => getToken());
      route([['am-mint', () => mintOk('MINT_AFTER')]]);
      const r = await getToken();
      assert.equal(r.token, 'MINT_AFTER');
    });

    test('all parallel callers see the same failure', async () => {
      route([
        ['am-mint', () => { throw new Error('down'); }],
        ['music.apple.com/us/browse', () => new Response('', { status: 500 })],
      ]);
      const settled = await Promise.allSettled(Array.from({ length: 5 }, () => getToken()));
      assert.ok(settled.every((s) => s.status === 'rejected'));
      assert.equal(calls.filter((u) => u.includes('am-mint')).length, 1);
    });
  });
});

describe('scrape token TTL', () => {
  test('scrape fallback re-mints within minutes, not an hour', async (t) => {
    t.mock.timers.enable({ apis: ['Date'] });
    let mintUp = false;
    route([
      ['am-mint', () => (mintUp ? mintOk('MINT_BACK') : (() => { throw new Error('down'); })())],
      ...scrapeRoutes,
    ]);
    const first = await getToken();
    assert.equal(first.source, 'scrape');

    mintUp = true;
    t.mock.timers.tick(200_000);
    const second = await getToken();
    assert.equal(second.source, 'mint');
    assert.equal(second.token, 'MINT_BACK');
  });

  test('scrape fallback stays cached within its TTL', async (t) => {
    t.mock.timers.enable({ apis: ['Date'] });
    route([
      ['am-mint', () => { throw new Error('down'); }],
      ...scrapeRoutes,
    ]);
    await getToken();
    const before = calls.length;
    t.mock.timers.tick(60_000);
    const again = await getToken();
    assert.equal(again.source, 'scrape');
    assert.equal(calls.length, before);
  });
});

describe('getWebToken', () => {
  test('scrapes the web player token without calling mint', async () => {
    route(scrapeRoutes);
    assert.equal(await getWebToken(), SCRAPED_JWT);
    assert.ok(calls.every((u) => !u.includes('am-mint')));
  });

  test('reuses the cached token without re-fetching', async () => {
    route(scrapeRoutes);
    await getWebToken();
    const n = calls.length;
    await getWebToken();
    assert.equal(calls.length, n);
  });

  test('re-scrapes after invalidateWebToken', async () => {
    route(scrapeRoutes);
    await getWebToken();
    const n = calls.length;
    invalidateWebToken();
    await getWebToken();
    assert.ok(calls.length > n);
  });

  describe('invariants', () => {
    test('invalidateToken leaves the web token cached', async () => {
      route(scrapeRoutes);
      await getWebToken();
      const n = calls.length;
      await invalidateToken();
      await getWebToken();
      assert.equal(calls.length, n);
    });

    test('web token does not replace the mint token cache', async () => {
      route([['am-mint', () => mintOk('MINT_A')], ...scrapeRoutes]);
      await getWebToken();
      const t = await getToken();
      assert.equal(t.source, 'mint');
      assert.equal(t.token, 'MINT_A');
    });
  });

  describe('error paths', () => {
    test('rejects when the browse page fails', async () => {
      route([['music.apple.com/us/browse', () => new Response('', { status: 500 })]]);
      await assert.rejects(() => getWebToken(), /browse page: 500/);
    });

    test('does not cache a failed scrape', async () => {
      route([['music.apple.com/us/browse', () => new Response('', { status: 500 })]]);
      await assert.rejects(() => getWebToken());
      route(scrapeRoutes);
      assert.equal(await getWebToken(), SCRAPED_JWT);
    });
  });
});
