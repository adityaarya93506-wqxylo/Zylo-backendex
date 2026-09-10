// ============================================================
//   Zylo Backend — Render Deployment
//   Netflix · Prime · Disney+ · Hotstar
//   Node.js + Express
// ============================================================

import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const USER_AGENT =
  "Mozilla/5.0 (Linux; Android 13; Pixel 5 Build/TQ3A.230901.001; wv) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/144.0.7559.132 " +
  "Safari/537.36 /OS.Gatu v3.0";

// ---------------- Caches ----------------
let cookie_cache = null, cookie_ts = 0;
let api_base_cache = null, api_base_ts = 0;
let resolvedApiUrl = "";
let lastReq = 0;

// ---------------- Bypass ----------------
async function bypass() {
  if (cookie_cache && Date.now() - cookie_ts < 54_000_000) return cookie_cache;

  const headers = {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Content-Type": "application/x-www-form-urlencoded",
    Origin: "https://net77.cc",
    Referer: "https://net77.cc/verify2",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
  };

  const form = new URLSearchParams();
  form.append("g-recaptcha-response", crypto.randomUUID());

  const res = await fetch("https://net52.cc/verify.php", {
    method: "POST",
    headers,
    body: form.toString(),
    redirect: "manual",
  });

  const setCookie =
    typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie().join("; ")
      : res.headers.get("set-cookie") || "";

  const match = setCookie.match(/t_hash_t=([^;]+)/);
  const value = match ? match[1] : "";

  if (value) {
    cookie_cache = value;
    cookie_ts = Date.now();
  }
  return value;
}

// ---------------- Base64 + domains ----------------
const decodeBase64 = (v) => Buffer.from(v, "base64").toString("utf-8");

const newTvDomains = [
  "aHR0cHM6Ly9tb2JpbGVkZXRlY3RzLmNvbQ==",
  "aHR0cHM6Ly9tb2JpbGVkZXRlY3QuYXBw",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0LmFydA==",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0LmNj",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0LmNsaWNr",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0Lmluaw==",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0LmxpdmU=",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0LnBybw==",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0LnNob3A=",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0LnNpdGU=",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0LnNwYWNl",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0LnN0b3Jl",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0LnZpcA==",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0Lndpa2k=",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0Lnh5eg==",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0cy5hcnQ=",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0cy5jYw==",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0cy5pbmZv",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0cy5pbms=",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0cy5saXZl",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0cy5wcm8=",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0cy5zdG9yZQ==",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0cy50b3A=",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0cy54eXo=",
];

const newTvBaseHeaders = {
  "Cache-Control": "no-cache, no-store, must-revalidate",
  Pragma: "no-cache",
  Expires: "0",
  "X-Requested-With": "NetmirrorNewTV v1.0",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:136.0) " +
    "Gecko/20100101 Firefox/136.0 /OS.GatuNewTV v1.0",
  Accept: "application/json, text/plain, */*",
};

async function throttle() {
  const wait = 1200 - (Date.now() - lastReq);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastReq = Date.now();
}

async function resolveApiUrl() {
  if (resolvedApiUrl) return resolvedApiUrl;
  if (api_base_cache && Date.now() - api_base_ts < 86_400_000) {
    resolvedApiUrl = api_base_cache;
    return resolvedApiUrl;
  }
  for (const enc of newTvDomains) {
    const base = decodeBase64(enc).replace(/\/+$/, "");
    try {
      await throttle();
      const r = await fetch(`${base}/checknewtv.php`, {
        headers: newTvBaseHeaders,
      });
      const j = await r.json();
      if (j.token_hash) {
        resolvedApiUrl = decodeBase64(j.token_hash).replace(/\/+$/, "");
        api_base_cache = resolvedApiUrl;
        api_base_ts = Date.now();
        return resolvedApiUrl;
      }
    } catch {}
  }
  throw new Error("API URL resolve fail");
}

function buildNewTvHeaders(ott, extra = {}) {
  return { ...newTvBaseHeaders, Ott: ott, ...extra };
}

// ---------------- Provider logic ----------------
const MAIN_URL = "https://net52.cc";

const PV_HEADERS = {
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-IN,en-US;q=0.9,en;q=0.8",
  Connection: "keep-alive",
  "User-Agent": USER_AGENT,
  "X-Requested-With": "XMLHttpRequest",
};

async function providerCookies(ott) {
  const cookie = await bypass();
  return `t_hash_t=${cookie}; hd=on; ott=${ott}`;
}

