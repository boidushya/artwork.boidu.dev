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
