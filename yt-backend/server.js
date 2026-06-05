import express from 'express';
import cors from 'cors';
import { Innertube } from 'youtubei.js';

const app = express();
const PORT = process.env.PORT || 3001;

// ── CORS ─────────────────────────────────────────────────────────────────────
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

app.use(cors({
  origin: ALLOWED_ORIGIN,
  methods: ['GET'],
}));

// ── Innertube singleton w/ reconnect ─────────────────────────────────────────
let yt = null;
let ytInitializing = false;
let ytInitError = null;
let ytInitTime = 0;
const YT_REINIT_COOLDOWN = 60 * 1000; // 1 min between re-inits

async function getYT() {
  // If we have a healthy instance, return it
  if (yt) return yt;

  // If another request is already initializing, wait for it
  if (ytInitializing) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    if (yt) return yt;
    throw new Error('Innertube init in progress — try again shortly');
  }

  // Cooldown: if last init failed recently, don't hammer
  if (ytInitError && Date.now() - ytInitTime < YT_REINIT_COOLDOWN) {
    throw new Error('Innertube unavailable — cooling down after init failure');
  }

  ytInitializing = true;
  ytInitError = null;
  ytInitTime = Date.now();

  try {
    yt = await Innertube.create({
      cache: false,
      generate_session_locally: true,
    });
    console.log('[yt-backend] Innertube initialized');
    return yt;
  } catch (err) {
    yt = null;
    ytInitError = err;
    console.error('[yt-backend] Innertube init failed:', err.message);
    throw err;
  } finally {
    ytInitializing = false;
  }
}

// Reset singleton on unhandled errors so next request triggers reinit
function resetYT(reason) {
  console.warn('[yt-backend] Resetting Innertube singleton:', reason);
  yt = null;
}

// ── In-memory LRU cache ───────────────────────────────────────────────────────
const CACHE_TTL   = 30 * 60 * 1000; // 30 min
const CACHE_MAX   = 200;

const streamCache = new Map();

function getCached(key) {
  const entry = streamCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.time > CACHE_TTL) {
    streamCache.delete(key);
    return null;
  }
  // LRU: move to end
  streamCache.delete(key);
  streamCache.set(key, entry);
  return entry.data;
}

function setCache(key, data) {
  if (streamCache.size >= CACHE_MAX) {
    // Evict oldest (first inserted)
    streamCache.delete(streamCache.keys().next().value);
  }
  streamCache.set(key, { data, time: Date.now() });
}

// ── Input validation ──────────────────────────────────────────────────────────
const YT_ID_REGEX = /^[a-zA-Z0-9_-]{11}$/;

function isValidYtId(id) {
  return typeof id === 'string' && YT_ID_REGEX.test(id);
}

function sanitizeString(str, maxLen = 200) {
  if (typeof str !== 'string') return '';
  return str.trim().slice(0, maxLen);
}

// ── Normalize YT search result → song object ──────────────────────────────────
function normalizeYTSong(item) {
  try {
    const id = item.id;
    if (!isValidYtId(id)) return null;

    const title  = sanitizeString(item.title?.text || item.title || '');
    if (!title) return null;

    const artist   = sanitizeString(
      item.author?.name
        || item.artists?.map(a => a.name).join(', ')
        || 'Unknown'
    );
    const duration = typeof item.duration?.seconds === 'number'
      ? Math.max(0, Math.floor(item.duration.seconds))
      : 0;

    // Best thumbnail: prefer hqdefault over whatever YT gives us
    const rawThumb = item.thumbnail?.[0]?.url || item.thumbnails?.[0]?.url;
    const cover    = rawThumb || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;

    return {
      id:       `yt-${id}`,
      ytId:     id,
      title,
      artist,
      album:    '',
      cover,
      duration,
      source:   'youtube',
    };
  } catch {
    return null;
  }
}

// ── Rate limiting (simple in-process) ────────────────────────────────────────
const ipHits = new Map();
const RATE_WINDOW = 60 * 1000; // 1 min
const RATE_LIMIT  = 60;        // requests per window per IP

