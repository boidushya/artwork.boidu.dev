import pg from 'pg';
import { log, Tag } from './logger';

const { Pool } = pg;

let pool: pg.Pool | null = null;
let missingUrlWarned = false;

export function getPool(): pg.Pool | null {
  if (pool) return pool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    if (!missingUrlWarned) {
      log.warn(Tag.DB, 'DATABASE_URL not set — running without cache');
      missingUrlWarned = true;
    }
    return null;
  }

  pool = new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  pool.on('error', (err) => {
    log.error(Tag.DB, 'idle client error', err);
  });

  log.info(Tag.DB, 'pool created', { max: 10 });
  return pool;
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params?: unknown[]
): Promise<pg.QueryResult<T> | null> {
  const p = getPool();
  if (!p) return null;
  const start = Date.now();
  try {
    const result = await p.query<T>(sql, params);
    log.debug(Tag.DB, 'query ok', { ms: Date.now() - start, rows: result.rowCount });
    return result;
  } catch (err) {
    log.error(Tag.DB, 'query failed', err);
    return null;
  }
}

const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS album_cache (
  storefront    TEXT        NOT NULL,
  album_id      TEXT        NOT NULL,
  name          TEXT,
  artist        TEXT,
  static_url    TEXT,
  animated_url  TEXT,
  video_url     TEXT,
  has_animated  BOOLEAN     NOT NULL,
  not_found     BOOLEAN     NOT NULL DEFAULT FALSE,
  expires_at    TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (storefront, album_id)
);

CREATE TABLE IF NOT EXISTS search_index (
  storefront    TEXT        NOT NULL,
  song          TEXT        NOT NULL,
  artist        TEXT        NOT NULL,
  album         TEXT        NOT NULL,
  duration      INTEGER     NOT NULL,
  album_id      TEXT,
  track_name    TEXT,
  track_artist  TEXT,
  expires_at    TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (storefront, song, artist, album, duration)
);

CREATE INDEX IF NOT EXISTS idx_album_expiry  ON album_cache  (expires_at);
CREATE INDEX IF NOT EXISTS idx_search_expiry ON search_index (expires_at);
`;

export async function runMigrations(): Promise<void> {
  const p = getPool();
  if (!p) return;
  log.info(Tag.DB, 'applying migrations');
  try {
    await p.query(MIGRATION_SQL);
    log.info(Tag.DB, 'migrations applied');
  } catch (err) {
    log.error(Tag.DB, 'migration failed', err);
    throw err;
  }
}
