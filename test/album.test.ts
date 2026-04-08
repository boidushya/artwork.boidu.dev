import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fetchAlbum, parseAlbumIdFromUrl } from '../src/album.ts';
import type { AppleMusicAlbum } from '../src/types.ts';

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockAlbumResponse(album: Partial<AppleMusicAlbum>, status = 200): Response {
  const full: AppleMusicAlbum = {
    id: '12345',
    type: 'albums',
    attributes: {
      name: 'A Night at the Opera',
      artistName: 'Queen',
      artwork: {
        url: 'https://is1-ssl.mzstatic.com/image/.../{w}x{h}.jpg',
        width: 3000,
        height: 3000,
      },
    },
    ...album,
  };
  return new Response(JSON.stringify({ data: [full] }), { status });
}

describe('parseAlbumIdFromUrl', () => {
  test('extracts album id from canonical URL with name slug', () => {
    assert.equal(
      parseAlbumIdFromUrl('https://music.apple.com/us/album/a-night-at-the-opera/1234567890'),
      '1234567890',
    );
  });

  test('extracts album id from URL without name slug', () => {
    assert.equal(parseAlbumIdFromUrl('https://music.apple.com/us/album/1234567890'), '1234567890');
  });

  test('extracts album id when query string carries trackId', () => {
    assert.equal(
      parseAlbumIdFromUrl(
        'https://music.apple.com/us/album/album-name/1234567890?i=987654321',
      ),
      '1234567890',
    );
  });

  test('extracts album id from various storefront paths', () => {
    assert.equal(
      parseAlbumIdFromUrl('https://music.apple.com/vn/album/foo/55555'),
      '55555',
    );
    assert.equal(
      parseAlbumIdFromUrl('https://music.apple.com/gb/album/bar/77777'),
      '77777',
    );
  });

  test('returns null for non-album URL', () => {
    assert.equal(parseAlbumIdFromUrl('https://music.apple.com/us/artist/queen/1234'), null);
  });

  test('returns null for completely unrelated URL', () => {
    assert.equal(parseAlbumIdFromUrl('https://example.com/foo/bar'), null);
  });
});

