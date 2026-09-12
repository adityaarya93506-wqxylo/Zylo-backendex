// ============================================================
//   Zylo Backend v9.2 — Secure + Real Language Detection
//   ✓ Raw streams passthrough (no fake grouping)
//   ✓ Real language detection (only genuinely different URLs)
//   ✓ Full HLS URI rewriting
//   ✓ Correct Range / 206 handling
//   ✓ Private/local URL blocking (SSRF protection)
//   ✓ Redirect validation
//   ✓ Manifest Content-Length/ETag removal after rewrite
//   ✓ TMDB key from environment
//   ✓ Optional host allowlist (open by default for 13 providers)
// ============================================================

import express from "express";
import cors from "cors";

const app = express();

const PORT = Number(process.env.PORT || 3000);

const USER_AGENT =
  process.env.STREAM_USER_AGENT ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/120.0.0.0 Safari/537.36";

const TMDB_EMBED_API =
  process.env.TMDB_EMBED_API ||
  "https://tmdb-embed-api-c1oy.onrender.com";

const TMDB_API_KEY = process.env.TMDB_API_KEY || "";

// ------------------------------------------------------------
// CORS
// ------------------------------------------------------------

const DEFAULT_ORIGINS = ["*"];

const CORS_ORIGINS = (process.env.CORS_ORIGINS || DEFAULT_ORIGINS.join(","))
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (CORS_ORIGINS.includes("*")) return callback(null, true);
      if (CORS_ORIGINS.includes(origin)) return callback(null, true);
      return callback(new Error("CORS origin not allowed"));
    },
    methods: ["GET", "HEAD", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Range",
      "Accept",
      "Origin",
      "Referer",
      "User-Agent",
    ],
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

// ------------------------------------------------------------
// SECURITY HEADERS
// ------------------------------------------------------------

app.disable("x-powered-by");

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  next();
});

// ------------------------------------------------------------
// LANGUAGE MAP
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

// ------------------------------------------------------------
// RESOLUTION
// ------------------------------------------------------------

function parseResolution(value) {
  if (value == null) return null;
  const match = String(value).match(/(\d{3,4})/);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isFinite(n)) return null;
  if (n < 144 || n > 4320) return null;
  return n;
}

// ------------------------------------------------------------
// HLS DETECTION
// ------------------------------------------------------------

function isHlsUrl(url = "") {
  try {
    const u = new URL(url);
    const path = u.pathname.toLowerCase();
    if (path.endsWith(".m3u8")) return true;
    const content = `${u.pathname}${u.search}`.toLowerCase();
    return (
      content.includes(".m3u8") ||
      content.includes("m3u8") ||
      /\/hls(?:\/|$)/i.test(u.pathname) ||
      /playlist/i.test(u.pathname)
    );
  } catch {
    const value = String(url).toLowerCase();
    return (
      value.includes(".m3u8") ||
      value.includes("m3u8") ||
      value.includes("/hls/") ||
      value.includes("playlist")
    );
  }
}

// ------------------------------------------------------------
// SAFE URL HELPERS
// ------------------------------------------------------------

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
    host === "localhost.localdomain" ||
    host === "ip6-localhost" ||
    host === "ip6-loopback" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return true;
  }

  if (host === "::1" || host === "0.0.0.0") return true;

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const parts = ipv4.slice(1).map(Number);
    if (parts.some((n) => n < 0 || n > 255)) return true;
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a >= 224) return true;
  }

  if (host.includes(":")) {
    if (host.startsWith("fc") || host.startsWith("fd")) return true;
    if (host.startsWith("fe8")) return true;
    if (host.startsWith("fe9")) return true;
    if (host.startsWith("fea")) return true;
    if (host.startsWith("feb")) return true;
  }

  return false;
}

// ------------------------------------------------------------
// UPSTREAM ALLOWLIST (optional)
// ------------------------------------------------------------

const ALLOWED_UPSTREAM_HOSTS = (process.env.ALLOWED_UPSTREAM_HOSTS || "")
  .split(",")
  .map((x) => x.trim().toLowerCase())
  .filter(Boolean);

const ENFORCE_ALLOWLIST = ALLOWED_UPSTREAM_HOSTS.length > 0;

function isAllowedUpstreamHost(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
  if (!host) return false;

  if (isPrivateOrLocalHostname(host)) return false;

  if (!ENFORCE_ALLOWLIST) return true;

  return ALLOWED_UPSTREAM_HOSTS.some((allowed) => {
    if (!allowed) return false;
    if (allowed === host) return true;
    if (allowed.startsWith("*.")) {
      const base = allowed.slice(2);
      return host === base || host.endsWith(`.${base}`);
    }
    return false;
  });
}

