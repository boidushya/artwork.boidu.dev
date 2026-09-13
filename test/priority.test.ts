import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  signToken,
  verifyToken,
  resolveTierWith,
  type TokenClaims,
} from '../src/priority.ts';

const SECRET = 'test-secret-key';

function claims(overrides: Partial<TokenClaims> = {}): TokenClaims {
  return { iat: 1000, exp: 4600, jti: 'abc', epoch: 1, ...overrides };
}

describe('signToken / verifyToken', () => {
  test('round-trips valid claims', () => {
    const token = signToken(SECRET, claims());
    const out = verifyToken(SECRET, token, 2000, 1);
    assert.deepEqual(out, claims());
  });

  test('rejects a tampered payload', () => {
    const token = signToken(SECRET, claims());
    const [h, , s] = token.split('.');
    const forged = Buffer.from(JSON.stringify(claims({ epoch: 999 }))).toString('base64url');
    assert.equal(verifyToken(SECRET, `${h}.${forged}.${s}`, 2000, 1), null);
  });

  test('rejects the wrong secret', () => {
    const token = signToken(SECRET, claims());
    assert.equal(verifyToken('other-secret', token, 2000, 1), null);
  });

  test('rejects an expired token', () => {
    const token = signToken(SECRET, claims({ exp: 1500 }));
    assert.equal(verifyToken(SECRET, token, 2000, 1), null);
  });

  test('rejects a stale epoch', () => {
    const token = signToken(SECRET, claims({ epoch: 1 }));
    assert.equal(verifyToken(SECRET, token, 2000, 2), null);
  });

  test('rejects malformed input', () => {
    assert.equal(verifyToken(SECRET, 'not-a-token', 2000, 1), null);
    assert.equal(verifyToken(SECRET, 'a.b', 2000, 1), null);
    assert.equal(verifyToken(SECRET, '', 2000, 1), null);
  });
});

describe('resolveTierWith', () => {
  test('gating disabled (null secret) is always priority', () => {
    assert.equal(resolveTierWith(null, null, 2000, 1), 'priority');
    assert.equal(resolveTierWith(null, 'Bearer whatever', 2000, 1), 'priority');
  });

  test('no token is standard when gating enabled', () => {
    assert.equal(resolveTierWith(SECRET, null, 2000, 1), 'standard');
    assert.equal(resolveTierWith(SECRET, 'Basic x', 2000, 1), 'standard');
  });

  test('valid Bearer token is priority', () => {
    const token = signToken(SECRET, claims());
    assert.equal(resolveTierWith(SECRET, `Bearer ${token}`, 2000, 1), 'priority');
  });

  test('invalid Bearer token is standard', () => {
    const token = signToken(SECRET, claims({ exp: 1500 }));
    assert.equal(resolveTierWith(SECRET, `Bearer ${token}`, 2000, 1), 'standard');
  });
});
