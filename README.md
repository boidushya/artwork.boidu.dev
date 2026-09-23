# Artwork API

Finds Apple Music album artwork, including animated artwork, for a song. Runs as a Node.js (Hono) service on Railway, backed by Postgres.

## Endpoints

```
GET /?s=<track title>&a=<artist>&al=<album>&d=<duration in seconds>
GET /?id=<numeric Apple Music album id>
GET /?url=<music.apple.com album url>
GET /health
```

Calling `/` without parameters returns a short usage guide.

### Search parameters

| Parameter | Alias | Description |
|-----------|-------|-------------|
| `s` | `song` | Track title as your source shows it. |
| `a` | `artist` | Artist name. The primary artist is enough. |
| `al` | `albumName` | Album name exactly as your source shows it. Leave it out when you do not know it. Never send view counts, dates or other metadata. |
| `d` | `duration` | Track duration in whole seconds. Used to pick the right version of a track. |
| `id` | | Numeric Apple Music album id. |
| `url` | | Apple Music album URL. |

## Responses

```json
{
  "name": "Nights",
  "artist": "Frank Ocean",
  "albumId": "1146195596",
  "static": "https://...mzstatic.com/.../1200x1200bb.jpg",
  "animated": "https://...m3u8",
  "animatedVertical": null,
  "videoUrl": "https://mvod.itunes.apple.com/...mp4",
  "videoUrlVertical": null
}
```

- `static`: 1200x1200 static artwork.
- `animated` / `animatedVertical`: HLS playlists for animated artwork, `null` when the album has none.
- `videoUrl` / `videoUrlVertical`: direct MP4 of the best quality stream, `null` when the album has none.

| Status | Meaning | Cache it? |
|--------|---------|-----------|
| `200` with artwork | Found. | Yes. |
| `200` with `error` | Definitive answer, for example "No matching tracks found" or "Album not found". | Yes, for a few days. |
| `429` | You are sending too many requests. | No. Slow down and cache on your side. |
| `502` / `503` | Temporary upstream failure. | No. Retry later. |

Artwork and definitive answers carry `Cache-Control` headers and are cached by the Railway CDN. Requests with an `Authorization` header always reach the service.

## Development

```bash
npm install
npm run dev:railway   # watch mode on localhost:3000
npm test
npm run build && npm start
```

`DATABASE_URL` must point at a Postgres database; migrations run on startup.

## Apple upstream tuning

| Variable | Default | Purpose |
|----------|---------|---------|
| `APPLE_MINT_RATE` / `APPLE_MINT_BURST` | `100` / `200` | Outbound rate for the minted token. |
| `APPLE_RATE` / `APPLE_BURST` | `1` / `5` | Outbound rate for the scraped web player token (search fallback lane). |
| `APPLE_RETRY_ATTEMPTS` | `3` | Attempts per Apple request on 429. |
| `APPLE_CIRCUIT_THRESHOLD` | `3` | Consecutive 429s before a circuit opens. |
| `APPLE_CIRCUIT_BASE_OPEN_MS` | `300000` | First circuit cooldown; later trips multiply it. |
| `MEDIA_USER_TOKEN` | unset | Apple Music user token, sent only when the scraped token stands in for a failed mint. |

Search tries the minted token on `amp-api-edge` first, then `amp-api`. If both are rate limited it retries with the scraped web player token in the `us` storefront. Results are cached in Postgres and served stale when Apple rate limits us.

## Priority gating (optional)

Better-lyrics-shaders traffic can win scarce Apple upstream capacity under load. A client mints a short-lived token and sends it as `Authorization: Bearer <token>`; token holders get the priority tier. When priority traffic is competing near Apple's quota, standard traffic sheds first (HTTP 503, safe to retry); when no priority traffic is present, standard uses the full capacity. Standard traffic is never forced into cache-only mode, and gating is a no-op until it is configured.

Two endpoints support minting:

```
GET  /challenge   returns a proof-of-work challenge (404 when the gate is disabled)
POST /mint        body { challenge, solution } -> { token } (401 on invalid, 404 when disabled)
```

Configuration (all optional; unset means the feature is a no-op and every request is priority):

| Variable | Default | Purpose |
|----------|---------|---------|
| `BLS_JWT_SECRET` | unset | HMAC signing key for the token. Unset disables gating (all traffic priority). |
| `BLS_TOKEN_TTL_SEC` | `10800` | Token lifetime in seconds (3 hours). |
| `BLS_TOKEN_EPOCH` | `1` | Bump to revoke every outstanding token immediately. |
| `BLS_ALTCHA_HMAC` | unset | HMAC secret for signing proof-of-work challenges. Unset disables the mint gate. |
| `BLS_POW_COST` | `5000` | Proof-of-work difficulty (PBKDF2 cost). Default solves in roughly 230ms median (450ms max) on modern hardware; raise server-side to increase abuse cost. |
| `BLS_POW_TTL_MS` | `120000` | Challenge validity window in milliseconds. |
| `APPLE_PRIORITY_RESERVE` | `2` | Outbound bucket tokens reserved for the priority tier. |
| `APPLE_STANDARD_MAX_WAIT_MS` | `1500` | Max queue wait for standard traffic before it sheds. |
| `APPLE_PRIORITY_WINDOW_MS` | `5000` | How long after a priority request standard keeps yielding the reserve. |
| `MINT_RATE_LIMIT` | `10` | Per-IP request limit for `/challenge` and `/mint`. |
