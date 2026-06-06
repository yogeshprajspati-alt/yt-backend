import express from 'express';
import cors from 'cors';
import { Innertube } from 'youtubei.js';

const app = express();
const PORT = process.env.PORT || 3001;

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
app.use(cors({ origin: ALLOWED_ORIGIN, methods: ['GET'] }));

// ── Invidious instances (most reliable, separate from Piped) ──────────────────
const INVIDIOUS_INSTANCES = [
  'https://invidious.snopyta.org',
  'https://yewtu.be',
  'https://invidious.kavin.rocks',
  'https://inv.riverside.rocks',
  'https://invidious.nerdvpn.de',
  'https://invidious.lunar.icu',
];

// ── Piped instances (backup) ──────────────────────────────────────────────────
const PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://piped-api.garudalinux.org',
  'https://api.piped.yt',
  'https://pipedapi.tokhmi.xyz',
];

// ── Innertube singleton (search only) ────────────────────────────────────────
let yt = null;
let ytInitializing = false;
let ytInitError = null;
let ytInitTime = 0;
const YT_REINIT_COOLDOWN = 60 * 1000;

async function getYT() {
  if (yt) return yt;
  if (ytInitializing) {
    await new Promise(r => setTimeout(r, 2000));
    if (yt) return yt;
    throw new Error('Innertube init in progress');
  }
  if (ytInitError && Date.now() - ytInitTime < YT_REINIT_COOLDOWN) {
    throw new Error('Innertube cooling down');
  }
  ytInitializing = true;
  ytInitError = null;
  ytInitTime = Date.now();
  try {
    yt = await Innertube.create({ cache: false, generate_session_locally: true });
    console.log('[yt-backend] Innertube initialized');
    return yt;
  } catch (err) {
    yt = null; ytInitError = err;
    console.error('[yt-backend] Innertube init failed:', err.message);
    throw err;
  } finally {
    ytInitializing = false;
  }
}

function resetYT(reason) {
  console.warn('[yt-backend] Resetting Innertube:', reason);
  yt = null;
}

// ── LRU Cache ─────────────────────────────────────────────────────────────────
const CACHE_TTL = 30 * 60 * 1000;
const CACHE_MAX = 200;
const streamCache = new Map();

function getCached(key) {
  const entry = streamCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.time > CACHE_TTL) { streamCache.delete(key); return null; }
  streamCache.delete(key);
  streamCache.set(key, entry);
  return entry.data;
}

function setCache(key, data) {
  if (streamCache.size >= CACHE_MAX) streamCache.delete(streamCache.keys().next().value);
  streamCache.set(key, { data, time: Date.now() });
}

// ── Validation ────────────────────────────────────────────────────────────────
const YT_ID_REGEX = /^[a-zA-Z0-9_-]{11}$/;
const isValidYtId = id => typeof id === 'string' && YT_ID_REGEX.test(id);
const sanitize = (str, max = 200) => typeof str !== 'string' ? '' : str.trim().slice(0, max);

function normalizeYTSong(item) {
  try {
    const id = item.id;
    if (!isValidYtId(id)) return null;
    const title = sanitize(item.title?.text || item.title || '');
    if (!title) return null;
    const artist = sanitize(item.author?.name || item.artists?.map(a => a.name).join(', ') || 'Unknown');
    const duration = typeof item.duration?.seconds === 'number' ? Math.max(0, Math.floor(item.duration.seconds)) : 0;
    const rawThumb = item.thumbnail?.[0]?.url || item.thumbnails?.[0]?.url;
    const cover = rawThumb || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
    return { id: `yt-${id}`, ytId: id, title, artist, album: '', cover, duration, source: 'youtube' };
  } catch { return null; }
}

// ── Rate limiting ─────────────────────────────────────────────────────────────
const ipHits = new Map();
const RATE_WINDOW = 60 * 1000;
const RATE_LIMIT = 60;

function isRateLimited(ip) {
  const now = Date.now();
  let rec = ipHits.get(ip);
  if (!rec || now - rec.start > RATE_WINDOW) rec = { start: now, count: 0 };
  rec.count++;
  ipHits.set(ip, rec);
  return rec.count > RATE_LIMIT;
}
setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW;
  for (const [ip, rec] of ipHits) if (rec.start < cutoff) ipHits.delete(ip);
}, 5 * 60 * 1000);

function rateLimit(req, res, next) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  if (isRateLimited(ip)) return res.status(429).json({ error: 'Too many requests' });
  next();
}

function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(err => {
      console.error('[route error]', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'Internal server error', message: err.message });
    });
  };
}