function validateUpstreamUrl(value) {
  const url = parseHttpUrl(value);
  if (!isAllowedUpstreamHost(url.hostname)) {
    throw new Error(`Upstream host not allowed: ${url.hostname}`);
  }
  return url;
}

// ------------------------------------------------------------
// SAFE REFERER
// ------------------------------------------------------------

function getSafeReferer(rawReferer) {
  if (!rawReferer) return null;
  if (String(rawReferer).length > 2048) return null;
  try {
    const ref = new URL(String(rawReferer));
    if (ref.protocol !== "http:" && ref.protocol !== "https:") return null;
    return ref.href;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------
// FETCH WITH VALIDATED REDIRECTS
// ------------------------------------------------------------

async function fetchUpstream(initialUrl, options = {}) {
  let currentUrl = validateUpstreamUrl(initialUrl);
  const maxRedirects = 5;

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount++) {
    const controller = new AbortController();
    const timeoutMs = Number(options.timeoutMs || 45000);
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const headers = {
        "User-Agent": USER_AGENT,
        Accept: options.accept || "*/*",
      };

      if (options.referer) {
        headers.Referer = options.referer;
        try {
          headers.Origin = new URL(options.referer).origin;
        } catch {}
      }

      if (options.range) headers.Range = options.range;

      const response = await fetch(currentUrl.href, {
        method: options.method || "GET",
        headers,
        redirect: "manual",
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (redirectCount >= maxRedirects) {
          throw new Error("Too many upstream redirects");
        }
        const location = response.headers.get("location");
        if (!location) throw new Error("Upstream redirect missing Location");

        const nextUrl = new URL(location, currentUrl.href);
        validateUpstreamUrl(nextUrl.href);
        currentUrl = nextUrl;
        continue;
      }

      return { response, finalUrl: currentUrl.href };
    } catch (error) {
      clearTimeout(timeoutId);
      if (error?.name === "AbortError") throw new Error("Upstream request timeout");
      throw error;
    }
  }
  throw new Error("Upstream redirect failure");
}

// ------------------------------------------------------------
// HLS REWRITE
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
    if (
      value.startsWith("data:") ||
      value.startsWith("blob:") ||
      value.startsWith("#")
    ) {
      return value;
    }
    try {
      const absolute = new URL(value, baseUrl);
      validateUpstreamUrl(absolute.href);
      return buildProxyUrl(absolute.href, referer);
    } catch {
      return value;
    }
  };

  return lines
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      if (trimmed.startsWith("#")) {
        if (!/URI=/i.test(line)) return line;
        return line.replace(
          /URI\s*=\s*"([^"]+)"/gi,
          (_, uri) => `URI="${rewriteUri(uri)}"`
        );
      }
      return rewriteUri(trimmed);
    })
    .join("\n");
}

// ------------------------------------------------------------
// GET STREAMS — Real Language Detection (v9.2)
// ------------------------------------------------------------

