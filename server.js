// ============================================================
//   Zylo Backend v12 — JSON Metadata Only
//   ✓ Streams from TMDB-Embed-API (movie | series)
//   ✓ TV Info from TMDB
//   ✓ TMDB Proxy
//   ✓ /api/proxy → redirect to CF Worker (bandwidth bachao)
//   ✓ HLS master playlist headers passthrough
// ============================================================

import express from "express";
import cors from "cors";

const app = express();
const PORT = Number(process.env.PORT || 3000);

const USER_AGENT =
  process.env.STREAM_USER_AGENT ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";

// ⭐⭐⭐ NAYA TMDB-EMBED-API URL ⭐⭐⭐
const TMDB_EMBED_API = "https://tmdb-embed-api-alhq.onrender.com";

// ⭐⭐⭐ CF WORKER URL (video proxy ke liye) ⭐⭐⭐
const CF_WORKER = "https://twilight-smoke-5ba9.adityaarya93506.workers.dev";

const TMDB_API_KEY = process.env.TMDB_API_KEY || "";

// ------------------------------------------------------------
// CORS
// ------------------------------------------------------------
app.use(cors({
  origin: "*",
  methods: ["GET", "HEAD", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Range", "Accept", "Origin", "Referer"],
  exposedHeaders: ["Accept-Ranges", "Content-Length", "Content-Range", "Content-Type", "ETag"],
  credentials: false,
}));
app.use(express.json({ limit: "100kb" }));
app.disable("x-powered-by");

// ------------------------------------------------------------
// TMDB CACHE + RATE LIMIT
// ------------------------------------------------------------
const tmdbCache = new Map();
const tmdbInflight = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_SIZE = 500;

let tokens = 35;
let lastRefill = Date.now();
const MAX_TOKENS = 35;
const REFILL_RATE = 35 / 10000;

async function acquireToken() {
  const now = Date.now();
  tokens = Math.min(MAX_TOKENS, tokens + (now - lastRefill) * REFILL_RATE);
  lastRefill = now;
  if (tokens < 1) {
    await new Promise((r) => setTimeout(r, Math.ceil((1 - tokens) / REFILL_RATE)));
    return acquireToken();
  }
  tokens -= 1;
}

function pruneCache() {
  if (tmdbCache.size <= MAX_CACHE_SIZE) return;
  const now = Date.now();
  for (const [key, val] of tmdbCache.entries()) {
    if (now - val.ts > CACHE_TTL_MS) tmdbCache.delete(key);
  }
}

// ------------------------------------------------------------
// TMDB PROXY — /api/tmdb/*
// ------------------------------------------------------------
app.get("/api/tmdb/*", async (req, res) => {
  if (!TMDB_API_KEY) return res.status(500).json({ error: "TMDB_API_KEY missing" });

  const tmdbPath = req.params[0];
  const query = new URLSearchParams(req.query);
  query.set("api_key", TMDB_API_KEY);
  const cacheKey = `${tmdbPath}?${query.toString()}`;

  const cached = tmdbCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return res.json(cached.data);

  if (tmdbInflight.has(cacheKey)) {
    try {
      const data = await tmdbInflight.get(cacheKey);
      return res.json(data);
    } catch (e) {
      return res.status(502).json({ error: e.message });
    }
  }

  const fetchPromise = (async () => {
    await acquireToken();
    const url = `https://api.themoviedb.org/3/${tmdbPath}?${query.toString()}`;
    const r = await fetch(url, { headers: { Accept: "application/json", "User-Agent": USER_AGENT } });
    if (!r.ok) throw new Error(`TMDB ${r.status}: ${(await r.text()).slice(0, 150)}`);
    const data = await r.json();
    tmdbCache.set(cacheKey, { data, ts: Date.now() });
    pruneCache();
    return data;
  })();

  tmdbInflight.set(cacheKey, fetchPromise);
  try {
    res.json(await fetchPromise);
  } catch (e) {
    res.status(502).json({ error: e.message });
  } finally {
    tmdbInflight.delete(cacheKey);
  }
});

// ------------------------------------------------------------
// STREAMS — from TMDB-Embed-API (JSON only)
// ------------------------------------------------------------
const LANG_NAMES = {
  hi: "Hindi", en: "English", ta: "Tamil", te: "Telugu", ml: "Malayalam",
  kn: "Kannada", bn: "Bengali", mr: "Marathi", pa: "Punjabi", ur: "Urdu",
  es: "Spanish", fr: "French", de: "German", ja: "Japanese", ko: "Korean",
  zh: "Chinese", ar: "Arabic", ru: "Russian", it: "Italian", pt: "Portuguese",
  fil: "Filipino", in_id: "Indonesian", ms: "Malay", sw: "Kiswahili", ha: "Hausa",
};

const LANG_ALIASES = {
  hin: "hi", hindi: "hi", eng: "en", english: "en",
  tam: "ta", tamil: "ta", tel: "te", telugu: "te",
  mal: "ml", malayalam: "ml", kan: "kn", kannada: "kn",
  ben: "bn", bengali: "bn", mar: "mr", marathi: "mr",
  pan: "pa", punjabi: "pa", urd: "ur", urdu: "ur",
  spa: "es", spanish: "es", fra: "fr", fre: "fr", french: "fr",
  deu: "de", ger: "de", german: "de", jpn: "ja", japanese: "ja",
  kor: "ko", korean: "ko", zho: "zh", chi: "zh", chinese: "zh",
  ara: "ar", arabic: "ar", rus: "ru", russian: "ru",
  ita: "it", italian: "it", por: "pt", portuguese: "pt",
};

function normalizeLang(code) {
  if (!code) return null;
  let v = String(code).trim().toLowerCase().replace(/_/g, "-");
  if (v.includes("-")) v = v.split("-")[0];
  if (LANG_ALIASES[v]) return LANG_ALIASES[v];
  if (LANG_NAMES[v]) return v;
  return null;
}

function parseResolution(value) {
  if (value == null) return null;
  const m = String(value).match(/(\d{3,4})/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 144 || n > 4320) return null;
  return n;
}

function isHlsUrl(url = "") {
  try {
    const u = new URL(url);
    const path = u.pathname.toLowerCase();
    return path.endsWith(".m3u8") || url.toLowerCase().includes("m3u8") || /\/hls(?:\/|$)/i.test(u.pathname);
  } catch {
    return String(url).toLowerCase().includes("m3u8");
  }
}

function parseHttpUrl(value) {
  if (!value || typeof value !== "string") throw new Error("Invalid URL");
  if (value.length > 8192) throw new Error("URL too long");
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only HTTP/HTTPS");
  return url;
}

// ------------------------------------------------------------
// ⭐⭐⭐ getStreams — TV ke liye "series" bhejna hai ⭐⭐⭐
// ------------------------------------------------------------
async function getStreams(tmdbId, type = "movie", season = null, episode = null) {
  if (!tmdbId) throw new Error("TMDB id required");

  // ⭐ TMDB-Embed-API "series" accept karta hai, "tv" nahi
  const apiType = type === "tv" ? "series" : "movie";

  let url = `${TMDB_EMBED_API}/api/streams/${apiType}/${encodeURIComponent(String(tmdbId))}`;
  if (apiType === "series" && season != null && episode != null) {
    url += `?season=${season}&episode=${episode}`;
  }

  console.log("[streams] Fetching:", url);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 90000);

  try {
    const r = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`TMDB-Embed ${r.status}: ${text.slice(0, 150)}`);

    const data = JSON.parse(text);
    const raw = Array.isArray(data.streams) ? data.streams : [];

    const streams = raw
      .map((s) => {
        const streamUrl = typeof s?.url === "string" ? s.url.trim() : "";
        if (!streamUrl) return null;

        let parsedUrl;
        try { parsedUrl = parseHttpUrl(streamUrl); } catch { return null; }

        const rawLang = s.lang ?? s.language ?? null;
        const lang = normalizeLang(rawLang);
        const resolution = parseResolution(s.quality ?? s.resolution ?? null);

        return {
          url: parsedUrl.href,
          type: isHlsUrl(parsedUrl.href) ? "hls" : "mp4",
          resolution,
          quality: s.quality != null ? String(s.quality) : resolution ? `${resolution}p` : "Auto",
          label: s.title || s.name || (resolution ? `${resolution}p` : "Auto"),
          provider: s.provider != null ? String(s.provider) : "unknown",
          lang,
          headers: s.headers && typeof s.headers === "object" ? s.headers : {},
          subtitles: Array.isArray(s.subtitles)
            ? s.subtitles
                .map((sub) => {
                  if (!sub?.url) return null;
                  try {
                    const subUrl = parseHttpUrl(String(sub.url));
                    return {
                      url: subUrl.href,
                      lang: normalizeLang(sub.lang || sub.language) || "und",
                      label: sub.label || sub.name || sub.lang || "Subtitle",
                    };
                  } catch { return null; }
                })
                .filter(Boolean)
            : [],
        };
      })
      .filter(Boolean);

    // Sort: HLS first, then resolution desc
    streams.sort((a, b) => {
      if (a.type !== b.type) return a.type === "hls" ? -1 : 1;
      return (b.resolution || 0) - (a.resolution || 0);
    });

    const langSet = new Set();
    streams.forEach((s) => { if (s.lang) langSet.add(s.lang); });
    const languages = Array.from(langSet).map((code) => ({
      code,
      name: LANG_NAMES[code] || code.toUpperCase(),
    }));

    const subMap = new Map();
    streams.forEach((s) => {
      (s.subtitles || []).forEach((sub) => {
        if (!sub?.url) return;
        const key = `${sub.lang || "und"}|${sub.url}`;
        if (!subMap.has(key)) {
          subMap.set(key, {
            lang: sub.lang || "und",
            url: sub.url,
            label: sub.label || LANG_NAMES[sub.lang] || sub.lang || "Subtitle",
          });
        }
      });
    });

    return {
      ok: streams.length > 0,
      title: data.title || null,
      streams,
      languages,
      subtitles: Array.from(subMap.values()),
      providers: data.providerTimings || data.providers || {},
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

// ------------------------------------------------------------
// /api/streams
// ------------------------------------------------------------
app.get("/api/streams", async (req, res) => {
  try {
    const tmdbId = String(req.query.id || "").trim();
    if (!tmdbId) return res.status(400).json({ ok: false, streams: [], error: "id required" });

    const type = req.query.type === "tv" ? "tv" : "movie";
    const season = req.query.s != null && /^\d+$/.test(String(req.query.s)) ? Number(req.query.s) : null;
    const episode = req.query.e != null && /^\d+$/.test(String(req.query.e)) ? Number(req.query.e) : null;

    const data = await getStreams(tmdbId, type, season, episode);
    res.json(data);
  } catch (e) {
    console.error("[streams]", e?.message || e);
    res.status(200).json({ ok: false, streams: [], error: e?.message || "Streams unavailable" });
  }
});

// ------------------------------------------------------------
// /api/debug/streams
// ------------------------------------------------------------
app.get("/api/debug/streams", async (req, res) => {
  try {
    const data = await getStreams(req.query.id || "27205", req.query.type || "movie");
    res.json({
      ok: true,
      title: data.title,
      streamCount: data.streams.length,
      languages: data.languages,
      sampleStreams: data.streams.slice(0, 3),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "Debug failed" });
  }
});

// ------------------------------------------------------------
// /api/tv-info
// ------------------------------------------------------------
app.get("/api/tv-info", async (req, res) => {
  const tmdbId = String(req.query.id || "").trim();
  if (!tmdbId) return res.status(400).json({ error: "id required" });
  if (!TMDB_API_KEY) return res.status(500).json({ error: "TMDB_API_KEY missing" });

  try {
    const detailsUrl = new URL(`https://api.themoviedb.org/3/tv/${encodeURIComponent(tmdbId)}`);
    detailsUrl.searchParams.set("api_key", TMDB_API_KEY);
    detailsUrl.searchParams.set("language", "en-US");

    const detailsRes = await fetch(detailsUrl.href, {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
    });
    const details = await detailsRes.json();
    if (!detailsRes.ok || details.success === false) throw new Error(details.status_message || "TMDB error");

    const validSeasons = Array.isArray(details.seasons) ? details.seasons.filter((s) => Number(s.season_number) > 0) : [];
    const seasonResults = await Promise.all(
      validSeasons.map(async (season) => {
        try {
          const seasonUrl = new URL(
            `https://api.themoviedb.org/3/tv/${encodeURIComponent(tmdbId)}/season/${encodeURIComponent(season.season_number)}`
          );
          seasonUrl.searchParams.set("api_key", TMDB_API_KEY);
          seasonUrl.searchParams.set("language", "en-US");
          const r = await fetch(seasonUrl.href, { headers: { Accept: "application/json", "User-Agent": USER_AGENT } });
          if (!r.ok) return { episodes: [] };
          return await r.json();
        } catch { return { episodes: [] }; }
      })
    );

    const seasons = validSeasons.map((season, index) => ({
      season: season.season_number,
      name: season.name,
      episodes: Array.isArray(seasonResults[index]?.episodes)
        ? seasonResults[index].episodes.map((episode) => ({
            episode: episode.episode_number,
            name: episode.name,
            overview: episode.overview,
            still_path: episode.still_path,
            air_date: episode.air_date,
          }))
        : [],
    }));

    res.json({ id: details.id, name: details.name, seasons });
  } catch (e) {
    console.error("[tv-info]", e?.message || e);
    res.status(500).json({ error: e?.message || "TV info failed" });
  }
});

// ------------------------------------------------------------
// ⭐ VIDEO PROXY — Redirect to CF Worker (bandwidth bachao)
// ------------------------------------------------------------
app.get("/api/proxy", (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send("url required");

  const params = new URLSearchParams();
  params.set("url", String(url));
  if (req.query.headers) params.set("headers", String(req.query.headers));
  if (req.query.referer) params.set("referer", String(req.query.referer));

  return res.redirect(302, `${CF_WORKER}/api/proxy?${params.toString()}`);
});

app.head("/api/proxy", (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send("url required");

  const params = new URLSearchParams();
  params.set("url", String(url));
  if (req.query.headers) params.set("headers", String(req.query.headers));
  if (req.query.referer) params.set("referer", String(req.query.referer));

  return res.redirect(302, `${CF_WORKER}/api/proxy?${params.toString()}`);
});

// ------------------------------------------------------------
// Health
// ------------------------------------------------------------
app.get("/", (_req, res) => res.send("Zylo Backend v12 ✅"));
app.get("/api/health", (_req, res) =>
  res.json({
    ok: true,
    version: "v12",
    tmdb: !!TMDB_API_KEY,
    embed: TMDB_EMBED_API,
    cfWorker: CF_WORKER,
    cache: tmdbCache.size,
    ts: Date.now(),
  })
);

app.use((req, res) => res.status(404).json({ ok: false, error: "Not found" }));

app.listen(PORT, () => {
  console.log(`✅ Zylo Backend v12 running on port ${PORT}`);
  console.log(`   TMDB Embed API: ${TMDB_EMBED_API}`);
  console.log(`   CF Worker: ${CF_WORKER}`);
  console.log(`   TMDB Key: ${TMDB_API_KEY ? "✅ Set" : "❌ Missing"}`);
});
