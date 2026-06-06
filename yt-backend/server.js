import express from 'express';
import cors from 'cors';
import { Innertube } from 'youtubei.js';

const app = express();
const PORT = process.env.PORT || 3001;

// ── CORS ──────────────────────────────────────────────────────────────────────
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
app.use(cors({ origin: ALLOWED_ORIGIN, methods: ['GET'] }));

// ── Piped instances ───────────────────────────────────────────────────────────
const PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://piped-api.garudalinux.org',
  'https://api.piped.yt',
  'https://pipedapi.tokhmi.xyz',
];

// ── Innertube singleton ───────────────────────────────────────────────────────
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
    throw new Error('Innertube cooling down after init failure');
  }
  ytInitializing = true;
  ytInitError = null;
  ytInitTime = Date.now();
  try {
    yt = await Innertube.create({ cache: false, generate_session_locally: true });
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
const sanitize    = (str, max = 200) => typeof str !== 'string' ? '' : str.trim().slice(0, max);

// ── Normalize search result ───────────────────────────────────────────────────
function normalizeYTSong(item) {
  try {
    const id = item.id;
    if (!isValidYtId(id)) return null;
    const title = sanitize(item.title?.text || item.title || '');
    if (!title) return null;
    const artist = sanitize(
      item.author?.name || item.artists?.map(a => a.name).join(', ') || 'Unknown'
    );
    const duration = typeof item.duration?.seconds === 'number'
      ? Math.max(0, Math.floor(item.duration.seconds)) : 0;
    const rawThumb = item.thumbnail?.[0]?.url || item.thumbnails?.[0]?.url;
    const cover = rawThumb || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
    return { id: `yt-${id}`, ytId: id, title, artist, album: '', cover, duration, source: 'youtube' };
  } catch { return null; }
}

// ── Rate limiting ─────────────────────────────────────────────────────────────
const ipHits = new Map();
const RATE_WINDOW = 60 * 1000;
const RATE_LIMIT  = 60;

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
      if (err.message?.includes('Innertube') || err.message?.includes('session')) resetYT(err.message);
      if (!res.headersSent) res.status(500).json({ error: 'Internal server error', message: err.message });
    });
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SEARCH — same query par alternate video dhundna bhi handle karta hai
// ─────────────────────────────────────────────────────────────────────────────
app.get('/search', rateLimit, asyncHandler(async (req, res) => {
  const q     = sanitize(req.query.q || '');
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 50);
  if (!q) return res.status(400).json({ error: 'Query "q" is required' });

  const youtube = await getYT();
  let results;
  try {
    results = await youtube.music.search(q, { type: 'song' });
  } catch (err) {
    resetYT('music.search failed: ' + err.message);
    throw err;
  }

  const songs = (results?.contents || [])
    .flatMap(s => s?.contents || [])
    .map(normalizeYTSong)
    .filter(Boolean)
    .slice(0, limit);

  res.json({ success: true, count: songs.length, data: songs });
}));

// ─────────────────────────────────────────────────────────────────────────────
// STREAM — Piped primary, Innertube fallback, alternate search fallback
// ─────────────────────────────────────────────────────────────────────────────

