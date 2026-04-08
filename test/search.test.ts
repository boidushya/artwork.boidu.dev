import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { searchTrack, normalize, stringSimilarity } from '../src/search.ts';
import type { AppleMusicTrack } from '../src/types.ts';

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockSearchResponse(tracks: AppleMusicTrack[], status = 200): Response {
  return new Response(JSON.stringify({ results: { songs: { data: tracks } } }), { status });
}

function makeTrack(overrides: Partial<AppleMusicTrack['attributes']> = {}, id = '12345', albumId = '999001'): AppleMusicTrack {
  return {
    id,
    type: 'songs',
    href: `/v1/catalog/vn/songs/${id}`,
    attributes: {
      name: 'Bohemian Rhapsody',
      artistName: 'Queen',
      albumName: 'A Night at the Opera',
      url: `https://music.apple.com/vn/album/a-night-at-the-opera/${albumId}`,
      durationInMillis: 354000,
      ...overrides,
    },
    relationships: {
      albums: { data: [{ id: albumId, type: 'albums' }] },
    },
  };
}

describe('normalize', () => {
  test('lowercases input', () => {
    assert.equal(normalize('HELLO'), 'hello');
  });
  test('trims surrounding whitespace', () => {
    assert.equal(normalize('  hello  '), 'hello');
  });
  test('strips punctuation', () => {
    assert.equal(normalize("don't stop"), 'dont stop');
  });
  test('collapses multiple spaces into one', () => {
    assert.equal(normalize('hello   world'), 'hello world');
  });
  test('preserves digits and word characters', () => {
    assert.equal(normalize('Track 99'), 'track 99');
  });
  test('handles colons in titles (no delimiter collision)', () => {
    assert.equal(normalize('Song: Part 2'), 'song part 2');
  });
  test('strips Vietnamese diacritics', () => {
    assert.equal(normalize('Tình Yêu'), 'tinh yeu');
  });
  test('strips French diacritics', () => {
    assert.equal(normalize('Café del Mar'), 'cafe del mar');
  });
  test('strips German umlauts', () => {
    assert.equal(normalize('Über'), 'uber');
  });
  test('normalizes compatibility ligatures (NFKC)', () => {
    assert.equal(normalize('ﬁsh'), 'fish');
  });
  test('normalizes full-width characters (NFKC)', () => {
    assert.equal(normalize('Ｔｒａｃｋ１'), 'track1');
  });
  test('preserves non-Latin scripts (letters in any script are kept)', () => {
    assert.equal(normalize('한국어'), '한국어');
    assert.equal(normalize('日本語'), '日本語');
  });
  test('equivalent diacritic and non-diacritic forms collide after normalization', () => {
    assert.equal(normalize('Café'), normalize('Cafe'));
    assert.equal(normalize('Tình'), normalize('Tinh'));
  });
});

describe('stringSimilarity', () => {
  test('identical strings return 1.0', () => {
    assert.equal(stringSimilarity('hello', 'hello'), 1.0);
  });
  test('substring containment returns at least 0.7', () => {
    assert.ok(stringSimilarity('hello world', 'hello') >= 0.7);
    assert.ok(stringSimilarity('queen', 'queen rocks') >= 0.7);
  });
  test('completely unrelated short strings score low', () => {
    assert.ok(stringSimilarity('abc', 'xyz') < 0.4);
  });
  test('partial char overlap returns proportional score', () => {
    const score = stringSimilarity('cat', 'car');
    assert.ok(score > 0 && score < 1);
  });
});