// ── Search ────────────────────────────────────────────────────────────────────
app.get('/search', rateLimit, asyncHandler(async (req, res) => {
  const q = sanitize(req.query.q || '');
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 50);
  if (!q) return res.status(400).json({ error: 'Query "q" is required' });

  const youtube = await getYT();
  let results;
  try {
    results = await youtube.music.search(q, { type: 'song' });
  } catch (err) {
    resetYT('search failed: ' + err.message);
    throw err;
  }

  const songs = (results?.contents || [])
    .flatMap(s => s?.contents || [])
    .map(normalizeYTSong)
    .filter(Boolean)
    .slice(0, limit);

  res.json({ success: true, count: songs.length, data: songs });
}));

// ── Stream — Invidious → Piped → Error ───────────────────────────────────────

async function getStreamFromInvidious(ytId) {
  for (const instance of INVIDIOUS_INSTANCES) {
    try {
      const res = await fetch(`${instance}/api/v1/videos/${ytId}?fields=adaptiveFormats`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(10000),
      });
      console.log(`[invidious] ${instance} → ${res.status}`);
      if (!res.ok) continue;

      const data = await res.json();
      if (data.error) { console.warn(`[invidious] error:`, data.error); continue; }

      const audioFormats = (data.adaptiveFormats || [])
        .filter(f => f.type?.startsWith('audio/') && f.url)
        .sort((a, b) => (parseInt(b.bitrate) || 0) - (parseInt(a.bitrate) || 0));

      if (!audioFormats.length) continue;

      const best = audioFormats[0];
      console.log(`[invidious] Got stream from ${instance}`);
      return { url: best.url, mimeType: best.type || null, bitrate: parseInt(best.bitrate) || null, via: 'invidious' };
    } catch (err) {
      console.warn(`[invidious] ${instance} failed:`, err.message);
    }
  }
  return null;
}

async function getStreamFromPiped(ytId) {
  for (const instance of PIPED_INSTANCES) {
    try {
      const res = await fetch(`${instance}/streams/${ytId}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(10000),
      });
      console.log(`[piped] ${instance} → ${res.status}`);
      if (!res.ok) continue;

      const text = await res.text();
      let data;
      try { data = JSON.parse(text); }
      catch { console.warn(`[piped] ${instance} non-JSON response`); continue; }

      if (data.error) { console.warn(`[piped] ${instance} error:`, data.error); continue; }

      const audioStreams = (data.audioStreams || [])
        .filter(s => s.url && s.bitrate)
        .sort((a, b) => b.bitrate - a.bitrate);

      if (!audioStreams.length) continue;

      const best = audioStreams[0];
      console.log(`[piped] Got stream from ${instance}`);
      return { url: best.url, mimeType: best.mimeType || null, bitrate: best.bitrate || null, via: 'piped' };
    } catch (err) {
      console.warn(`[piped] ${instance} failed:`, err.message);
    }
  }
  return null;
}

app.get('/stream/:ytId', rateLimit, asyncHandler(async (req, res) => {
  const { ytId } = req.params;
  if (!isValidYtId(ytId)) return res.status(400).json({ error: 'Invalid YouTube video ID' });

  const cached = getCached(ytId);
  if (cached) return res.json({ success: true, cached: true, ...cached });

  // 1. Invidious (most reliable on cloud IPs)
  let result = await getStreamFromInvidious(ytId);

  // 2. Piped fallback
  if (!result) {
    console.warn(`[stream] Invidious failed for ${ytId}, trying Piped...`);
    result = await getStreamFromPiped(ytId);
  }

  if (!result) {
    return res.status(404).json({
      success: false,
      error: 'No audio stream found — video may be private, deleted, or geo-restricted',
    });
  }

  setCache(ytId, result);
  res.json({ success: true, cached: false, ...result });
}));

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    ytReady: !!yt,
    cacheSize: streamCache.size,
    uptime: Math.floor(process.uptime()),
    memory: process.memoryUsage().heapUsed,
  });
});

app.use((req, res) => res.status(404).json({ error: `Not found: ${req.method} ${req.path}` }));
app.use((err, req, res, _next) => {
  if (!res.headersSent) res.status(500).json({ error: 'Internal server error', message: err.message });
});

process.on('uncaughtException',  err    => { console.error('[uncaughtException]', err);    resetYT('uncaughtException'); });
process.on('unhandledRejection', reason => { console.error('[unhandledRejection]', reason); resetYT('unhandledRejection'); });

app.listen(PORT, () => {
  console.log(`[yt-backend] Running on port ${PORT}`);
  getYT().catch(err => console.error('[yt-backend] Warm-up failed:', err.message));
});
