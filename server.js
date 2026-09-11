// ============================================================
//   Zylo Backend v3 — TMDB-Embed-API only
//   13 providers · 95%+ coverage
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

// ⭐ TMDB-Embed-API (13 providers)
const TMDB_EMBED_API = "https://pi-c1oy.onrender.com";

// ============================================================
//   Get streams from TMDB-Embed-API
// ============================================================
async function getStreams(tmdbId, type = "movie", season = null, episode = null) {
  let url = `${TMDB_EMBED_API}/api/streams/${type}/${tmdbId}`;
  if (type === "tv" && season !== null && episode !== null) {
    url += `?season=${season}&episode=${episode}`;
  }

  console.log("[streams] Fetching:", url);

  const r = await fetch(url);
  const text = await r.text();

  if (!r.ok) {
    throw new Error(`TMDB-Embed ${r.status}: ${text.slice(0, 150)}`);
  }

  const data = JSON.parse(text);

  // Normalize streams
  const streams = (data.streams || []).map((s) => ({
    url: s.url,
    resolution: parseInt(String(s.quality).replace(/[^\d]/g, ""), 10) || 720,
    label: s.title || s.quality || "Auto",
    provider: s.provider || "unknown",
    headers: s.headers || null,
    subtitles: s.subtitles || [],
  }));

  // Sort by resolution (best first)
  streams.sort((a, b) => b.resolution - a.resolution);

  // Collect all subtitles from streams
  const allSubs = [];
  streams.forEach((s) => {
    (s.subtitles || []).forEach((sub) => {
      if (sub.url && sub.lang) {
        allSubs.push({ lang: sub.lang, url: sub.url, label: sub.lang });
      }
    });
  });

  return {
    ok: streams.length > 0,
    title: data.title || null,
    streams: streams,
    hls: null,
    subtitles: allSubs,
    providers: data.providerTimings || data.providers || {},
  };
}

// ============================================================
//   ROUTES
// ============================================================
app.get("/", (_, res) => res.send("Zylo Backend v3 ✅ Running (TMDB-Embed)"));

app.get("/api/health", (_, res) => res.json({ ok: true, ts: Date.now() }));

// Debug — direct test
app.get("/api/debug/streams", async (req, res) => {
  try {
    const tmdbId = req.query.id || "27205";
    const type = req.query.type || "movie";
    const data = await getStreams(tmdbId, type);
    res.json({
      ok: true,
      title: data.title,
      streamCount: data.streams.length,
      streams: data.streams.slice(0, 3),
      providers: data.providers,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Main streams endpoint
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
    res.status(500).json({ error: e.message });
  }
});

// Alias — same as /api/streams (frontend compatibility)
app.get("/api/streams-v2", async (req, res) => {
  try {
    const tmdbId = req.query.id;
    const type = req.query.type || "movie";
    const season = req.query.s ? parseInt(req.query.s, 10) : null;
    const episode = req.query.e ? parseInt(req.query.e, 10) : null;

    if (!tmdbId) return res.status(400).json({ error: "id required" });

    const data = await getStreams(tmdbId, type, season, episode);
    res.json(data);
  } catch (e) {
    console.error("[streams-v2] error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Alias — same (frontend compatibility)
app.get("/api/streams-all", async (req, res) => {
  try {
    const tmdbId = req.query.id;
    const type = req.query.type || "movie";
    const season = req.query.s ? parseInt(req.query.s, 10) : null;
    const episode = req.query.e ? parseInt(req.query.e, 10) : null;

    if (!tmdbId) return res.status(400).json({ error: "id required" });

    const data = await getStreams(tmdbId, type, season, episode);
    res.json({ ...data, source: "tmdb-embed", fallbackUsed: false });
  } catch (e) {
    console.error("[streams-all] error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
//   STREAM PROXY — HLS + MP4
// ============================================================
app.get("/api/proxy", async (req, res) => {
  try {
    const target = req.query.url;
    if (!target) return res.status(400).send("url required");

    const referer = req.query.referer || "";

    const headers = {
      "User-Agent": USER_AGENT,
      Accept: "*/*",
    };
    if (referer) {
      headers["Referer"] = referer;
      try {
        headers["Origin"] = new URL(referer).origin;
      } catch {}
    }
    if (req.headers.range) headers["Range"] = req.headers.range;

    const r = await fetch(target, { headers });

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
              const refParam = referer ? `&referer=${encodeURIComponent(referer)}` : "";
              return `URI="/api/proxy?url=${encodeURIComponent(abs)}${refParam}"`;
            });
          }
          if (t.startsWith("#")) return line;
          const abs = t.startsWith("http") ? t : new URL(t, baseUrl).href;
          const refParam = referer ? `&referer=${encodeURIComponent(referer)}` : "";
          return `/api/proxy?url=${encodeURIComponent(abs)}${refParam}`;
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
  console.log(`✅ Zylo Backend v3 running on port ${PORT}`);
  console.log(`   Source: ${TMDB_EMBED_API}`);
});