describe('fetchAlbum', () => {
  test('builds URL with default storefront vn', async () => {
    let captured = '';
    globalThis.fetch = async (url) => {
      captured = String(url);
      return mockAlbumResponse({});
    };
    await fetchAlbum('12345', 'TOKEN');
    assert.match(captured, /^https:\/\/amp-api\.music\.apple\.com\/v1\/catalog\/vn\/albums\/12345/);
  });

  test('uses provided storefront in URL', async () => {
    let captured = '';
    globalThis.fetch = async (url) => {
      captured = String(url);
      return mockAlbumResponse({});
    };
    await fetchAlbum('12345', 'TOKEN', 'us');
    assert.match(captured, /\/catalog\/us\/albums\/12345/);
  });

  test('requests editorialVideo extension for animated artwork', async () => {
    let captured = '';
    globalThis.fetch = async (url) => {
      captured = String(url);
      return mockAlbumResponse({});
    };
    await fetchAlbum('12345', 'TOKEN');
    assert.match(captured, /extend=editorialVideo/);
  });

  test('always sends Authorization Bearer header', async () => {
    let headers: Record<string, string> = {};
    globalThis.fetch = async (_url, init) => {
      headers = (init?.headers as Record<string, string>) ?? {};
      return mockAlbumResponse({});
    };
    await fetchAlbum('12345', 'JWT_VALUE');
    assert.equal(headers['Authorization'], 'Bearer JWT_VALUE');
  });

  test('omits media-user-token header when mut not provided', async () => {
    let headers: Record<string, string> = {};
    globalThis.fetch = async (_url, init) => {
      headers = (init?.headers as Record<string, string>) ?? {};
      return mockAlbumResponse({});
    };
    await fetchAlbum('12345', 'TOKEN', 'vn');
    assert.equal(headers['media-user-token'], undefined);
  });

  test('includes media-user-token header when mut provided', async () => {
    let headers: Record<string, string> = {};
    globalThis.fetch = async (_url, init) => {
      headers = (init?.headers as Record<string, string>) ?? {};
      return mockAlbumResponse({});
    };
    await fetchAlbum('12345', 'TOKEN', 'vn', 'MUT_VALUE');
    assert.equal(headers['media-user-token'], 'MUT_VALUE');
  });

  test('throws TOKEN_EXPIRED on HTTP 401', async () => {
    globalThis.fetch = async () => new Response('', { status: 401 });
    await assert.rejects(() => fetchAlbum('12345', 'TOKEN'), /TOKEN_EXPIRED/);
  });

  test('returns null on HTTP 404', async () => {
    globalThis.fetch = async () => new Response('', { status: 404 });
    const result = await fetchAlbum('12345', 'TOKEN');
    assert.equal(result, null);
  });

  test('throws generic error on non-401 non-404 failure', async () => {
    globalThis.fetch = async () => new Response('', { status: 500 });
    await assert.rejects(() => fetchAlbum('12345', 'TOKEN'), /Album fetch failed: 500/);
  });

  test('returns null when response data array is empty', async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ data: [] }), { status: 200 });
    const result = await fetchAlbum('12345', 'TOKEN');
    assert.equal(result, null);
  });

  test('replaces {w}x{h} placeholders with 1200x1200 in static URL', async () => {
    globalThis.fetch = async () =>
      mockAlbumResponse({
        attributes: {
          name: 'X',
          artistName: 'Y',
          artwork: {
            url: 'https://cdn.example.com/img/{w}x{h}.jpg',
            width: 3000,
            height: 3000,
          },
        },
      });
    const result = await fetchAlbum('12345', 'TOKEN');
    assert.ok(result);
    assert.equal(result.staticUrl, 'https://cdn.example.com/img/1200x1200.jpg');
  });

  test('returns null animatedUrl when editorialVideo missing', async () => {
    globalThis.fetch = async () => mockAlbumResponse({});
    const result = await fetchAlbum('12345', 'TOKEN');
    assert.ok(result);
    assert.equal(result.animatedUrl, null);
  });

  test('extracts animatedUrl from editorialVideo.motionDetailSquare', async () => {
    globalThis.fetch = async () =>
      mockAlbumResponse({
        attributes: {
          name: 'X',
          artistName: 'Y',
          artwork: { url: 'https://x/{w}x{h}.jpg', width: 1, height: 1 },
          editorialVideo: {
            motionDetailSquare: { video: 'https://cdn.example.com/detail.m3u8' },
          },
        },
      });
    const result = await fetchAlbum('12345', 'TOKEN');
    assert.ok(result);
    assert.equal(result.animatedUrl, 'https://cdn.example.com/detail.m3u8');
  });

  test('falls back to motionSquareVideo1x1 when motionDetailSquare missing', async () => {
    globalThis.fetch = async () =>
      mockAlbumResponse({
        attributes: {
          name: 'X',
          artistName: 'Y',
          artwork: { url: 'https://x/{w}x{h}.jpg', width: 1, height: 1 },
          editorialVideo: {
            motionSquareVideo1x1: { video: 'https://cdn.example.com/fallback.m3u8' },
          },
        },
      });
    const result = await fetchAlbum('12345', 'TOKEN');
    assert.ok(result);
    assert.equal(result.animatedUrl, 'https://cdn.example.com/fallback.m3u8');
  });

  test('prefers motionDetailSquare over motionSquareVideo1x1 when both present', async () => {
    globalThis.fetch = async () =>
      mockAlbumResponse({
        attributes: {
          name: 'X',
          artistName: 'Y',
          artwork: { url: 'https://x/{w}x{h}.jpg', width: 1, height: 1 },
          editorialVideo: {
            motionDetailSquare: { video: 'https://cdn.example.com/preferred.m3u8' },
            motionSquareVideo1x1: { video: 'https://cdn.example.com/fallback.m3u8' },
          },
        },
      });
    const result = await fetchAlbum('12345', 'TOKEN');
    assert.ok(result);
    assert.equal(result.animatedUrl, 'https://cdn.example.com/preferred.m3u8');
  });

  test('returns name/artist/albumId from album attributes', async () => {
    globalThis.fetch = async () =>
      mockAlbumResponse({
        id: 'A99',
        attributes: {
          name: 'A Night at the Opera',
          artistName: 'Queen',
          artwork: { url: 'https://x/{w}x{h}.jpg', width: 1, height: 1 },
        },
      });
    const result = await fetchAlbum('A99', 'TOKEN');
    assert.ok(result);
    assert.equal(result.name, 'A Night at the Opera');
    assert.equal(result.artist, 'Queen');
    assert.equal(result.albumId, 'A99');
  });
});
