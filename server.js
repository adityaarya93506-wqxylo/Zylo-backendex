// ============================================================
//   Zylo Backend v2 — COMPLETE
//   Primary: net27.cc (fast, single source)
//   Fallback: TMDB-Embed-API (13 providers, 95%+ coverage)
// ============================================================

import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// ---------------- Config ----------------
const NET27_REFERER = "https://videodownloader.site/";
const NET27_ORIGIN = "https://videodownloader.site";
const NET27_BASE = "https://net27.cc";

// ⭐ TMDB-Embed-API (13 providers fallback)
const TMDB_EMBED_API = "https://pi-c1oy.onrender.com";

// ============================================================
//   PRIMARY SOURCE — net27.cc
// ============================================================
async function getStreams(tmdbId, type = "movie", season = null, episode = null) {
  let url = `${NET27_BASE}/api/embed-tmdb/${tmdbId}`;
  if (type === "tv" && season !== null && episode !== null) {
    url += `?type=tv&s=${season}&e=${episode}`;
  }

  console.log("[net27] Fetching:", url);

  const r = await fetch(url, {
    headers: {
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: NET27_REFERER,
      Origin: NET27_ORIGIN,
      "User-Agent": USER_AGENT,
    },
  });

  const text = await r.text();
  if (!r.ok) {
    throw new Error(`net27.cc ${r.status}: ${text.slice(0, 150)}`);
  }

  const j = JSON.parse(text);
  if (!j.ok) {
    throw new Error(j.error || "no source available");
  }
  return j;
}

// ============================================================
//   FALLBACK SOURCE — TMDB-Embed-API (13 providers)
// ============================================================
async function getStreamsV2(tmdbId, type = "movie", season = null, episode = null) {
  let url = `${TMDB_EMBED_API}/api/streams/${type}/${tmdbId}`;
  if (type === "tv" && season !== null && episode !== null) {
    url += `?season=${season}&episode=${episode}`;
  }

  console.log("[tmdb-embed] Fetching:", url);

  const r = await fetch(url);
  const text = await r.text();
  if (!r.ok) {
    throw new Error(`tmdb-embed ${r.status}: ${text.slice(0, 150)}`);
  }

  const data = JSON.parse(text);

  // Normalize response
  const streams = (data.streams || []).map((s) => ({
    url: s.url,
    resolution: parseInt(String(s.quality).replace(/[^\d]/g, ""), 10) || 720,
    label: s.title || s.quality,
    provider: s.provider,
    headers: s.headers || null,
  }));

  return {
    ok: streams.length > 0,
    title: data.title,
    streams: streams,
    hls: null,
    subtitles: [],
    providers: data.providerTimings || data.providers,
  };
}

// ============================================================
//   ROUTES
// ============================================================
app.get("/", (_, res) => res.send("Zylo Backend v2 ✅ Running"));

// Health
app.get("/api/health", (_, res) => res.json({ ok: true, ts: Date.now() }));