describe('searchTrack', () => {
  test('builds URL with default storefront vn', async () => {
    let captured = '';
    globalThis.fetch = async (url) => {
      captured = String(url);
      return mockSearchResponse([makeTrack()]);
    };
    await searchTrack('Bohemian Rhapsody', 'Queen', 'TOKEN');
    assert.match(captured, /^https:\/\/amp-api\.music\.apple\.com\/v1\/catalog\/vn\/search/);
  });

  test('uses provided storefront in URL', async () => {
    let captured = '';
    globalThis.fetch = async (url) => {
      captured = String(url);
      return mockSearchResponse([makeTrack()]);
    };
    await searchTrack('Bohemian Rhapsody', 'Queen', 'TOKEN', 'us');
    assert.match(captured, /\/catalog\/us\/search/);
  });

  test('encodes search query as song + artist', async () => {
    let captured = '';
    globalThis.fetch = async (url) => {
      captured = String(url);
      return mockSearchResponse([makeTrack()]);
    };
    await searchTrack('Hello World', 'Some Artist', 'TOKEN');
    assert.match(captured, /term=Hello%20World%20Some%20Artist/);
  });

  test('always sends Authorization Bearer header', async () => {
    let headers: Record<string, string> = {};
    globalThis.fetch = async (_url, init) => {
      headers = (init?.headers as Record<string, string>) ?? {};
      return mockSearchResponse([makeTrack()]);
    };
    await searchTrack('B', 'Q', 'JWT_VALUE');
    assert.equal(headers['Authorization'], 'Bearer JWT_VALUE');
  });

  test('omits media-user-token header when mut not provided', async () => {
    let headers: Record<string, string> = {};
    globalThis.fetch = async (_url, init) => {
      headers = (init?.headers as Record<string, string>) ?? {};
      return mockSearchResponse([makeTrack()]);
    };
    await searchTrack('B', 'Q', 'TOKEN', 'vn');
    assert.equal(headers['media-user-token'], undefined);
  });

  test('includes media-user-token header when mut provided', async () => {
    let headers: Record<string, string> = {};
    globalThis.fetch = async (_url, init) => {
      headers = (init?.headers as Record<string, string>) ?? {};
      return mockSearchResponse([makeTrack()]);
    };
    await searchTrack('B', 'Q', 'TOKEN', 'vn', undefined, undefined, 'MUT_VALUE');
    assert.equal(headers['media-user-token'], 'MUT_VALUE');
  });

  test('throws TOKEN_EXPIRED on HTTP 401', async () => {
    globalThis.fetch = async () => new Response('', { status: 401 });
    await assert.rejects(() => searchTrack('B', 'Q', 'TOKEN'), /TOKEN_EXPIRED/);
  });

  test('throws generic error on non-401 failure', async () => {
    globalThis.fetch = async () => new Response('', { status: 500 });
    await assert.rejects(() => searchTrack('B', 'Q', 'TOKEN'), /Search failed: 500/);
  });

  test('returns null when results are empty', async () => {
    globalThis.fetch = async () => mockSearchResponse([]);
    const result = await searchTrack('Z', 'Y', 'TOKEN');
    assert.equal(result, null);
  });

  test('returns null when best score is below threshold', async () => {
    globalThis.fetch = async () =>
      mockSearchResponse([
        makeTrack({
          name: 'Totally Unrelated Song',
          artistName: 'Different Artist',
          albumName: 'X',
          url: 'https://music.apple.com/vn/album/x/A1',
          durationInMillis: 100000,
        }),
      ]);
    const result = await searchTrack('Bohemian Rhapsody', 'Queen', 'TOKEN');
    assert.equal(result, null);
  });

  test('returns SearchResult with albumId from relationships', async () => {
    globalThis.fetch = async () => mockSearchResponse([makeTrack()]);
    const result = await searchTrack('Bohemian Rhapsody', 'Queen', 'TOKEN');
    assert.ok(result);
    assert.equal(result.albumId, '999001');
  });

  test('falls back to URL regex for albumId when relationships missing', async () => {
    const track = makeTrack();
    delete track.relationships;
    globalThis.fetch = async () => mockSearchResponse([track]);
    const result = await searchTrack('Bohemian Rhapsody', 'Queen', 'TOKEN');
    assert.ok(result);
    assert.equal(result.albumId, '999001');
  });

  test('duration filter prefers tracks within delta', async () => {
    const target = makeTrack({ durationInMillis: 200000 }, 'target');
    const wrong = makeTrack({ durationInMillis: 500000 }, 'wrong');
    globalThis.fetch = async () => mockSearchResponse([wrong, target]);
    const result = await searchTrack('Bohemian Rhapsody', 'Queen', 'TOKEN', 'vn', undefined, 200500);
    assert.ok(result);
    assert.equal(result.track.id, 'target');
  });

  test('duration filter only excludes when at least one track matches', async () => {
    const t1 = makeTrack({ durationInMillis: 500000 }, 't1');
    const t2 = makeTrack({ durationInMillis: 600000 }, 't2');
    globalThis.fetch = async () => mockSearchResponse([t1, t2]);
    const result = await searchTrack('Bohemian Rhapsody', 'Queen', 'TOKEN', 'vn', undefined, 100000);
    assert.ok(result, 'when no track matches duration, filter is bypassed and results are scored normally');
  });

  test('penalizes remix variants when query has no remix keyword', async () => {
    const remix = makeTrack({ name: 'Bohemian Rhapsody (Remix)' }, 'remix');
    const original = makeTrack({}, 'original');
    globalThis.fetch = async () => mockSearchResponse([remix, original]);
    const result = await searchTrack('Bohemian Rhapsody', 'Queen', 'TOKEN');
    assert.ok(result);
    assert.equal(result.track.id, 'original');
  });

  test('penalizes live versions when query has no live keyword', async () => {
    const live = makeTrack({ name: 'Bohemian Rhapsody (Live at Wembley)' }, 'live');
    const studio = makeTrack({}, 'studio');
    globalThis.fetch = async () => mockSearchResponse([live, studio]);
    const result = await searchTrack('Bohemian Rhapsody', 'Queen', 'TOKEN');
    assert.ok(result);
    assert.equal(result.track.id, 'studio');
  });

  test('does NOT penalize remix when user explicitly searches for remix', async () => {
    const remix = makeTrack({ name: 'Bohemian Rhapsody (Remix)' }, 'remix');
    globalThis.fetch = async () => mockSearchResponse([remix]);
    const result = await searchTrack('Bohemian Rhapsody Remix', 'Queen', 'TOKEN');
    assert.ok(result, 'remix should not be penalized when user query mentions remix');
    assert.equal(result.track.id, 'remix');
  });

  test('boosts exact album match when albumName provided', async () => {
    const matching = makeTrack({ albumName: 'A Night at the Opera' }, 'matching');
    const other = makeTrack({ albumName: 'Greatest Hits' }, 'other');
    globalThis.fetch = async () => mockSearchResponse([other, matching]);
    const result = await searchTrack(
      'Bohemian Rhapsody',
      'Queen',
      'TOKEN',
      'vn',
      'A Night at the Opera',
    );
    assert.ok(result);
    assert.equal(result.track.id, 'matching');
  });
});
