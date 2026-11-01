import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildSearchQueries,
  cleanTitle,
  resolve,
  score,
  similarity,
  type SpotifyCandidate,
  type TrackInput,
} from '../src/spotifyMatcher.ts';

function loadLevitatingCandidates(): SpotifyCandidate[] {
  const body = JSON.parse(readFileSync(new URL('./fixtures/spotify/search-levitating.json', import.meta.url), 'utf8'));
  return body.data.searchV2.tracksV2.items.map((entry: any) => ({
    id: entry.item.data.id,
    title: entry.item.data.name,
    artists: entry.item.data.artists.items.map((a: any) => a.profile.name),
    album: entry.item.data.albumOfTrack.name,
    durationMs: entry.item.data.duration.totalMilliseconds,
  }));
}

const intro = (id: string, title: string, durationMs: number): SpotifyCandidate => ({
  id,
  title,
  artists: ['The xx'],
  album: 'xx',
  durationMs,
});

describe('cleanTitle', () => {
  test('strips official video/audio noise, feat suffixes, and redundant artist prefixes', () => {
    assert.equal(cleanTitle('Daft Punk - Get Lucky (Official Audio) ft. Pharrell Williams', 'Daft Punk'), 'Get Lucky');
    assert.equal(cleanTitle('Guess (Official Music Video) [4K]', 'Charli xcx'), 'Guess');
  });

  test('keeps version markers like Remix and Live', () => {
    assert.equal(cleanTitle('Levitating (The Blessed Madonna Remix)', 'Dua Lipa'), 'Levitating (The Blessed Madonna Remix)');
  });

  describe('edge cases', () => {
    test('strips Japanese bracket noise', () => {
      assert.equal(cleanTitle('夜に駆ける【MV】', 'YOASOBI'), '夜に駆ける');
    });

    test('empty title stays empty', () => {
      assert.equal(cleanTitle('', 'Anyone'), '');
    });

    test('keeps a dash split when the left side is not the artist', () => {
      assert.equal(cleanTitle('Intro - Live', 'The xx'), 'Intro - Live');
    });
  });
});

describe('buildSearchQueries', () => {
  test('generates deduplicated primary, album, and cleaned queries', () => {
    assert.deepEqual(
      buildSearchQueries({ title: 'Get Lucky (Official Audio)', artist: 'Daft Punk', album: 'Random Access Memories', durationMs: 248000 }),
      ['Get Lucky (Official Audio) Daft Punk', 'Get Lucky (Official Audio) Random Access Memories', 'Get Lucky Daft Punk']
    );
  });

  describe('edge cases', () => {
    test('no album and a clean title gives one query', () => {
      assert.deepEqual(buildSearchQueries({ title: 'Levitating', artist: 'Dua Lipa', album: '', durationMs: 0 }), [
        'Levitating Dua Lipa',
      ]);
    });

    test('blank title and artist give no queries', () => {
      assert.deepEqual(buildSearchQueries({ title: ' ', artist: ' ', album: '', durationMs: 0 }), []);
    });
  });

  describe('invariants', () => {
    test('the raw title is always the first query, never stripped', () => {
      for (const title of ['Levitating (Official Video)', 'Dua Lipa - Levitating', 'Levitating ft. DaBaby', 'Levitating Remix']) {
        assert.equal(buildSearchQueries({ title, artist: 'Dua Lipa', album: 'Future Nostalgia', durationMs: 0 })[0], `${title} Dua Lipa`);
      }
    });
  });
});

describe('similarity', () => {
  describe('edge cases', () => {
    test('diacritics fold away', () => {
      assert.equal(similarity('Beyoncé', 'Beyonce'), 1);
    });

    test('& and "and" are the same', () => {
      assert.equal(similarity('Charli & Billie', 'Charli and Billie'), 1);
    });

    test('empty side is 0', () => {
      assert.equal(similarity('', 'x'), 0);
    });
  });
});

