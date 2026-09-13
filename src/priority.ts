import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export type Tier = 'priority' | 'standard';

export interface TokenClaims {
  iat: number;
  exp: number;
  jti: string;
  epoch: number;
}

const HEADER = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');

function sign(secret: string, data: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

export function signToken(secret: string, claims: TokenClaims): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const body = `${HEADER}.${payload}`;
  return `${body}.${sign(secret, body)}`;
}

export function verifyToken(
  secret: string,
  token: string,
  nowSec: number,
  expectedEpoch: number
): TokenClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const expected = sign(secret, `${h}.${p}`);
  const a = Buffer.from(s);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let claims: TokenClaims;
  try {
    claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof claims.exp !== 'number' || claims.exp <= nowSec) return null;
  if (claims.epoch !== expectedEpoch) return null;
  return claims;
}

export function resolveTierWith(
  secret: string | null,
  authHeader: string | null,
  nowSec: number,
  expectedEpoch: number
): Tier {
  if (!secret) return 'priority';
  if (!authHeader || !authHeader.startsWith('Bearer ')) return 'standard';
  const token = authHeader.slice('Bearer '.length).trim();
  return verifyToken(secret, token, nowSec, expectedEpoch) ? 'priority' : 'standard';
}

const SECRET = process.env.BLS_JWT_SECRET ?? null;
const TTL_SEC = parseInt(process.env.BLS_TOKEN_TTL_SEC || '10800', 10);
const EPOCH = parseInt(process.env.BLS_TOKEN_EPOCH || '1', 10);

export function gatingEnabled(): boolean {
  return SECRET !== null;
}

export function mintToken(now = Date.now()): string {
  if (!SECRET) throw new Error('BLS_JWT_SECRET not set');
  const nowSec = Math.floor(now / 1000);
  return signToken(SECRET, {
    iat: nowSec,
    exp: nowSec + TTL_SEC,
    jti: randomUUID(),
    epoch: EPOCH,
  });
}

export function resolveTier(authHeader: string | null, now = Date.now()): Tier {
  return resolveTierWith(SECRET, authHeader, Math.floor(now / 1000), EPOCH);
}
