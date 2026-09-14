// ============================================================
//   Zylo Backend v10 — TMDB Proxy + Cache + Streams
//   ✓ TMDB API key server-side only (never exposed)
//   ✓ In-memory cache (5 min) → 70 requests → 5 requests
//   ✓ Request coalescing
//   ✓ Rate limiting protection
//   ✓ Stream proxy (HLS + MP4)
// ============================================================

import express from "express";
import cors from "cors";

const app = express();

const PORT = Number(process.env.PORT || 3000);

const USER_AGENT =
  process.env.STREAM_USER_AGENT ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const TMDB_EMBED_API =
  process.env.TMDB_EMBED_API ||
  "https://tmdb-embed-api-c1oy.onrender.com";

const TMDB_API_KEY = process.env.TMDB_API_KEY || "";

// ------------------------------------------------------------
// CORS
// ------------------------------------------------------------
app.use(
  cors({
    origin: "*",
    methods: ["GET", "HEAD", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Range", "Accept", "Origin", "Referer"],
    exposedHeaders: [
      "Accept-Ranges",
      "Content-Length",
      "Content-Range",
      "Content-Type",
      "ETag",
    ],
    credentials: false,
  })
);
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
  const elapsed = now - lastRefill;
  tokens = Math.min(MAX_TOKENS, tokens + elapsed * REFILL_RATE);
  lastRefill = now;

  if (tokens < 1) {
    const waitMs = Math.ceil((1 - tokens) / REFILL_RATE);
    await new Promise((r) => setTimeout(r, waitMs));
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
  if (tmdbCache.size > MAX_CACHE_SIZE) {
    const entries = Array.from(tmdbCache.entries()).sort((a, b) => a[1].ts - b[1].ts);
    const toRemove = entries.slice(0, entries.length - MAX_CACHE_SIZE);
    toRemove.forEach(([k]) => tmdbCache.delete(k));
  }
}

// ------------------------------------------------------------
// TMDB PROXY ROUTE
// ------------------------------------------------------------
app.get("/api/tmdb/*", async (req, res) => {
  if (!TMDB_API_KEY) {
    return res.status(500).json({ error: "TMDB_API_KEY not configured on server" });
  }

  const tmdbPath = req.params[0];
  const query = new URLSearchParams(req.query);
  query.set("api_key", TMDB_API_KEY);

  const cacheKey = `${tmdbPath}?${query.toString()}`;

  const cached = tmdbCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return res.json(cached.data);
  }

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
    const r = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
    });

    if (!r.ok) {
      const text = await r.text();
      throw new Error(`TMDB ${r.status}: ${text.slice(0, 150)}`);
    }

    const data = await r.json();
    tmdbCache.set(cacheKey, { data, ts: Date.now() });
    pruneCache();
    return data;
  })();

  tmdbInflight.set(cacheKey, fetchPromise);

  try {
    const data = await fetchPromise;
    res.json(data);
  } catch (e) {
    console.error("[tmdb-proxy]", e.message);
    res.status(502).json({ error: e.message });
  } finally {
    tmdbInflight.delete(cacheKey);
  }
});

// ------------------------------------------------------------
// STREAMS
// ------------------------------------------------------------
const LANG_NAMES = {
  hi: "Hindi", en: "English", ta: "Tamil", te: "Telugu", ml: "Malayalam",
  kn: "Kannada", bn: "Bengali", mr: "Marathi", pa: "Punjabi", ur: "Urdu",
  es: "Spanish", fr: "French", de: "German", ja: "Japanese", ko: "Korean",
  zh: "Chinese", ar: "Arabic", ru: "Russian", it: "Italian", pt: "Portuguese",
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
  let value = String(code).trim().toLowerCase().replace(/_/g, "-");
  if (value.includes("-")) value = value.split("-")[0];
  if (LANG_ALIASES[value]) return LANG_ALIASES[value];
  if (LANG_NAMES[value]) return value;
  return null;
}

function parseResolution(value) {
  if (value == null) return null;
  const match = String(value).match(/(\d{3,4})/);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isFinite(n)) return null;
  if (n < 144 || n > 4320) return null;
  return n;
}

function isHlsUrl(url = "") {
  try {
    const u = new URL(url);
    const path = u.pathname.toLowerCase();
    if (path.endsWith(".m3u8")) return true;
    const content = `${u.pathname}${u.search}`.toLowerCase();
    return (
      content.includes(".m3u8") ||
      content.includes("m3u8") ||
      /\/hls(?:\/|$)/i.test(u.pathname)
    );
  } catch {
    return String(url).toLowerCase().includes("m3u8");
  }
}

