// ============================================================
//   Zylo Backend v2 — TMDB + net27.cc embed API
//   No Cloudflare bypass needed · No cookies · No Puppeteer
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

// net27.cc requires this referer
const NET27_REFERER = "https://videodownloader.site/";
const NET27_ORIGIN = "https://videodownloader.site";
const NET27_BASE = "https://net27.cc";

// ---------------- getStreams (net27.cc embed-tmdb) ----------------
async function getStreams(tmdbId, type = "movie", season = null, episode = null) {
  let url = `${NET27_BASE}/api/embed-tmdb/${tmdbId}`;
  if (type === "tv" && season !== null && episode !== null) {
    url += `?type=tv&s=${season}&e=${episode}`;
  }

  console.log("[getStreams]", url);

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
  console.log("[getStreams] status:", r.status, "| preview:", text.slice(0, 200));

  if (!r.ok) {
    throw new Error(`net27.cc ${r.status}: ${text.slice(0, 150)}`);
  }

  const j = JSON.parse(text);
  if (!j.ok) {
    throw new Error(j.error || "no source available");
  }
  return j;
}

// ---------------- TMDB search (optional, uses your key) ----------------
const TMDB_READ_TOKEN = process.env.TMDB_READ_TOKEN || "";

async function tmdbSearch(query, type = "movie") {
  if (!TMDB_READ_TOKEN) throw new Error("TMDB_READ_TOKEN not set");

  const url = `https://api.themoviedb.org/3/search/${type}?query=${encodeURIComponent(
    query
  )}`;

  const r = await fetch(url, {
    headers: {
      Authorization: `Bearer ${TMDB_READ_TOKEN}`,
      Accept: "application/json",
    },
  });

  if (!r.ok) throw new Error(`TMDB ${r.status}`);
  return r.json();
}

// ============================================================
//   ROUTES
// ============================================================

app.get("/", (_, res) => res.send("Zylo Backend v2 ✅ Running"));

// --- Debug: Test net27.cc with a TMDB ID ---
app.get("/api/debug/streams", async (req, res) => {
  try {
    const tmdbId = req.query.id || "27205"; // Inception default
    const type = req.query.type || "movie";
    const data = await getStreams(tmdbId, type);
    res.json({
      ok: true,
      title: data.title,
      year: data.year,
      streams: data.streams,
      hls: data.hls,
      subtitles: data.subtitles,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// --- Streams endpoint ---
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
    res.status(500).json({ error: e.message });
  }
});

// --- TMDB search (optional) ---
app.get("/api/search", async (req, res) => {
  try {
    const q = req.query.q;
    const type = req.query.type || "movie";
    if (!q) return res.status(400).json({ error: "q required" });
    const data = await tmdbSearch(q, type);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
//   STREAM PROXY — for mp4 + HLS with referer
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
      },
    });

    res.setHeader("Access-Control-Allow-Origin", "*");

    if (!r.ok) {
      return res.status(r.status).send(`upstream ${r.status}`);
    }

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

    // For mp4 and segments — stream chunks
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
    res.status(500).send("Proxy error: " + e.message);
  }
});

app.listen(PORT, () => {
  console.log(`✅ Zylo Backend v2 running on port ${PORT}`);
});
