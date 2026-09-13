import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createChallenge, solveChallenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/pbkdf2';
import { createNonceGuard, verifyPowSolution } from '../src/mintGate.ts';

const HMAC = 'test-altcha-secret';

describe('createNonceGuard', () => {
  function clock(start = 1000) {
    let t = start;
    return { now: () => t, advance: (ms: number) => { t += ms; } };
  }

  test('first sight returns false, repeat returns true', () => {
    const g = createNonceGuard({ ttlMs: 1000 });
    assert.equal(g.seen('a'), false);
    assert.equal(g.seen('a'), true);
  });

  test('entry expires after ttl', () => {
    const c = clock();
    const g = createNonceGuard({ ttlMs: 1000, now: c.now });
    g.seen('a');
    c.advance(1001);
    assert.equal(g.seen('a'), false, 'expired id can be seen fresh again');
  });
});

describe('verifyPowSolution', () => {
  test('accepts a genuine solution once, rejects replay', async () => {
    const challenge = await createChallenge({
      algorithm: 'PBKDF2/SHA-256',
      cost: 100,
      deriveKey,
      hmacSignatureSecret: HMAC,
    });
    const solution = await solveChallenge({ challenge, deriveKey });
    assert.ok(solution, 'solver found a solution');
    assert.equal(await verifyPowSolution({ challenge, solution }), true);
    assert.equal(await verifyPowSolution({ challenge, solution }), false, 'replay rejected');
  });

  test('rejects a tampered solution', async () => {
    const challenge = await createChallenge({
      algorithm: 'PBKDF2/SHA-256',
      cost: 100,
      deriveKey,
      hmacSignatureSecret: HMAC,
    });
    const solution = await solveChallenge({ challenge, deriveKey });
    assert.ok(solution);
    const bad = { ...solution, counter: solution.counter + 1 };
    assert.equal(await verifyPowSolution({ challenge, solution: bad }), false);
  });

  test('regression: malformed challenge or solution returns false, does not throw', async () => {
    const malformed = {
      challenge: { a: 1 } as unknown as Parameters<typeof verifyPowSolution>[0]['challenge'],
      solution: { b: 2 },
    };
    assert.equal(await verifyPowSolution(malformed), false);
  });
});