function isRateLimited(ip) {
  const now = Date.now();
  let rec = ipHits.get(ip);
  if (!rec || now - rec.start > RATE_WINDOW) {
    rec = { start: now, count: 0 };
  }
  rec.count++;
  ipHits.set(ip, rec);
  return rec.count > RATE_LIMIT;
}

// Clean up old IP records every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW;
  for (const [ip, rec] of ipHits) {
    if (rec.start < cutoff) ipHits.delete(ip);
  }
}, 5 * 60 * 1000);

// ── Rate limit middleware ─────────────────────────────────────────────────────
function rateLimit(req, res, next) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Too many requests — slow down' });
  }
  next();
}

// ── Async handler wrapper — catches thrown errors and sends 500 ───────────────
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(err => {
      console.error('[unhandled route error]', err.message);
      // If Innertube threw, mark it as dead so next request re-inits
      if (err.message?.includes('Innertube') || err.message?.includes('session')) {
        resetYT(err.message);
      }
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error', message: err.message });
      }
    });
  };
}

// ────────────────────────────────────────────────────────────────────────────
// GET /search?q=the+weeknd&limit=20
// ────────────────────────────────────────────────────────────────────────────
app.get('/search', rateLimit, asyncHandler(async (req, res) => {
  const q     = sanitizeString(req.query.q || '');
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 50);

  if (!q) {
    return res.status(400).json({ error: 'Query parameter "q" is required' });
  }

  const youtube = await getYT();

  let results;
  try {
    results = await youtube.music.search(q, { type: 'song' });
  } catch (err) {
    // Session may have expired — kill singleton so next call re-inits
    resetYT('music.search failed: ' + err.message);
    throw err;
  }

  const songs = (results?.contents || [])
    .flatMap(section => section?.contents || [])
    .map(normalizeYTSong)
    .filter(Boolean)
    .slice(0, limit);

  res.json({ success: true, count: songs.length, data: songs });
}));

// ────────────────────────────────────────────────────────────────────────────
// GET /stream/:ytId
// Returns { url } — expires in ~6hrs on YouTube's end
// ────────────────────────────────────────────────────────────────────────────
app.get('/stream/:ytId', rateLimit, asyncHandler(async (req, res) => {
  const { ytId } = req.params;

  if (!isValidYtId(ytId)) {
    return res.status(400).json({ error: 'Invalid YouTube video ID' });
  }

  // Cache hit
  const cached = getCached(ytId);
  if (cached) {
    return res.json({ success: true, cached: true, url: cached });
  }

  const youtube = await getYT();

  let info;
  try {
    info = await youtube.getBasicInfo(ytId, 'ANDROID');
  } catch (err) {
    resetYT('getBasicInfo failed: ' + err.message);
    throw err;
  }

  const formats      = info?.streaming_data?.adaptive_formats || [];
  const audioFormats = formats
    .filter(f => f.has_audio && !f.has_video && f.url)
    .sort((a, b) => {
      // Prefer higher bitrate
      const bitsA = a.bitrate || 0;
      const bitsB = b.bitrate || 0;
      return bitsB - bitsA;
    });

  const best = audioFormats[0];

  if (!best?.url) {
    // Could be a private/deleted video or geo-blocked
    return res.status(404).json({
      error: 'No audio stream found — video may be unavailable or geo-restricted',
    });
  }

  setCache(ytId, best.url);

  res.json({
    success:  true,
    cached:   false,
    url:      best.url,
    mimeType: best.mime_type || null,
    bitrate:  best.bitrate   || null,
  });
}));

// ────────────────────────────────────────────────────────────────────────────
// GET /health
// ────────────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status:    'ok',
    ytReady:   !!yt,
    cacheSize: streamCache.size,
    uptime:    Math.floor(process.uptime()),
    memory:    process.memoryUsage().heapUsed,
  });
});

// ── 404 handler ───────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error('[express error]', err.message);
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error', message: err.message });
  }
});

// ── Process-level safety nets ─────────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  resetYT('uncaughtException');
  // Don't exit — Railway will restart if truly broken
});

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
  resetYT('unhandledRejection');
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[yt-backend] Running on port ${PORT}`);
  // Warm up Innertube eagerly so first request doesn't pay the cost
  getYT().catch(err => {
    console.error('[yt-backend] Warm-up failed (will retry on first request):', err.message);
  });
});
