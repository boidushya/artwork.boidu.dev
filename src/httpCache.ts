const ARTWORK_CACHE = 'public, max-age=3600, s-maxage=86400, stale-if-error=604800';
const DEFINITIVE_ERROR_CACHE = 'public, max-age=3600, s-maxage=3600';

export function cacheControlFor(status: number, body: object): string | null {
  if (status >= 500) return 'no-store';
  if (status !== 200) return null;
  return 'error' in body ? DEFINITIVE_ERROR_CACHE : ARTWORK_CACHE;
}
