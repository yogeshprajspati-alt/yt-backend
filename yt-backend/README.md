# yt-music-backend

YouTube Music backend for Prachify — handles search and audio stream URL resolution.

## Endpoints

### `GET /search?q=query&limit=20`
Search YouTube Music for songs.

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": "yt-dQw4w9WgXcQ",
      "ytId": "dQw4w9WgXcQ",
      "title": "Never Gonna Give You Up",
      "artist": "Rick Astley",
      "cover": "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
      "duration": 212,
      "source": "youtube"
    }
  ]
}
```

### `GET /stream/:ytId`
Get the audio stream URL for a YouTube video ID.

**Response:**
```json
{
  "success": true,
  "url": "https://rr1---sn-....googlevideo.com/..."
}
```

Stream URLs expire in ~6 hours. Cache them for max 30 min (already handled server-side).

### `GET /health`
Health check.

## Deploy to Railway

1. Push this folder to a GitHub repo
2. Go to railway.app → New Project → Deploy from GitHub
3. Select the repo
4. Add env variable: `ALLOWED_ORIGIN=https://your-prachify-url.com`
5. Railway auto-detects Node.js and deploys

## Local Dev

```bash
npm install
node server.js
# Server at http://localhost:3001
```

## Usage in Prachify (later)

```js
// Search
const res = await fetch('https://your-backend.railway.app/search?q=the+weeknd');
const { data } = await res.json();

// Get stream URL before playing
const { url } = await fetch(`https://your-backend.railway.app/stream/${song.ytId}`).then(r => r.json());
// Pass url to Howler
```