async function safeJson(url, opts = {}) {
  const r = await fetch(url, opts);
  const text = await r.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON (${r.status}): ${text.slice(0, 150)}`);
  }
}

// Netflix
async function nfSearch(q) {
  return safeJson(
    `${MAIN_URL}/mobile/search.php?s=${encodeURIComponent(q)}&t=${Math.floor(Date.now() / 1000)}`,
    { headers: { ...PV_HEADERS, Cookie: await providerCookies("nf"), Referer: `${MAIN_URL}/home` } }
  );
}
async function nfLoad(id) {
  return safeJson(
    `${MAIN_URL}/mobile/post.php?id=${id}&t=${Math.floor(Date.now() / 1000)}`,
    { headers: { ...PV_HEADERS, Cookie: await providerCookies("nf"), Referer: `${MAIN_URL}/home` } }
  );
}

// Prime
async function pvSearch(q) {
  return safeJson(
    `${MAIN_URL}/mobile/pv/search.php?s=${encodeURIComponent(q)}&t=${Math.floor(Date.now() / 1000)}`,
    { headers: { ...PV_HEADERS, Cookie: await providerCookies("pv"), Referer: `${MAIN_URL}/home` } }
  );
}
async function pvLoad(id) {
  return safeJson(
    `${MAIN_URL}/mobile/pv/post.php?id=${id}&t=${Math.floor(Date.now() / 1000)}`,
    { headers: { ...PV_HEADERS, Cookie: await providerCookies("pv"), Referer: `${MAIN_URL}/home` } }
  );
}

// Hotstar / Disney
async function hsSearch(q, ott) {
  return safeJson(
    `${MAIN_URL}/mobile/hs/search.php?s=${encodeURIComponent(q)}&t=${Math.floor(Date.now() / 1000)}`,
    { headers: { ...PV_HEADERS, Cookie: await providerCookies(ott), Referer: `${MAIN_URL}/home` } }
  );
}
async function hsLoad(id, ott) {
  return safeJson(
    `${MAIN_URL}/mobile/hs/post.php?id=${id}&t=${Math.floor(Date.now() / 1000)}`,
    { headers: { ...PV_HEADERS, Cookie: await providerCookies(ott), Referer: `${MAIN_URL}/home` } }
  );
}

// Links — Netflix uses pv for playback
async function getLinks(id, ott) {
  const apiBase = await resolveApiUrl();
  const cookie = await bypass();
  const cookieHeader = `t_hash_t=${cookie}; hd=on; ott=${ott}`;

  const url = `${apiBase}/newtv/player.php?id=${id}`;
  const r = await fetch(url, {
    headers: {
      "Accept": "application/json, text/plain, */*",
      "Accept-Language": "en-IN,en-US;q=0.9,en;q=0.8",
      "User-Agent": USER_AGENT,
      "Cookie": cookieHeader,
      "Referer": "https://net52.cc/",
      "Origin": "https://net52.cc",
    },
  });

  const text = await r.text();
  try {
    const j = JSON.parse(text);
    if (j.video_link) return j;
    throw new Error("No video_link: " + text.slice(0, 150));
  } catch (e) {
    throw new Error(`player.php (${r.status}): ${text.slice(0, 150)}`);
  }
}

// ---------------- Dispatcher ----------------
async function handleSearch(p, q) {
  if (p === "netflix") return nfSearch(q);
  if (p === "prime") return pvSearch(q);
  if (p === "disney") return hsSearch(q, "dp");
  if (p === "hotstar") return hsSearch(q, "hs");
  throw new Error("Unknown provider: " + p);
}
async function handleLoad(p, id) {
  if (p === "netflix") return nfLoad(id);
  if (p === "prime") return pvLoad(id);
  if (p === "disney") return hsLoad(id, "dp");
  if (p === "hotstar") return hsLoad(id, "hs");
  throw new Error("Unknown provider: " + p);
}
async function handleLinks(p, id) {
  if (p === "netflix") return getLinks(id, "pv");
  if (p === "prime") return getLinks(id, "pv");
  if (p === "disney") return getLinks(id, "dp");
  if (p === "hotstar") return getLinks(id, "hs");
  throw new Error("Unknown provider: " + p);
}

// ============================================================
//   ROUTES
// ============================================================
app.get("/", (_, res) => res.send("Zylo Backend ✅ Running"));

app.get("/api/debug/bypass", async (_, res) => {
  try {
    const c = await bypass();
    res.json({ ok: !!c, cookie_preview: c ? c.slice(0, 20) + "..." : null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/debug/resolve", async (_, res) => {
  try {
    const apiBase = await resolveApiUrl();
    res.json({ apiBase });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Universal
app.get("/api/:provider(search|load|links)", async (req, res) => {
  // handled below
  res.status(404).json({ error: "Use specific route" });
});

// Provider routes
["netflix", "prime", "disney", "hotstar"].forEach((provider) => {
  app.get(`/api/${provider}/search`, async (req, res) => {
    try {
      res.json(await handleSearch(provider, req.query.q || ""));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  app.get(`/api/${provider}/load`, async (req, res) => {
    try {
      res.json(await handleLoad(provider, req.query.id || ""));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  app.get(`/api/${provider}/links`, async (req, res) => {
    try {
      res.json(await handleLinks(provider, req.query.id || ""));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
});

// Legacy prime routes
app.get("/api/prime/search", async (req, res) => {
  try { res.json(await pvSearch(req.query.q || "")); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------- HLS Proxy ----------------
app.get("/api/proxy", async (req, res) => {
  try {
    const target = req.query.url;
    if (!target) return res.status(400).send("Missing url");

    const referer = req.query.referer || new URL(target).origin;

    const r = await fetch(target, {
      headers: {
        "User-Agent": USER_AGENT,
        Referer: referer,
        Origin: new URL(referer).origin,
        Cookie: "hd=on",
        Accept: "*/*",
      },
    });

    res.setHeader("Access-Control-Allow-Origin", "*");

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
      res.send(text);
    } else {
      res.setHeader("Content-Type", ctype || "application/octet-stream");
      const buf = Buffer.from(await r.arrayBuffer());
      res.send(buf);
    }
  } catch (e) {
    res.status(500).send("Proxy error: " + e.message);
  }
});

app.listen(PORT, () => {
  console.log(`✅ Zylo Backend running on port ${PORT}`);
});