async function getStreamFromPiped(ytId) {
  for (const instance of PIPED_INSTANCES) {
    try {
      const res = await fetch(`${instance}/streams/${ytId}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(10000),
      });
      console.log(`[piped] ${instance} → ${res.status}`);
      if (!res.ok) continue;
      const data = await res.json();
      console.log(`[piped] ${instance} keys:`, Object.keys(data).join(', '));

      // Check if Piped itself says video is unavailable
      if (data.error) {
        console.warn(`[piped] ${instance} error:`, data.error);
        // Return the error type so we can handle it upstream
        return { pipedError: data.error };
      }

      const audioStreams = (data.audioStreams || [])
        .filter(s => s.url && s.bitrate)
        .sort((a, b) => b.bitrate - a.bitrate);

      if (!audioStreams.length) continue;

      const best = audioStreams[0];
      return { url: best.url, mimeType: best.mimeType || null, bitrate: best.bitrate || null, via: 'piped' };
    } catch (err) {
      console.warn(`[piped] ${instance} failed:`, err.message);
    }
  }
  return null;
}

async function getStreamFromInnertube(ytId) {
  const youtube = await getYT();
  let info;
  try {
    info = await youtube.getBasicInfo(ytId, 'TV_EMBEDDED');
  } catch (err) {
    resetYT('getBasicInfo failed: ' + err.message);
    throw err;
  }

  // Check playability status
  const status = info?.playability_status;
  if (status?.status === 'LOGIN_REQUIRED') return { blocked: true, reason: 'private' };
  if (status?.status === 'UNPLAYABLE')     return { blocked: true, reason: 'geo_restricted' };
  if (status?.status === 'ERROR')          return { blocked: true, reason: 'deleted' };

  const formats = info?.streaming_data?.adaptive_formats || [];
  const audioFormats = formats
    .filter(f => f.has_audio && !f.has_video && f.url)
    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

  const best = audioFormats[0];
  if (!best?.url) return null;

  return { url: best.url, mimeType: best.mime_type || null, bitrate: best.bitrate || null, via: 'innertube' };
}

// If original video is blocked, search for an alternate version of the same song
async function findAlternateStream(originalYtId) {
  console.log(`[stream] Searching alternate for ${originalYtId}...`);
  const youtube = await getYT();

  let videoInfo;
  try {
    videoInfo = await youtube.getBasicInfo(originalYtId);
  } catch {
    return null;
  }

  const title  = videoInfo?.basic_info?.title   || '';
  const author = videoInfo?.basic_info?.author  || '';
  if (!title) return null;

  // Search for the same song — different upload
  const query = `${title} ${author} audio`.trim();
  let results;
  try {
    results = await youtube.music.search(query, { type: 'song' });
  } catch {
    return null;
  }

  const candidates = (results?.contents || [])
    .flatMap(s => s?.contents || [])
    .map(normalizeYTSong)
    .filter(Boolean)
    .filter(s => s.ytId !== originalYtId) // skip the blocked one
    .slice(0, 5); // try up to 5 alternates

  for (const candidate of candidates) {
    console.log(`[stream] Trying alternate: ${candidate.ytId} — ${candidate.title}`);

    // Try Piped first for each candidate
    const pipedResult = await getStreamFromPiped(candidate.ytId);
    if (pipedResult && pipedResult.url) {
      return { ...pipedResult, alternateYtId: candidate.ytId, alternateTitle: candidate.title };
    }

    // Then Innertube
    const innerResult = await getStreamFromInnertube(candidate.ytId);
    if (innerResult && innerResult.url) {
      return { ...innerResult, alternateYtId: candidate.ytId, alternateTitle: candidate.title };
    }
  }

  return null; // no alternate found
}

app.get('/stream/:ytId', rateLimit, asyncHandler(async (req, res) => {
  const { ytId } = req.params;
  if (!isValidYtId(ytId)) return res.status(400).json({ error: 'Invalid YouTube video ID' });

  // Cache hit
  const cached = getCached(ytId);
  if (cached) return res.json({ success: true, cached: true, ...cached });

  // 1. Try Piped
  let result = await getStreamFromPiped(ytId);

  // Piped returned an error (private/geo/deleted) — skip straight to alternate
  const pipedBlocked = result && result.pipedError;

  if (!result || pipedBlocked) {
    // 2. Try Innertube to get a proper block reason
    console.warn(`[stream] Piped failed for ${ytId}, trying Innertube...`);
    const innerResult = await getStreamFromInnertube(ytId);

    if (innerResult?.blocked) {
      // Video is confirmed blocked — search for an alternate
      console.warn(`[stream] Video ${ytId} is ${innerResult.reason}, finding alternate...`);
      const alternate = await findAlternateStream(ytId);

      if (alternate) {
        setCache(ytId, alternate);
        return res.json({
          success:   true,
          cached:    false,
          isAlternate: true,
          reason:    innerResult.reason, // 'private' | 'geo_restricted' | 'deleted'
          ...alternate,
        });
      }

      // No alternate found at all
      return res.status(404).json({
        success: false,
        error:   'Video unavailable and no alternate found',
        reason:  innerResult.reason,
      });
    }

    if (innerResult?.url) {
      result = innerResult;
    }
  }

  if (!result || !result.url) {
    return res.status(404).json({
      success: false,
      error:   'No audio stream found — video may be private, deleted, or geo-restricted',
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
    pipedInstances: PIPED_INSTANCES.length,
  });
});

// ── 404 + global error ────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: `Not found: ${req.method} ${req.path}` }));
app.use((err, req, res, _next) => {
  console.error('[express error]', err.message);
  if (!res.headersSent) res.status(500).json({ error: 'Internal server error', message: err.message });
});

process.on('uncaughtException',  err    => { console.error('[uncaughtException]', err);    resetYT('uncaughtException'); });
process.on('unhandledRejection', reason => { console.error('[unhandledRejection]', reason); resetYT('unhandledRejection'); });

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[yt-backend] Running on port ${PORT}`);
  getYT().catch(err => console.error('[yt-backend] Warm-up failed:', err.message));
});
