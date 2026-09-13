# Artwork API

A Cloudflare Worker that fetches animated album artwork.

## API Endpoints

### Search by song + artist
```
GET /?s=song&a=artist
GET /?song=song&artist=artist
```

### Direct album ID
```
GET /?id=albumId
```

### Album URL
```
GET /?url=https://music.apple.com/us/album/album-name/1234567890
```

### Health check
```
GET /health
```

## Response Format

```json
{
  "name": "Album Name",
  "artist": "Artist Name",
  "albumId": "123456",
  "static": "https://...mzstatic.com/.../1200x1200.jpg",
  "animated": "https://...m3u8",
  "videoUrl": "https://...segment.mp4"
}
```

- `static`: High-resolution static album artwork (1200x1200)
- `animated`: M3U8 playlist URL for animated artwork (null if not available)
- `videoUrl`: Direct video segment URL for highest quality (null if not available)

## Development

```bash
npm install
npm run dev
```

## Deployment

1. Create the KV namespace (if not already done):
   ```bash
   npx wrangler kv:namespace create CACHE
   npx wrangler kv:namespace create CACHE --preview
   ```

2. Update `wrangler.toml` with the KV namespace IDs

3. Deploy:
   ```bash
   npm run deploy
   ```

## Query Parameters

| Parameter | Aliases | Description |
|-----------|---------|-------------|
| `s` | `song` | Song name for search |
| `a` | `artist` | Artist name for search |
| `id` | - | Direct album ID |
| `url` | - | Full album URL |
| `storefront` | - | Country code (default: `us`) |

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
