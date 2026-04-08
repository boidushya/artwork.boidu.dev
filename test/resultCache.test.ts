import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildSearchKey, computeAlbumTtl, TTL } from '../src/resultCache.ts';

describe('buildSearchKey', () => {
  test('returns the storefront verbatim (not normalized)', () => {
    const [storefront] = buildSearchKey({ storefront: 'VN', song: 'x', artist: 'y' });
    assert.equal(storefront, 'VN');
  });

  test('lowercases and trims song and artist', () => {
    const [, song, artist] = buildSearchKey({
      storefront: 'vn',
      song: '  Bohemian Rhapsody  ',
      artist: '  QUEEN  ',
    });
    assert.equal(song, 'bohemian rhapsody');
    assert.equal(artist, 'queen');
  });

  test('strips punctuation from song and artist', () => {
    const [, song, artist] = buildSearchKey({
      storefront: 'vn',
      song: "Don't Stop Me Now!",
      artist: 'AC/DC',
    });
    assert.equal(song, 'dont stop me now');
    assert.equal(artist, 'acdc');
  });

  test('collapses whitespace', () => {
    const [, song] = buildSearchKey({
      storefront: 'vn',
      song: 'Hello    World',
      artist: 'x',
    });
    assert.equal(song, 'hello world');
  });

  test('preserves song titles containing colons via normalization (no delimiter collision)', () => {
    const [, song] = buildSearchKey({
      storefront: 'vn',
      song: 'Song: Part 2',
      artist: 'x',
    });
    assert.equal(song, 'song part 2');
  });

  test('absent albumName becomes empty-string sentinel', () => {
    const [, , , album] = buildSearchKey({
      storefront: 'vn',
      song: 'x',
      artist: 'y',
    });
    assert.equal(album, '');
  });

  test('absent duration becomes -1 sentinel', () => {
    const [, , , , duration] = buildSearchKey({
      storefront: 'vn',
      song: 'x',
      artist: 'y',
    });
    assert.equal(duration, -1);
  });

  test('zero duration is preserved (NOT replaced with -1)', () => {
    const [, , , , duration] = buildSearchKey({
      storefront: 'vn',
      song: 'x',
      artist: 'y',
      duration: 0,
    });
    assert.equal(duration, 0);
  });

  test('present albumName is normalized', () => {
    const [, , , album] = buildSearchKey({
      storefront: 'vn',
      song: 'x',
      artist: 'y',
      albumName: '  A Night at the Opera!  ',
    });
    assert.equal(album, 'a night at the opera');
  });

  test('different filter shapes produce different keys (exact-match only)', () => {
    const a = buildSearchKey({ storefront: 'vn', song: 'x', artist: 'y' });
    const b = buildSearchKey({ storefront: 'vn', song: 'x', artist: 'y', albumName: 'z' });
    const c = buildSearchKey({ storefront: 'vn', song: 'x', artist: 'y', duration: 100 });
    assert.notDeepEqual(a, b);
    assert.notDeepEqual(a, c);
    assert.notDeepEqual(b, c);
  });

  test('case-equivalent inputs produce identical keys', () => {
    const a = buildSearchKey({ storefront: 'vn', song: 'Queen', artist: 'Queen' });
    const b = buildSearchKey({ storefront: 'vn', song: 'queen', artist: 'QUEEN' });
    assert.deepEqual(a, b);
  });
});

describe('computeAlbumTtl', () => {
  test('not_found row uses ALBUM_NOT_FOUND TTL (7 days)', () => {
    const ttl = computeAlbumTtl({ notFound: true, hasAnimated: false, videoUrl: null });
    assert.equal(ttl, TTL.ALBUM_NOT_FOUND);
    assert.equal(ttl, 7 * 86400);
  });

  test('not_found takes precedence over has_animated', () => {
    const ttl = computeAlbumTtl({ notFound: true, hasAnimated: true, videoUrl: 'x' });
    assert.equal(ttl, TTL.ALBUM_NOT_FOUND);
  });

  test('album exists but no animated artwork uses ALBUM_NO_ANIMATED TTL (7 days)', () => {
    const ttl = computeAlbumTtl({ notFound: false, hasAnimated: false, videoUrl: null });
    assert.equal(ttl, TTL.ALBUM_NO_ANIMATED);
    assert.equal(ttl, 7 * 86400);
  });

  test('animated exists but video resolution failed uses 1 day TTL', () => {
    const ttl = computeAlbumTtl({ notFound: false, hasAnimated: true, videoUrl: null });
    assert.equal(ttl, TTL.ALBUM_VIDEO_RESOLUTION_FAILED);
    assert.equal(ttl, 1 * 86400);
  });

  test('animated exists and video URL resolved uses 1 year TTL', () => {
    const ttl = computeAlbumTtl({
      notFound: false,
      hasAnimated: true,
      videoUrl: 'https://cdn.apple.com/video.mp4',
    });
    assert.equal(ttl, TTL.ALBUM_ANIMATED);
    assert.equal(ttl, 365 * 86400);
  });
});