describe('resolve', () => {
  test('matches the exact track and rejects remix/live version conflicts', () => {
    const source: TrackInput = { title: 'Levitating', artist: 'Dua Lipa', album: 'Future Nostalgia', durationMs: 203000 };
    const result = resolve(source, [
      { id: 'remix12345678901234567', title: 'Levitating (The Blessed Madonna Remix)', artists: ['Dua Lipa', 'The Blessed Madonna'], album: 'Club Future Nostalgia', durationMs: 203000 },
      { id: 'orig123456789012345678', title: 'Levitating', artists: ['Dua Lipa'], album: 'Future Nostalgia', durationMs: 203064 },
    ]);
    assert.equal(result.kind, 'matched');
    assert.equal(result.kind === 'matched' && result.track.candidate.id, 'orig123456789012345678');
  });

  test('breaks close ties using the album name when available', () => {
    const source: TrackInput = {
      title: 'Guess featuring billie eilish',
      artist: 'Charli xcx',
      album: "Brat and it's completely different but also still brat",
      durationMs: 145000,
    };
    const candidates: SpotifyCandidate[] = [
      { id: 'single1234567890123456', title: 'Guess featuring billie eilish', artists: ['Charli xcx', 'Billie Eilish'], album: 'Guess featuring billie eilish', durationMs: 145219 },
      { id: 'album12345678901234567', title: 'Guess featuring billie eilish', artists: ['Charli xcx', 'Billie Eilish'], album: "Brat and it's completely different but also still brat", durationMs: 145219 },
    ];
    const result = resolve(source, candidates);
    assert.equal(result.kind === 'matched' && result.track.candidate.id, 'album12345678901234567');
    assert.ok(score(source, candidates[1]).score >= 82);
  });

  test('picks an original Levitating from real Spotify results', () => {
    const result = resolve({ title: 'Levitating', artist: 'Dua Lipa', album: 'Future Nostalgia', durationMs: 204000 }, loadLevitatingCandidates());
    assert.equal(result.kind, 'matched');
    if (result.kind !== 'matched') return;
    assert.equal(result.track.candidate.title, 'Levitating');
    assert.equal(result.track.candidate.album, 'Future Nostalgia');
  });

  test('a remix request does not resolve to the original', () => {
    const result = resolve(
      { title: 'Levitating (The Blessed Madonna Remix)', artist: 'Dua Lipa', album: '', durationMs: 250000 },
      loadLevitatingCandidates()
    );
    if (result.kind === 'matched') assert.match(result.track.candidate.title, /Remix/);
  });

  describe('edge cases', () => {
    test('no candidates is notFound', () => {
      assert.equal(resolve({ title: 'Levitating', artist: 'Dua Lipa', album: '', durationMs: 0 }, []).kind, 'notFound');
    });

    test('empty title is notFound', () => {
      assert.equal(resolve({ title: '', artist: 'Dua Lipa', album: '', durationMs: 0 }, loadLevitatingCandidates()).kind, 'notFound');
    });

    test('duplicate candidate ids count once', () => {
      const c = intro('introxxxxxxxxxxxxxxxxx', 'Intro', 128000);
      assert.equal(resolve({ title: 'Intro', artist: 'The xx', album: '', durationMs: 128000 }, [c, c, c]).kind, 'matched');
    });

    test('wrong artist is notFound', () => {
      assert.equal(resolve({ title: 'Levitating', artist: 'Metallica', album: '', durationMs: 203000 }, loadLevitatingCandidates()).kind, 'notFound');
    });
  });

  describe('regressions', () => {
    test('regression: a different part number is a version conflict', () => {
      const source: TrackInput = { title: 'Intro (Pt. 1)', artist: 'The xx', album: 'xx', durationMs: 0 };
      assert.equal(resolve(source, [intro('part2xxxxxxxxxxxxxxxxx', 'Intro (Pt. 2)', 128000)]).kind, 'notFound');
      assert.equal(score(source, intro('part2xxxxxxxxxxxxxxxxx', 'Intro (Part II)', 128000)).versionConflict, true);
      assert.equal(score(source, intro('part1xxxxxxxxxxxxxxxxx', 'Intro, Pt. I', 128000)).versionConflict, false);
    });

    test('regression: Vol. and Chapter numbers are part numbers too', () => {
      const vol: TrackInput = { title: 'Mixtape Vol. 1', artist: 'The xx', album: '', durationMs: 0 };
      assert.equal(score(vol, intro('vol2xxxxxxxxxxxxxxxxxx', 'Mixtape Vol. 2', 1)).versionConflict, true);
      const chapter: TrackInput = { title: 'Story Chapter 3', artist: 'The xx', album: '', durationMs: 0 };
      assert.equal(score(chapter, intro('ch3xxxxxxxxxxxxxxxxxxx', 'Story Chapter III', 1)).versionConflict, false);
    });

    test('regression: an exact title beats a feat. version that is closer in duration', () => {
      for (const album of ['Future Nostalgia', '']) {
        const result = resolve({ title: 'Levitating', artist: 'Dua Lipa', album, durationMs: 203000 }, loadLevitatingCandidates());
        assert.equal(result.kind === 'matched' && result.track.candidate.title, 'Levitating', `album=${album}`);
      }
    });

    test('regression: duplicate copies of one recording prefer the source album over an EP', () => {
      for (const durationMs of [203000, 204000, 0]) {
        const result = resolve({ title: 'Levitating', artist: 'Dua Lipa', album: 'Future Nostalgia', durationMs }, loadLevitatingCandidates());
        assert.equal(result.kind === 'matched' && result.track.candidate.album, 'Future Nostalgia', `d=${durationMs}`);
      }
    });

    test('regression: a remaster is the same recording, not a version conflict', () => {
      const sun = (id: string, title: string): SpotifyCandidate => ({ id, title, artists: ['The Beatles'], album: 'Abbey Road', durationMs: 185000 });
      for (const [source, remote] of [
        ['Here Comes The Sun', 'Here Comes The Sun - Remastered 2009'],
        ['Here Comes The Sun (2019 Remaster)', 'Here Comes The Sun - Remastered 2019'],
        ['Here Comes The Sun (Remastered)', 'Here Comes The Sun'],
      ]) {
        const result = resolve({ title: source, artist: 'The Beatles', album: 'Abbey Road', durationMs: 185000 }, [sun('sunxxxxxxxxxxxxxxxxxxx', remote)]);
        assert.equal(result.kind, 'matched', `${source} vs ${remote}`);
      }
    });

    test('regression: unknown duration earns no duration score', () => {
      const candidate = intro('introxxxxxxxxxxxxxxxxx', 'Intro', 128000);
      const unknown = score({ title: 'Intro', artist: 'The xx', album: '', durationMs: 0 }, candidate);
      const known = score({ title: 'Intro', artist: 'The xx', album: '', durationMs: 128000 }, candidate);
      assert.equal(known.score - unknown.score, 15);
      for (const durationMs of [Number.NaN, -5000]) {
        assert.equal(score({ title: 'Intro', artist: 'The xx', album: '', durationMs }, candidate).score, unknown.score);
        assert.equal(resolve({ title: 'Intro', artist: 'The xx', album: '', durationMs }, [candidate]).kind, 'matched');
      }
    });
  });

  describe('invariants', () => {
    test('identical copies resolve to the earliest search result', () => {
      const source: TrackInput = { title: 'Levitating', artist: 'Dua Lipa', album: 'Future Nostalgia', durationMs: 203000 };
      const candidates = loadLevitatingCandidates();
      const first = resolve(source, candidates);
      assert.equal(first.kind === 'matched' && first.track.candidate.id, '39LLxExYz6ewLAcYrzQQyP');
      const reversed = resolve(source, [...candidates].reverse());
      assert.equal(reversed.kind === 'matched' && reversed.track.candidate.id, '1dI77VhaLcQSgQLSnIs03D');
    });

    test('the same input always gives the same result', () => {
      const source: TrackInput = { title: 'Levitating', artist: 'Dua Lipa', album: 'Future Nostalgia', durationMs: 203000 };
      assert.deepEqual(resolve(source, loadLevitatingCandidates()), resolve(source, loadLevitatingCandidates()));
    });

    test('score stays within 0..100', () => {
      const source: TrackInput = { title: 'Levitating', artist: 'Dua Lipa', album: '', durationMs: 203000 };
      for (const c of loadLevitatingCandidates()) {
        const s = score(source, c).score;
        assert.ok(s >= 0 && s <= 100, `${c.title}: ${s}`);
      }
    });
  });
});
