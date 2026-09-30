// Production server for the Explain web app.
//
// In dev, `vite` serves the app and a middleware proxy handles POST /api/chat
// (see explainBotApi in vite.config.ts). A production build (`npm run build` ->
// dist/) has neither, so this tiny zero-dependency Node server provides both:
//
//   1. serves the static dist/ build (with COOP/COEP so SharedArrayBuffer /
//      crossOriginIsolated works — same headers vite sets in dev/preview),
//   2. hosts POST /api/chat, forwarding to the Explain bot's /v1/ask with the
//      API key injected SERVER-SIDE (never shipped to the browser bundle), and
//   3. hosts /api/auth/{login,register,logout,me} — MongoDB + bcrypt credential
//      check / account creation issuing a signed HttpOnly session cookie (shared
//      logic in ./auth.mjs, reused verbatim by the dev proxy in vite.config.ts), and
//   3b. hosts GET /api/auth/launch?t=… — one-click entry into a nicupicu.nl lesson
//      account (see launch() in ./auth.mjs and docs/ui/NICUPICU_INTEGRATION.md), and
//   4. hosts /api/states/{save,list,get,delete} — per-user save/load of model
//      states in MongoDB (auth-scoped; shared logic in ./states.mjs).
//
// The bot's reply is returned verbatim; the browser parses any embedded
// ```explain-command``` blocks itself (see src/services/botCommands.ts), so this
// proxy stays a dumb passthrough — identical contract to the dev proxy.
//
// Env (set in the process environment, or use `node --env-file=.env.local`):
//   EXPLAIN_BOT_URL       e.g. http://lucys-mac-mini.tail990503.ts.net:8091
//   EXPLAIN_BOT_API_KEY   the bot's X-API-Key
//   MONGODB_URI           Mongo connection string (auth; db name in the path)
//   AUTH_SECRET           secret used to sign session cookies
//   NICUPICU_LAUNCH_SECRET  shared secret for signed nicupicu launch tokens (optional)
//   LAUNCH_STATIC_KEYS    "off" rejects static lesson launch links (signed only)
//   TRUST_PROXY           "1" to rate-limit launches by X-Forwarded-For (behind a proxy)
//   PORT                  listen port (default 8080)
//   DIST_DIR              static dir (default ./dist)
//
// Run:  npm run build  &&  node --env-file=.env.local server/index.mjs

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { login, logout, me, register, listUsers, setModelDeveloper, launch } from "./auth.mjs";
import {
  saveState,
  listStates,
  getState,
  deleteState,
  setDefaultState,
  setDefaultLocalState,
} from "./states.mjs";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const DIST = path.resolve(ROOT, process.env.DIST_DIR || "dist");
const PORT = Number(process.env.PORT || 8080);
const BOT_URL = process.env.EXPLAIN_BOT_URL || "";
const BOT_KEY = process.env.EXPLAIN_BOT_API_KEY || "";

// crossOriginIsolated === true activates SharedArrayBuffer (the preferred
// realtime transport; the app falls back to transferable ArrayBuffers without
// it, but we match dev for parity). Mirrors `crossOriginIsolation` in vite.config.ts.
const COI_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".webmanifest": "application/manifest+json",
};