function parseHttpUrl(value) {
  if (!value || typeof value !== "string") throw new Error("Invalid URL");
  if (value.length > 8192) throw new Error("URL too long");
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only HTTP/HTTPS URLs are allowed");
  }
  return url;
}

function isPrivateOrLocalHostname(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host === "::1" ||
    host === "0.0.0.0"
  ) return true;
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const parts = ipv4.slice(1).map(Number);
    const [a, b] = parts;
    if (a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a >= 224) return true;
  }
  return false;
}

function validateUpstreamUrl(value) {
  const url = parseHttpUrl(value);
  if (isPrivateOrLocalHostname(url.hostname)) {
    throw new Error(`Upstream host not allowed: ${url.hostname}`);
  }
  return url;
}

async function getStreams(tmdbId, type = "movie", season = null, episode = null) {
  if (!tmdbId) throw new Error("TMDB id required");
  const apiType = type === "tv" ? "series" : "movie";
  let url = `${TMDB_EMBED_API}/api/streams/${apiType}/${encodeURIComponent(String(tmdbId))}`;
  if (apiType === "series" && season != null && episode != null) {
    url += `?season=${season}&episode=${episode}`;
  }

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
          quality: s.quality != null ? String(s.quality) : resolution ? `${resolution}p` : null,
          label: s.title || (resolution ? `${resolution}p` : "Auto"),
          provider: s.provider != null ? String(s.provider) : "unknown",
          lang,
          subtitles: Array.isArray(s.subtitles)
            ? s.subtitles.map((sub) => {
                if (!sub?.url) return null;
                try {
                  const subUrl = parseHttpUrl(String(sub.url));
                  return {
                    url: subUrl.href,
                    lang: normalizeLang(sub.lang || sub.language) || "und",
                    label: sub.label || sub.name || sub.lang || "Subtitle",
                  };
                } catch { return null; }
              }).filter(Boolean)
            : [],
        };
      })
      .filter(Boolean);

    const langBestMap = new Map();
    for (const stream of streams) {
      if (!stream.lang) continue;
      const existing = langBestMap.get(stream.lang);
      if (!existing || (stream.resolution || 0) > (existing.resolution || 0)) {
        langBestMap.set(stream.lang, stream);
      }
    }
    const urlToLangs = new Map();
    for (const [langCode, stream] of langBestMap.entries()) {
      if (!urlToLangs.has(stream.url)) urlToLangs.set(stream.url, []);
      urlToLangs.get(stream.url).push(langCode);
    }
    const languages = [];
    for (const [langCode, stream] of langBestMap.entries()) {
      const langsForUrl = urlToLangs.get(stream.url) || [];
      if (langsForUrl.length === 1) {
        languages.push({
          code: langCode,
          name: LANG_NAMES[langCode] || langCode.toUpperCase(),
        });
      }
    }

    const subtitleMap = new Map();
    for (const stream of streams) {
      for (const sub of stream.subtitles || []) {
        if (!sub?.url) continue;
        const key = `${sub.lang || "und"}|${sub.url}`;
        if (!subtitleMap.has(key)) {
          subtitleMap.set(key, {
            lang: sub.lang || "und",
            url: sub.url,
            label: sub.label || LANG_NAMES[sub.lang] || sub.lang || "Subtitle",
          });
        }
      }
    }

    return {
      ok: streams.length > 0,
      title: data.title || null,
      streams,
      languages,
      subtitles: Array.from(subtitleMap.values()),
      providers: data.providerTimings || data.providers || {},
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

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
    if (!detailsRes.ok || details.success === false) {
      throw new Error(details.status_message || `TMDB ${detailsRes.status}`);
    }

    const validSeasons = Array.isArray(details.seasons)
      ? details.seasons.filter((s) => Number(s.season_number) > 0)
      : [];

    const seasonResults = await Promise.all(
      validSeasons.map(async (season) => {
        try {
          const seasonUrl = new URL(
            `https://api.themoviedb.org/3/tv/${encodeURIComponent(tmdbId)}/season/${encodeURIComponent(season.season_number)}`
          );
          seasonUrl.searchParams.set("api_key", TMDB_API_KEY);
          seasonUrl.searchParams.set("language", "en-US");
          const r = await fetch(seasonUrl.href, {
            headers: { Accept: "application/json", "User-Agent": USER_AGENT },
          });
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
// STREAM PROXY
// ------------------------------------------------------------
function buildProxyUrl(targetUrl, referer) {
  const proxy = new URL("/api/proxy", "http://zylo.local");
  proxy.searchParams.set("url", targetUrl);
  if (referer) proxy.searchParams.set("referer", referer);
  return `${proxy.pathname}${proxy.search}`;
}

function rewriteHlsManifest(text, baseUrl, referer) {
  const lines = text.split(/\r?\n/);
  const rewriteUri = (rawValue) => {
    if (!rawValue) return rawValue;
    const value = rawValue.trim();
    if (value.startsWith("data:") || value.startsWith("blob:") || value.startsWith("#")) return value;
    try {
      const absolute = new URL(value, baseUrl);
      validateUpstreamUrl(absolute.href);
      return buildProxyUrl(absolute.href, referer);
    } catch { return value; }
  };
  return lines
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith("#")) {
        if (!/URI=/i.test(line)) return line;
        return line.replace(/URI\s*=\s*"([^"]+)"/gi, (_, uri) => `URI="${rewriteUri(uri)}"`);
      }
      return rewriteUri(trimmed);
    })
    .join("\n");
}

async function handleProxy(req, res) {
  try {
    const targetUrl = String(req.query.url || "").trim();
    if (!targetUrl) return res.status(400).send("url required");
    validateUpstreamUrl(targetUrl);

    const referer = req.query.referer || null;
    const range = req.headers.range || null;
    const likelyManifest = isHlsUrl(targetUrl);

    const headers = { "User-Agent": USER_AGENT, Accept: "*/*" };
    if (referer) {
      headers.Referer = referer;
      try { headers.Origin = new URL(referer).origin; } catch {}
    }
    if (range && !likelyManifest) headers.Range = range;

    const r = await fetch(targetUrl, { headers, redirect: "follow" });

    const contentType = (r.headers.get("content-type") || "").toLowerCase();
    const finalIsHls = isHlsUrl(targetUrl) || contentType.includes("mpegurl");

    if (!r.ok && r.status !== 206) return res.status(r.status).send(`upstream ${r.status}`);

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges, Content-Type, ETag");

    if (req.method === "HEAD") {
      if (finalIsHls) {
        res.status(r.status);
        res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
        return res.end();
      }
      for (const h of ["content-type", "content-length", "content-range", "accept-ranges", "etag"]) {
        const v = r.headers.get(h);
        if (v) res.setHeader(h, v);
      }
      return res.status(r.status).end();
    }

    if (finalIsHls) {
      const text = await r.text();
      const rewritten = rewriteHlsManifest(text, targetUrl, referer);
      res.status(r.status === 206 ? 200 : r.status);
      res.removeHeader("Content-Length");
      res.removeHeader("ETag");
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.setHeader("Cache-Control", "no-store, max-age=0");
      return res.send(rewritten);
    }

    for (const h of ["content-type", "content-length", "content-range", "accept-ranges", "etag"]) {
      const v = r.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    res.status(r.status);
    if (!r.headers.get("content-type")) res.setHeader("Content-Type", "application/octet-stream");

    if (!r.body) {
      const buffer = Buffer.from(await r.arrayBuffer());
      return res.end(buffer);
    }

    const reader = r.body.getReader();
    const cleanup = () => { try { reader.cancel(); } catch {} };
    req.on("aborted", cleanup);
    res.on("close", cleanup);

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        if (!res.write(Buffer.from(value))) {
          await new Promise((resolve) => res.once("drain", resolve));
        }
      }
      res.end();
    } catch {
      cleanup();
      if (!res.headersSent) return res.status(502).send("Upstream stream error");
      try { res.end(); } catch {}
    } finally {
      req.off("aborted", cleanup);
      res.off("close", cleanup);
    }
  } catch (e) {
    console.error("[proxy]", e?.message || e);
    if (res.headersSent) { try { res.end(); } catch {} return; }
    if (/not allowed/i.test(e.message)) return res.status(403).send("Upstream host not allowed");
    return res.status(502).send(`Proxy error: ${e.message}`);
  }
}

app.get("/api/proxy", handleProxy);
app.head("/api/proxy", handleProxy);

app.get("/", (_req, res) => res.send("Zylo Backend v10 ✅"));
app.get("/api/health", (_req, res) =>
  res.json({
    ok: true,
    version: "v10",
    tmdb: !!TMDB_API_KEY,
    cache: tmdbCache.size,
    ts: Date.now(),
  })
);

app.use((req, res) => res.status(404).json({ ok: false, error: "Not found" }));

app.listen(PORT, () => {
  console.log(`✅ Zylo Backend v10 running on port ${PORT}`);
  console.log(`   TMDB Proxy: /api/tmdb/*`);
  console.log(`   TMDB Key: ${TMDB_API_KEY ? "✅ Set" : "❌ Missing"}`);
  console.log(`   Streams: /api/streams, /api/proxy`);
});
