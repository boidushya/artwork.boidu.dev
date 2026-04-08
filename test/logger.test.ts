import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger, Tag } from '../src/logger.ts';

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;
const stripAnsi = (s: string) => s.replace(ANSI_PATTERN, '');

function capture() {
  const lines: string[] = [];
  return {
    lines,
    write: (line: string) => {
      lines.push(line);
    },
  };
}

const FIXED_NOW = new Date('2026-04-09T15:04:05.123Z');
const fixedNow = () => FIXED_NOW;

describe('createLogger — level filtering', () => {
  test('info level suppresses debug', () => {
    const cap = capture();
    const log = createLogger({ level: 'info', write: cap.write, now: fixedNow });
    log.debug(Tag.DB, 'hidden');
    log.info(Tag.DB, 'shown');
    assert.equal(cap.lines.length, 1);
    assert.match(stripAnsi(cap.lines[0]), /INFO/);
  });

  test('warn level suppresses debug and info', () => {
    const cap = capture();
    const log = createLogger({ level: 'warn', write: cap.write, now: fixedNow });
    log.debug(Tag.DB, 'd');
    log.info(Tag.DB, 'i');
    log.warn(Tag.DB, 'w');
    log.error(Tag.DB, 'e');
    assert.equal(cap.lines.length, 2);
    assert.match(stripAnsi(cap.lines[0]), /WARN/);
    assert.match(stripAnsi(cap.lines[1]), /ERROR/);
  });

  test('error level only emits errors', () => {
    const cap = capture();
    const log = createLogger({ level: 'error', write: cap.write, now: fixedNow });
    log.debug(Tag.DB, 'd');
    log.info(Tag.DB, 'i');
    log.warn(Tag.DB, 'w');
    log.error(Tag.DB, 'e');
    assert.equal(cap.lines.length, 1);
    assert.match(stripAnsi(cap.lines[0]), /ERROR/);
  });

  test('debug level emits all', () => {
    const cap = capture();
    const log = createLogger({ level: 'debug', write: cap.write, now: fixedNow });
    log.debug(Tag.DB, 'd');
    log.info(Tag.DB, 'i');
    log.warn(Tag.DB, 'w');
    log.error(Tag.DB, 'e');
    assert.equal(cap.lines.length, 4);
  });
});

describe('createLogger — output format', () => {
  test('includes timestamp, level, tag, and message', () => {
    const cap = capture();
    const log = createLogger({ level: 'debug', write: cap.write, now: fixedNow });
    log.info(Tag.CACHE, 'hit for album 123');
    const plain = stripAnsi(cap.lines[0]);
    assert.match(plain, /\d{2}:\d{2}:\d{2}\.\d{3}/, 'has HH:MM:SS.mmm time');
    assert.match(plain, /INFO/);
    assert.match(plain, /\[cache\]/);
    assert.match(plain, /hit for album 123/);
  });

  test('tag padding/colors applied in raw output', () => {
    const cap = capture();
    const log = createLogger({ level: 'debug', write: cap.write, now: fixedNow });
    log.info(Tag.CACHE_HIT, 'test');
    assert.match(cap.lines[0], ANSI_PATTERN, 'output contains ANSI codes');
  });

  test('sub-tags (cache:hit) work and inherit color family', () => {
    const cap = capture();
    const log = createLogger({ level: 'debug', write: cap.write, now: fixedNow });
    log.info(Tag.CACHE_HIT, 'search_index');
    log.info(Tag.CACHE_MISS, 'search_index');
    log.info(Tag.CACHE_UPSERT, 'search_index');
    assert.match(stripAnsi(cap.lines[0]), /\[cache:hit\]/);
    assert.match(stripAnsi(cap.lines[1]), /\[cache:miss\]/);
    assert.match(stripAnsi(cap.lines[2]), /\[cache:upsert\]/);
  });

  test('unknown tag still works with default color', () => {
    const cap = capture();
    const log = createLogger({ level: 'debug', write: cap.write, now: fixedNow });
    log.info('custom_tag', 'msg');
    assert.match(stripAnsi(cap.lines[0]), /\[custom_tag\]/);
  });
});

describe('createLogger — meta handling', () => {
  test('object meta renders as key=value pairs', () => {
    const cap = capture();
    const log = createLogger({ level: 'debug', write: cap.write, now: fixedNow });
    log.info(Tag.SEARCH, 'best match', { albumId: '123', score: '0.87' });
    const plain = stripAnsi(cap.lines[0]);
    assert.match(plain, /albumId=123/);
    assert.match(plain, /score=0\.87/);
  });

  test('Error meta renders name and message', () => {
    const cap = capture();
    const log = createLogger({ level: 'debug', write: cap.write, now: fixedNow });
    const err = new Error('db unreachable');
    log.error(Tag.DB, 'query failed', err);
    const plain = stripAnsi(cap.lines[0]);
    assert.match(plain, /query failed/);
    assert.match(plain, /Error: db unreachable/);
  });

  test('primitive meta renders inline', () => {
    const cap = capture();
    const log = createLogger({ level: 'debug', write: cap.write, now: fixedNow });
    log.info(Tag.HTTP, 'count', 42);
    const plain = stripAnsi(cap.lines[0]);
    assert.match(plain, /count 42/);
  });

  test('missing meta produces no trailing junk', () => {
    const cap = capture();
    const log = createLogger({ level: 'debug', write: cap.write, now: fixedNow });
    log.info(Tag.SERVER, 'up');
    const plain = stripAnsi(cap.lines[0]);
    assert.ok(plain.endsWith('up'), `expected to end with "up", got: ${plain}`);
  });

  test('string meta does not double-quote', () => {
    const cap = capture();
    const log = createLogger({ level: 'debug', write: cap.write, now: fixedNow });
    log.info(Tag.HTTP, 'path', '/api/x');
    const plain = stripAnsi(cap.lines[0]);
    assert.match(plain, /path \/api\/x/);
  });

  test('null value in object renders as "null"', () => {
    const cap = capture();
    const log = createLogger({ level: 'debug', write: cap.write, now: fixedNow });
    log.info(Tag.CACHE, 'x', { albumId: null });
    const plain = stripAnsi(cap.lines[0]);
    assert.match(plain, /albumId=null/);
  });
});

describe('createLogger — injected clock', () => {
  test('uses provided now() for timestamp', () => {
    const cap = capture();
    const t = new Date('2026-04-09T13:45:01.500Z');
    const log = createLogger({
      level: 'info',
      write: cap.write,
      now: () => t,
    });
    log.info(Tag.SERVER, 'up');
    const plain = stripAnsi(cap.lines[0]);
    const pad = (n: number, len = 2) => n.toString().padStart(len, '0');
    const expected = `${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}.${pad(t.getMilliseconds(), 3)}`;
    assert.match(plain, new RegExp(expected));
  });
});
