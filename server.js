// ============================================================
//   Zylo Backend v5 — FINAL
//   TMDB-Embed-API (13 providers) + Proxy 206 + TV Info + Multi-Audio
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

// ⭐ URLs
const TMDB_EMBED_API = "https://tmdb-embed-api-c1oy.onrender.com";

// ⭐ TMDB API Key (fallback hardcoded — Render Environment overrides this)
const TMDB_API_KEY = process.env.TMDB_API_KEY || "226cd3ee9998d07c2548d14f7e19a5da";

// ⭐ Language detect patterns (title se)
const LANG_PATTERNS = [
  { regex: /\bhindi\b/i, code: "hi", name: "Hindi" },
  { regex: /\benglish\b/i, code: "en", name: "English" },
  { regex: /\btamil\b/i, code: "ta", name: "Tamil" },
  { regex: /\btelugu\b/i, code: "te", name: "Telugu" },
  { regex: /\bmalayalam\b/i, code: "ml", name: "Malayalam" },
  { regex: /\bkannada\b/i, code: "kn", name: "Kannada" },
  { regex: /\bbengali\b/i, code: "bn", name: "Bengali" },
  { regex: /\bmarathi\b/i, code: "mr", name: "Marathi" },
  { regex: /\bpunjabi\b/i, code: "pa", name: "Punjabi" },
  { regex: /\burdu\b/i, code: "ur", name: "Urdu" },
  { regex: /\bspanish\b|\bespañol\b/i, code: "es", name: "Spanish" },
  { regex: /\bfrench\b|\bfrançais\b/i, code: "fr", name: "French" },
  { regex: /\bgerman\b|\bdeutsch\b/i, code: "de", name: "German" },
  { regex: /\bjapanese\b|\b日本語\b/i, code: "ja", name: "Japanese" },
  { regex: /\bkorean\b|\b한국어\b/i, code: "ko", name: "Korean" },
  { regex: /\bchinese\b|\b中文\b/i, code: "zh", name: "Chinese" },
  { regex: /\bitalian\b|\bitaliano\b/i, code: "it", name: "Italian" },
  { regex: /\bportuguese\b|\bportuguês\b/i, code: "pt", name: "Portuguese" },
  { regex: /\brussian\b|\bрусский\b/i, code: "ru", name: "Russian" },
  { regex: /\barabic\b|\bالعربية\b/i, code: "ar", name: "Arabic" },
];

// ============================================================
//   Helper: detect language from a stream's label/title
// ============================================================
function detectLanguage(text = "") {
  for (const p of LANG_PATTERNS) {
    if (p.regex.test(text)) return { code: p.code, name: p.name };
  }
  return null;
}

// ============================================================
//   getStreams — with type fix + timeout + audio grouping
// ============================================================
async function getStreams(tmdbId, type = "movie", season = null, episode = null) {
  const apiType = type === "tv" ? "series" : type;

  let url = `${TMDB_EMBED_API}/api/streams/${apiType}/${tmdbId}`;
  if (apiType === "series" && season !== null && episode !== null) {
    url += `?season=${season}&episode=${episode}`;
  }

  console.log("[streams] Fetching:", url);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 25000);

  try {
    const r = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
    });

    clearTimeout(timeoutId);
    const text = await r.text();

    if (!r.ok) {
      throw new Error(`TMDB-Embed ${r.status}: ${text.slice(0, 150)}`);
    }

    const data = JSON.parse(text);

    // ========================================================
    //   NORMALIZE STREAMS
    // ========================================================
    const rawStreams = data.streams || [];

    const streams = rawStreams.map((s) => {
      const labelText = `${s.title || ""} ${s.name || ""} ${s.quality || ""}`;
      const detected = detectLanguage(labelText);

      return {
        url: s.url,
        resolution: parseInt(String(s.quality).replace(/[^\d]/g, ""), 10) || 720,
        label: s.title || s.quality || "Auto",
        provider: s.provider || "unknown",
        lang: s.lang || s.language || (detected ? detected.code : null),
        langName: detected ? detected.name : null,
        headers: s.headers || null,
        subtitles: s.subtitles || [],
      };
    });

    streams.sort((a, b) => b.resolution - a.resolution);

    // ========================================================
    //   GLOBAL MULTI-AUDIO EXTRACTION
    //   Saari languages jo bhi kisi bhi stream me mile
    // ========================================================
    const audioMap = new Map(); // langCode → { lang, label, url, resolution }
    streams.forEach((s) => {
      const code = s.lang || "default";
      const name = s.langName || "Default";
      const existing = audioMap.get(code);
      if (!existing || s.resolution > existing.resolution) {
        audioMap.set(code, {
          lang: code,
          label: name,
          url: s.url,
          resolution: s.resolution,
        });
      }
    });

    const audioTracks = Array.from(audioMap.values());
    if (audioTracks.length === 0 && streams.length > 0) {
      audioTracks.push({
        lang: "default",
        label: "Default",
        url: streams[0].url,
        resolution: streams[0].resolution,
      });
    }

    // ========================================================
    //   SUBTITLES
    // ========================================================
    const allSubs = [];
    const seenSubs = new Set();
    streams.forEach((s) => {
      (s.subtitles || []).forEach((sub) => {
        if (sub.url && sub.lang && !seenSubs.has(sub.lang)) {
          seenSubs.add(sub.lang);
          allSubs.push({
            lang: sub.lang,
            url: sub.url,
            label: sub.lang,
          });
        }
      });
    });

    return {
      ok: streams.length > 0,
      title: data.title || null,
      streams: streams,
      hls: null,
      subtitles: allSubs,
      audioTracks: audioTracks,
      providers: data.providerTimings || data.providers || {},
    };
  } catch (e) {
    clearTimeout(timeoutId);
    if (e.name === "AbortError") {
      throw new Error("Request timeout — server waking up, please retry");
    }
    throw e;
  }
}