// ---- POST /api/chat -> bot /v1/ask (API key stays server-side) ----
function handleChat(req, res) {
  const reply = (code, obj) => {
    res.writeHead(code, { ...COI_HEADERS, "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  if (!BOT_URL || !BOT_KEY) {
    return reply(500, {
      error: "explain bot not configured — set EXPLAIN_BOT_URL and EXPLAIN_BOT_API_KEY",
    });
  }
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", async () => {
    try {
      const { prompt, conversation_id, context, attachments } = JSON.parse(raw || "{}");
      // Prepend the live patient-state block so the bot can answer about "this
      // patient" (identical to the dev proxy).
      const fullPrompt = context
        ? `Current simulated patient state:\n${context}\n\n---\n\n${prompt ?? ""}`
        : (prompt ?? "");
      // Forward uploaded files (PDF/CSV/image) so the bot can extract target
      // values; its reply (incl. an optional built-patient `artifact`) is returned
      // verbatim below.
      const upstream = await fetch(`${BOT_URL}/v1/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": BOT_KEY },
        body: JSON.stringify({
          prompt: fullPrompt,
          ...(conversation_id ? { conversation_id } : {}),
          ...(Array.isArray(attachments) && attachments.length ? { attachments } : {}),
        }),
      });
      const text = await upstream.text();
      res.writeHead(upstream.status, {
        ...COI_HEADERS,
        "content-type": upstream.headers.get("content-type") ?? "application/json",
      });
      res.end(text);
    } catch (e) {
      reply(502, { error: `explain bot unreachable: ${String(e)}` });
    }
  });
}

// ---- /api/auth/* : login / logout / me (MongoDB + bcrypt + signed cookie) ----
// Shares server/auth.mjs with the dev proxy (vite.config.ts). Cookies are issued
// Secure here since prod is served over https. MONGODB_URI / AUTH_SECRET come from
// the process environment (run with `node --env-file=.env.local`).
function sendJson(res, code, obj, setCookie) {
  const headers = { ...COI_HEADERS, "content-type": "application/json" };
  if (setCookie) headers["set-cookie"] = setCookie;
  res.writeHead(code, headers);
  res.end(JSON.stringify(obj));
}

function handleAuth(req, res, route) {
  const respond = (r) => sendJson(res, r.status, r.body, r.setCookie);
  const fail = (e) => sendJson(res, 500, { error: `auth error: ${String(e)}` });

  if (route === "me") {
    if (req.method !== "GET") return res.writeHead(405, COI_HEADERS).end("method not allowed");
    return me(req.headers.cookie).then(respond).catch(fail);
  }
  if (route === "users") {
    if (req.method !== "GET") return res.writeHead(405, COI_HEADERS).end("method not allowed");
    return listUsers(req.headers.cookie).then(respond).catch(fail);
  }
  if (req.method !== "POST") return res.writeHead(405, COI_HEADERS).end("method not allowed");
  if (route === "logout") return respond(logout({ secure: true }));
  // login / register / set-model-developer — take a JSON body
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    let body = {};
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      /* treat as empty */
    }
    if (route === "set-model-developer") {
      return setModelDeveloper(req.headers.cookie, body).then(respond).catch(fail);
    }
    const handler = route === "register" ? register : login;
    handler(body, { secure: true }).then(respond).catch(fail);
  });
}

// GET /api/auth/launch?t=… — lesson launch: set the session cookie and redirect
// into the app. no-store + no-referrer so the token isn't cached or leaked onward.
function handleLaunch(req, res) {
  if (req.method !== "GET") return res.writeHead(405, COI_HEADERS).end("method not allowed");
  const token = new URL(req.url, "http://localhost").searchParams.get("t");
  const fwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const ip = (process.env.TRUST_PROXY === "1" && fwd) || req.socket.remoteAddress || "";
  const redirect = (r) => {
    const headers = {
      location: r.location,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    };
    if (r.setCookie) headers["set-cookie"] = r.setCookie;
    res.writeHead(r.status, headers);
    res.end();
  };
  launch(token, { secure: true, ip })
    .then(redirect)
    .catch((e) => {
      console.error("launch error:", String(e));
      redirect({ status: 302, location: "/login?launch=error" });
    });
}

// ---- /api/states/* : per-user save / list / get / delete of model states ----
// Auth-scoped (session cookie); shares server/states.mjs with the dev proxy.
function handleStates(req, res, route) {
  const respond = (r) => sendJson(res, r.status, r.body);
  const fail = (e) => sendJson(res, 500, { error: `states error: ${String(e)}` });
  const cookie = req.headers.cookie;

  if (route === "list") {
    if (req.method !== "GET") return res.writeHead(405, COI_HEADERS).end("method not allowed");
    return listStates(cookie).then(respond).catch(fail);
  }
  if (route === "get") {
    if (req.method !== "GET") return res.writeHead(405, COI_HEADERS).end("method not allowed");
    const id = new URL(req.url, "http://localhost").searchParams.get("id");
    return getState(cookie, id).then(respond).catch(fail);
  }
  // save / delete / set-default — POST with a JSON body
  if (req.method !== "POST") return res.writeHead(405, COI_HEADERS).end("method not allowed");
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    let body = {};
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      /* treat as empty */
    }
    const p =
      route === "delete"
        ? deleteState(cookie, body)
        : route === "set-default"
          ? setDefaultState(cookie, body)
          : route === "set-default-local"
            ? setDefaultLocalState(cookie, body)
            : saveState(cookie, body);
    p.then(respond).catch(fail);
  });
}

// ---- static dist/ with SPA fallback ----
function serveStatic(req, res) {
  const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  // resolve within DIST; reject traversal
  let filePath = path.resolve(DIST, "." + urlPath);
  if (!filePath.startsWith(DIST)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  let stat = fs.existsSync(filePath) && fs.statSync(filePath);
  if (stat && stat.isDirectory()) {
    filePath = path.join(filePath, "index.html");
    stat = fs.existsSync(filePath) && fs.statSync(filePath);
  }
  // SPA fallback: unknown non-asset path -> index.html (client-side routing)
  if (!stat) {
    filePath = path.join(DIST, "index.html");
    if (!fs.existsSync(filePath)) {
      res.writeHead(404, COI_HEADERS).end("not found — run `npm run build` first");
      return;
    }
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    ...COI_HEADERS,
    "content-type": MIME[ext] || "application/octet-stream",
  });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer((req, res) => {
  const reqPath = (req.url || "/").split("?")[0];
  if (reqPath === "/api/auth/login") return handleAuth(req, res, "login");
  if (reqPath === "/api/auth/register") return handleAuth(req, res, "register");
  if (reqPath === "/api/auth/logout") return handleAuth(req, res, "logout");
  if (reqPath === "/api/auth/me") return handleAuth(req, res, "me");
  if (reqPath === "/api/auth/users") return handleAuth(req, res, "users");
  if (reqPath === "/api/auth/launch") return handleLaunch(req, res);
  if (reqPath === "/api/auth/set-model-developer") return handleAuth(req, res, "set-model-developer");
  if (reqPath === "/api/states/save") return handleStates(req, res, "save");
  if (reqPath === "/api/states/list") return handleStates(req, res, "list");
  if (reqPath === "/api/states/get") return handleStates(req, res, "get");
  if (reqPath === "/api/states/delete") return handleStates(req, res, "delete");
  if (reqPath === "/api/states/set-default") return handleStates(req, res, "set-default");
  if (reqPath === "/api/states/set-default-local") return handleStates(req, res, "set-default-local");
  if (req.url?.startsWith("/api/chat")) {
    if (req.method !== "POST") {
      res.writeHead(405, COI_HEADERS).end("method not allowed");
      return;
    }
    return handleChat(req, res);
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, COI_HEADERS).end("method not allowed");
    return;
  }
  serveStatic(req, res);
});

// HOST unset = all interfaces (unchanged default); production sets HOST=127.0.0.1 behind a proxy.
server.listen({ port: PORT, host: process.env.HOST || undefined }, () => {
  console.log(`Explain app server on http://localhost:${PORT}`);
  console.log(`  static dir : ${path.relative(ROOT, DIST)}/`);
  console.log(`  /api/chat  : ${BOT_URL ? `-> ${BOT_URL}/v1/ask` : "NOT configured (set EXPLAIN_BOT_URL/KEY)"}`);
  console.log(`  /api/auth  : ${process.env.MONGODB_URI ? "MongoDB login enabled" : "NOT configured (set MONGODB_URI/AUTH_SECRET)"}`);
  console.log(`  /api/states: ${process.env.MONGODB_URI ? "per-user state save/load enabled" : "NOT configured (set MONGODB_URI)"}`);
  if (!fs.existsSync(DIST)) console.log(`  ! ${path.relative(ROOT, DIST)}/ missing — run \`npm run build\``);
});