// Debug: Primary only (net27.cc)
app.get("/api/debug/streams", async (req, res) => {
  try {
    const tmdbId = req.query.id || "27205";
    const type = req.query.type || "movie";
    const data = await getStreams(tmdbId, type);
    res.json({
      ok: true,
      source: "net27.cc",
      title: data.title,
      streams: data.streams,
      hls: data.hls,
      subtitles: data.subtitles,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================================================
//   PRIMARY — /api/streams (net27.cc)
// ============================================================
app.get("/api/streams", async (req, res) => {
  try {
    const tmdbId = req.query.id;
    const type = req.query.type || "movie";
    const season = req.query.s ? parseInt(req.query.s, 10) : null;
    const episode = req.query.e ? parseInt(req.query.e, 10) : null;

    if (!tmdbId) return res.status(400).json({ error: "id required" });

    const data = await getStreams(tmdbId, type, season, episode);
    res.json(data);
  } catch (e) {
    console.error("[streams] error:", e.message);
    res.status(500).json({ error: e.message, source: "net27.cc" });
  }
});

// ============================================================
//   FALLBACK — /api/streams-v2 (TMDB-Embed-API, 13 providers)
// ============================================================
app.get("/api/streams-v2", async (req, res) => {
  try {
    const tmdbId = req.query.id;
    const type = req.query.type || "movie";
    const season = req.query.s ? parseInt(req.query.s, 10) : null;
    const episode = req.query.e ? parseInt(req.query.e, 10) : null;

    if (!tmdbId) return res.status(400).json({ error: "id required" });

    const data = await getStreamsV2(tmdbId, type, season, episode);
    res.json(data);
  } catch (e) {
    console.error("[streams-v2] error:", e.message);
    res.status(500).json({ error: e.message, source: "tmdb-embed" });
  }
});

// ============================================================
//   COMBINED — /api/streams-all
//   Pehle net27.cc try karega, agar fail ho to TMDB-Embed-API
// ============================================================
app.get("/api/streams-all", async (req, res) => {
  const tmdbId = req.query.id;
  const type = req.query.type || "movie";
  const season = req.query.s ? parseInt(req.query.s, 10) : null;
  const episode = req.query.e ? parseInt(req.query.e, 10) : null;

  if (!tmdbId) return res.status(400).json({ error: "id required" });

  // ---- 1. Try primary (net27.cc) ----
  try {
    const primary = await getStreams(tmdbId, type, season, episode);
    if (primary.streams?.length > 0 || primary.hls) {
      return res.json({
        ...primary,
        source: "net27.cc",
        fallbackUsed: false,
      });
    }
  } catch (e) {
    console.warn("[streams-all] Primary failed:", e.message);
  }

  // ---- 2. Try fallback (TMDB-Embed-API) ----
  try {
    const fallback = await getStreamsV2(tmdbId, type, season, episode);
    if (fallback.streams?.length > 0) {
      return res.json({
        ...fallback,
        source: "tmdb-embed",
        fallbackUsed: true,
      });
    }
  } catch (e) {
    console.warn("[streams-all] Fallback failed:", e.message);
  }

  // ---- 3. Both failed ----
  res.status(404).json({
    ok: false,
    error: "No source available from any provider",
    source: "none",
  });
});

// ============================================================
//   STREAM PROXY — HLS + MP4 with referer forwarding
// ============================================================
app.get("/api/proxy", async (req, res) => {
  try {
    const target = req.query.url;
    if (!target) return res.status(400).send("url required");

    const referer = req.query.referer || NET27_REFERER;

    const r = await fetch(target, {
      headers: {
        "User-Agent": USER_AGENT,
        Referer: referer,
        Origin: new URL(referer).origin,
        Accept: "*/*",
        Range: req.headers.range || "",
      },
    });

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Access-Control-Expose-Headers", "*");

    if (!r.ok && r.status !== 206) {
      return res.status(r.status).send(`upstream ${r.status}`);
    }

    ["content-type", "content-length", "content-range", "accept-ranges"].forEach((h) => {
      const v = r.headers.get(h);
      if (v) res.setHeader(h, v);
    });

    const ctype = r.headers.get("content-type") || "";
    const isM3u8 = target.includes(".m3u8") || ctype.includes("mpegurl");

    if (isM3u8) {
      let text = await r.text();
      const baseUrl = target.substring(0, target.lastIndexOf("/") + 1);

      text = text
        .split("\n")
        .map((line) => {
          const t = line.trim();
          if (!t) return line;
          if (t.startsWith("#EXT-X-KEY")) {
            return t.replace(/URI="([^"]+)"/, (_, u) => {
              const abs = u.startsWith("http") ? u : new URL(u, baseUrl).href;
              return `URI="/api/proxy?url=${encodeURIComponent(abs)}&referer=${encodeURIComponent(referer)}"`;
            });
          }
          if (t.startsWith("#")) return line;
          const abs = t.startsWith("http") ? t : new URL(t, baseUrl).href;
          return `/api/proxy?url=${encodeURIComponent(abs)}&referer=${encodeURIComponent(referer)}`;
        })
        .join("\n");

      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      return res.send(text);
    }

    res.setHeader("Content-Type", ctype || "application/octet-stream");

    if (r.body) {
      const reader = r.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      res.end();
    } else {
      const buf = Buffer.from(await r.arrayBuffer());
      res.send(buf);
    }
  } catch (e) {
    console.error("[proxy]", e.message);
    res.status(500).send("Proxy error: " + e.message);
  }
});

app.listen(PORT, () => {
  console.log(`✅ Zylo Backend v2 running on port ${PORT}`);
  console.log(`   Primary: net27.cc`);
  console.log(`   Fallback: ${TMDB_EMBED_API}`);
});