// ============================================================
//   ROUTES
// ============================================================
app.get("/", (_, res) => res.send("Zylo Backend v5 ✅ Running"));

app.get("/api/health", (_, res) => res.json({ ok: true, ts: Date.now() }));

app.get("/api/debug/streams", async (req, res) => {
  try {
    const tmdbId = req.query.id || "27205";
    const type = req.query.type || "movie";
    const data = await getStreams(tmdbId, type);
    res.json({
      ok: true,
      title: data.title,
      streamCount: data.streams.length,
      audioTracks: data.audioTracks,
      subtitleCount: data.subtitles.length,
      streams: data.streams.slice(0, 3),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

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
    res.status(200).json({ ok: false, streams: [], error: e.message });
  }
});

// ============================================================
//   ⭐ TV INFO — Seasons & Episodes from TMDB
// ============================================================
app.get("/api/tv-info", async (req, res) => {
  const tmdbId = req.query.id;
  if (!tmdbId) return res.status(400).json({ error: "id required" });

  if (!TMDB_API_KEY) {
    return res.status(500).json({ error: "TMDB_API_KEY not configured" });
  }

  try {
    const detailsRes = await fetch(
      `https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${TMDB_API_KEY}&language=en-US`
    );
    const details = await detailsRes.json();

    if (details.success === false) {
      throw new Error(details.status_message || "TMDB error");
    }

    const seasons = [];
    const validSeasons = (details.seasons || []).filter(
      (s) => s.season_number > 0
    );

    const seasonResults = await Promise.all(
      validSeasons.map((s) =>
        fetch(
          `https://api.themoviedb.org/3/tv/${tmdbId}/season/${s.season_number}?api_key=${TMDB_API_KEY}&language=en-US`
        )
          .then((r) => r.json())
          .catch(() => ({ episodes: [] }))
      )
    );

    validSeasons.forEach((s, i) => {
      const epData = seasonResults[i];
      seasons.push({
        season: s.season_number,
        name: s.name,
        episode_count: s.episode_count,
        episodes: (epData.episodes || []).map((e) => ({
          episode: e.episode_number,
          name: e.name,
          overview: e.overview,
          still_path: e.still_path,
          air_date: e.air_date,
          runtime: e.runtime,
        })),
      });
    });

    res.json({
      id: details.id,
      name: details.name,
      number_of_seasons: details.number_of_seasons,
      seasons,
    });
  } catch (e) {
    console.error("[tv-info] error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
//   ⭐ STREAM PROXY — with 206 Partial Content support
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
    // ⭐ Forward Range header for seeking
    if (req.headers.range) headers["Range"] = req.headers.range;

    const r = await fetch(target, { headers });

    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Access-Control-Expose-Headers", "*");

    if (!r.ok && r.status !== 206) {
      return res.status(r.status).send(`upstream ${r.status}`);
    }

    // ⭐⭐ CRITICAL: Forward 200/206 status
    res.status(r.status);

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
  console.log(`✅ Zylo Backend v5 running on port ${PORT}`);
  console.log(`   Source: ${TMDB_EMBED_API}`);
  console.log(`   TMDB Key: ${TMDB_API_KEY ? "✅ Set (" + TMDB_API_KEY.slice(0, 8) + "...)" : "❌ Missing"}`);
});
