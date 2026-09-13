import { createChallenge, verifySolution } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/pbkdf2';

const HMAC = process.env.BLS_ALTCHA_HMAC ?? null;
const COST = parseInt(process.env.BLS_POW_COST || '5000', 10);
const CHALLENGE_TTL_MS = parseInt(process.env.BLS_POW_TTL_MS || '120000', 10);

export type PowChallenge = Awaited<ReturnType<typeof createChallenge>>;

export interface NonceGuard {
  seen(id: string): boolean;
  sweep(): void;
}

export function createNonceGuard(opts: { ttlMs: number; now?: () => number }): NonceGuard {
  const entries = new Map<string, number>();
  const now = opts.now ?? Date.now;
  return {
    seen(id: string): boolean {
      const t = now();
      const expiresAt = entries.get(id);
      if (expiresAt !== undefined && t < expiresAt) return true;
      entries.set(id, t + opts.ttlMs);
      return false;
    },
    sweep(): void {
      const t = now();
      for (const [id, expiresAt] of entries) {
        if (t >= expiresAt) entries.delete(id);
      }
    },
  };
}

const guard = createNonceGuard({ ttlMs: CHALLENGE_TTL_MS });
setInterval(() => guard.sweep(), 5 * 60 * 1000).unref();

export function mintGateEnabled(): boolean {
  return HMAC !== null;
}

export async function createPowChallenge(): Promise<PowChallenge> {
  if (!HMAC) throw new Error('BLS_ALTCHA_HMAC not set');
  return createChallenge({
    algorithm: 'PBKDF2/SHA-256',
    cost: COST,
    deriveKey,
    hmacSignatureSecret: HMAC,
    expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
  });
}

export async function verifyPowSolution(payload: {
  challenge: PowChallenge;
  solution: unknown;
}): Promise<boolean> {
  if (!HMAC) return false;
  let result: Awaited<ReturnType<typeof verifySolution>>;
  try {
    result = await verifySolution({
      challenge: payload.challenge,
      solution: payload.solution as Parameters<typeof verifySolution>[0]['solution'],
      deriveKey,
      hmacSignatureSecret: HMAC,
    });
  } catch {
    return false;
  }
  if (!result.verified || result.expired) return false;
  const { signature } = payload.challenge;
  if (signature === undefined || guard.seen(signature)) return false;
  return true;
}