async function getStreams(tmdbId, type = "movie", season = null, episode = null) {
  if (!tmdbId) throw new Error("TMDB id required");

  const apiType = type === "tv" ? "series" : "movie";

  let url =
    `${TMDB_EMBED_API}/api/streams/${apiType}/` +
    encodeURIComponent(String(tmdbId));

  if (apiType === "series" && season != null && episode != null) {
    url +=
      `?season=${encodeURIComponent(String(season))}` +
      `&episode=${encodeURIComponent(String(episode))}`;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 90000);

  try {
    const r = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
    });

    const text = await r.text();
    if (!r.ok) throw new Error(`TMDB-Embed ${r.status}: ${text.slice(0, 150)}`);

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("Invalid streams JSON");
    }

    const raw = Array.isArray(data.streams) ? data.streams : [];

    // ------------------------------------------------
    // NORMALIZE STREAMS
    // ------------------------------------------------
    const streams = raw
      .map((s) => {
        const streamUrl = typeof s?.url === "string" ? s.url.trim() : "";
        if (!streamUrl) return null;

        let parsedUrl;
        try {
          parsedUrl = parseHttpUrl(streamUrl);
        } catch {
          return null;
        }

        const rawLang = s.lang ?? s.language ?? s.audio_language ?? null;
        const lang = normalizeLang(rawLang);

        const resolution = parseResolution(
          s.quality ?? s.resolution ?? s.height ?? null
        );

        return {
          url: parsedUrl.href,
          type: isHlsUrl(parsedUrl.href) ? "hls" : "mp4",
          resolution,
          quality:
            s.quality != null
              ? String(s.quality)
              : resolution
              ? `${resolution}p`
              : null,
          label: s.title || (resolution ? `${resolution}p` : "Auto"),
          provider:
            s.provider != null ? String(s.provider) : "unknown",
          lang,
          subtitles: Array.isArray(s.subtitles)
            ? s.subtitles
                .map((sub) => {
                  if (!sub?.url) return null;
                  try {
                    const subUrl = parseHttpUrl(String(sub.url));
                    return {
                      url: subUrl.href,
                      lang:
                        normalizeLang(sub.lang || sub.language) ||
                        String(sub.lang || sub.language || "und")
                          .toLowerCase()
                          .trim(),
                      label:
                        sub.label || sub.name || sub.lang || "Subtitle",
                    };
                  } catch {
                    return null;
                  }
                })
                .filter(Boolean)
            : [],
        };
      })
      .filter(Boolean);

    // ------------------------------------------------
    // ⭐ REAL LANGUAGE DETECTION
    //
    // Only include a language if its best stream URL
    // is UNIQUE (not shared with another language).
    // This filters out fake language labels.
    // ------------------------------------------------
    const langBestMap = new Map(); // langCode → stream
    for (const stream of streams) {
      if (!stream.lang) continue;
      const existing = langBestMap.get(stream.lang);
      if (!existing || (stream.resolution || 0) > (existing.resolution || 0)) {
        langBestMap.set(stream.lang, stream);
      }
    }

    // Build URL → list of langs map
    const urlToLangs = new Map();
    for (const [langCode, stream] of langBestMap.entries()) {
      if (!urlToLangs.has(stream.url)) urlToLangs.set(stream.url, []);
      urlToLangs.get(stream.url).push(langCode);
    }

    // Only keep languages whose URL is unique
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

    // ------------------------------------------------
    // SUBTITLES
    // ------------------------------------------------
    const subtitleMap = new Map();
    for (const stream of streams) {
      for (const sub of stream.subtitles || []) {
        if (!sub?.url) continue;
        const key = `${sub.lang || "und"}|${sub.url}`;
        if (!subtitleMap.has(key)) {
          subtitleMap.set(key, {
            lang: sub.lang || "und",
            url: sub.url,
            label:
              sub.label || LANG_NAMES[sub.lang] || sub.lang || "Subtitle",
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
  } catch (e) {
    if (e?.name === "AbortError") throw new Error("Request timeout — retry");
    throw e;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ------------------------------------------------------------
// ROUTES
// ------------------------------------------------------------

app.get("/", (_req, res) => res.send("Zylo Backend v9.2 ✅"));

app.get("/api/health", (_req, res) =>
  res.json({ ok: true, version: "v9.2", ts: Date.now() })
);

app.get("/api/debug/streams", async (req, res) => {
  try {
    const data = await getStreams(
      req.query.id || "27205",
      req.query.type || "movie"
    );
    res.json({
      ok: true,
      title: data.title,
      streamCount: data.streams.length,
      languages: data.languages,
      sampleStreams: data.streams.slice(0, 5),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "Debug failed" });
  }
});

app.get("/api/streams", async (req, res) => {
  try {
    const tmdbId = String(req.query.id || "").trim();
    if (!tmdbId) {
      return res
        .status(400)
        .json({ ok: false, streams: [], error: "id required" });
    }

    const type = req.query.type === "tv" ? "tv" : "movie";
    const season =
      req.query.s != null && /^\d+$/.test(String(req.query.s))
        ? Number(req.query.s)
        : null;
    const episode =
      req.query.e != null && /^\d+$/.test(String(req.query.e))
        ? Number(req.query.e)
        : null;

    const data = await getStreams(tmdbId, type, season, episode);
    res.json(data);
  } catch (e) {
    console.error("[streams]", e?.message || e);
    res.status(200).json({
      ok: false,
      streams: [],
      error: e?.message || "Streams unavailable",
    });
  }
});

// ------------------------------------------------------------
// TV INFO
// ------------------------------------------------------------

app.get("/api/tv-info", async (req, res) => {
  const tmdbId = String(req.query.id || "").trim();
  if (!tmdbId) return res.status(400).json({ error: "id required" });
  if (!TMDB_API_KEY) {
    return res
      .status(500)
      .json({ error: "TMDB_API_KEY environment variable missing" });
  }

  try {
    const detailsUrl = new URL(
      `https://api.themoviedb.org/3/tv/${encodeURIComponent(tmdbId)}`
    );
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
            `https://api.themoviedb.org/3/tv/${encodeURIComponent(
              tmdbId
            )}/season/${encodeURIComponent(season.season_number)}`
          );
          seasonUrl.searchParams.set("api_key", TMDB_API_KEY);
          seasonUrl.searchParams.set("language", "en-US");

          const r = await fetch(seasonUrl.href, {
            headers: { Accept: "application/json", "User-Agent": USER_AGENT },
          });
          if (!r.ok) return { episodes: [] };
          return await r.json();
        } catch {
          return { episodes: [] };
        }
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

// ============================================================
// PROXY
// ============================================================

async function handleProxy(req, res) {
  try {
    const targetUrl = String(req.query.url || "").trim();
    if (!targetUrl) return res.status(400).send("url required");

    validateUpstreamUrl(targetUrl);

    const referer = getSafeReferer(req.query.referer);
    const range = req.headers.range || null;
    const likelyManifest = isHlsUrl(targetUrl);

    const upstream = await fetchUpstream(targetUrl, {
      method: req.method === "HEAD" ? "HEAD" : "GET",
      referer,
      range: likelyManifest ? null : range,
      timeoutMs: likelyManifest ? 20000 : 45000,
      accept: likelyManifest
        ? "application/vnd.apple.mpegurl,*/*;q=0.8"
        : "*/*",
    });

    const r = upstream.response;
    const finalUrl = upstream.finalUrl;

    const contentType = (r.headers.get("content-type") || "").toLowerCase();
    const finalIsHls =
      isHlsUrl(finalUrl) ||
      contentType.includes("mpegurl") ||
      contentType.includes("vnd.apple.mpegurl");

    if (!r.ok && r.status !== 206) {
      return res.status(r.status).send(`upstream ${r.status}`);
    }

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader(
      "Access-Control-Expose-Headers",
      "Content-Length, Content-Range, Accept-Ranges, Content-Type, ETag"
    );

    // HEAD
    if (req.method === "HEAD") {
      if (finalIsHls) {
        res.status(r.status);
        res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
        res.setHeader("Cache-Control", "no-store");
        return res.end();
      }
      for (const h of [
        "content-type",
        "content-length",
        "content-range",
        "accept-ranges",
        "etag",
        "last-modified",
        "cache-control",
      ]) {
        const v = r.headers.get(h);
        if (v) res.setHeader(h, v);
      }
      return res.status(r.status).end();
    }

    // HLS MANIFEST
    if (finalIsHls) {
      const text = await r.text();
      const rewritten = rewriteHlsManifest(text, finalUrl, referer);

      res.status(r.status === 206 ? 200 : r.status);
      res.removeHeader("Content-Length");
      res.removeHeader("ETag");
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.setHeader("Cache-Control", "no-store, max-age=0");
      return res.send(rewritten);
    }

    // MEDIA
    for (const h of [
      "content-type",
      "content-length",
      "content-range",
      "accept-ranges",
      "etag",
      "last-modified",
    ]) {
      const v = r.headers.get(h);
      if (v) res.setHeader(h, v);
    }

    res.status(r.status);

    if (!r.headers.get("content-type")) {
      res.setHeader("Content-Type", "application/octet-stream");
    }

    if (!r.body) {
      const buffer = Buffer.from(await r.arrayBuffer());
      return res.end(buffer);
    }

    const reader = r.body.getReader();
    const cleanup = () => {
      try {
        reader.cancel();
      } catch {}
    };

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
    } catch (streamError) {
      cleanup();
      if (!res.headersSent) return res.status(502).send("Upstream stream error");
      try {
        res.end();
      } catch {}
    } finally {
      req.off("aborted", cleanup);
      res.off("close", cleanup);
    }
  } catch (e) {
    console.error("[proxy]", e?.message || e);
    if (res.headersSent) {
      try {
        res.end();
      } catch {}
      return;
    }
    const message = e?.message || "Proxy error";
    if (/not allowed/i.test(message)) {
      return res.status(403).send("Upstream host not allowed");
    }
    return res.status(502).send(`Proxy error: ${message}`);
  }
}

app.get("/api/proxy", handleProxy);
app.head("/api/proxy", handleProxy);

// 404
app.use((req, res) => {
  res.status(404).json({ ok: false, error: "Not found" });
});

// ERROR HANDLER
app.use((err, _req, res, _next) => {
  console.error("[server]", err?.message || err);
  if (res.headersSent) return;
  if (/CORS/i.test(err?.message || "")) {
    return res.status(403).json({ ok: false, error: "CORS origin not allowed" });
  }
  res.status(500).json({ ok: false, error: "Internal server error" });
});

// START
app.listen(PORT, () => {
  console.log(`✅ Zylo Backend v9.2 running on port ${PORT}`);
  console.log(`   TMDB Embed API: ${TMDB_EMBED_API}`);
  console.log(
    `   Upstream mode: ${
      ENFORCE_ALLOWLIST
        ? "ALLOWLIST ENFORCED (" + ALLOWED_UPSTREAM_HOSTS.join(", ") + ")"
        : "OPEN (all public hosts, private blocked)"
    }`
  );
  console.log(
    `   TMDB Key: ${TMDB_API_KEY ? "✅ Set" : "❌ Missing (tv-info will fail)"}`
  );
});
