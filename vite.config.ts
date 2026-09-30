import { defineConfig, loadEnv, type Plugin } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";
import fs from "node:fs";
import path from "node:path";

// Dev-only endpoint: POST /api/save-snapshot { name, data } writes a named
// scenario file into public/model_definitions/ and registers it in index.json,
// so snapshots become first-class scenarios selectable from the dropdown.
// DELETE /api/delete-snapshot removes a file and its index entry.
function snapshotApi(): Plugin {
  // Canonical scenario library now lives in the `explain-engine` submodule; the
  // app serves a synced mirror from public/ (see scripts/sync-scenarios.mjs). A
  // developer save writes to BOTH: canonical (committable in the submodule) and
  // served (so the running app sees it immediately).
  const canonicalDir = fileURLToPath(new URL("./explain-engine/model_definitions", import.meta.url));
  const servedDir = fileURLToPath(new URL("./public/model_definitions", import.meta.url));
  const safeName = (name: unknown) =>
    path.basename(String(name ?? "").trim().replace(/[^a-zA-Z0-9._-]/g, "_"));
  // Rebuild a directory's index.json as the sorted list of scenario basenames.
  const rebuildIndex = (d: string) => {
    const names = fs
      .readdirSync(d)
      .filter((f) => f.endsWith(".json") && f !== "index.json")
      .map((f) => f.slice(0, -".json".length))
      .sort();
    fs.writeFileSync(path.join(d, "index.json"), JSON.stringify(names, null, 2) + "\n");
  };

  // POST-with-JSON-body middleware helper
  const jsonPost = (
    handler: (body: any, reply: (code: number, obj: unknown) => void) => void,
  ) => {
    return (req: any, res: any, next: () => void) => {
      if (req.method !== "POST") return next();
      let raw = "";
      req.on("data", (c: Buffer) => (raw += c));
      req.on("end", () => {
        const reply = (code: number, obj: unknown) => {
          res.statusCode = code;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(obj));
        };
        try {
          handler(JSON.parse(raw || "{}"), reply);
        } catch (e) {
          reply(500, { ok: false, error: String(e) });
        }
      });
    };
  };

  // Guard: the local file-snapshot endpoints (save/delete). They only exist on
  // this local dev server, where the user is the auto-logged-in local developer
  // (no session cookie), so no MongoDB lookup is needed — model developers can
  // run without a DB or tunnel. The one exception is a lesson-launch session
  // being tested under dev: lesson accounts are read-only, so deny those. The
  // cookie is checked by signature only. Registered BEFORE each jsonPost handler
  // on the same path, so connect runs it first.
  const requireDeveloper = (req: any, res: any, next: () => void) => {
    if (req.method !== "POST") return next();
    const deny = (code: number, error: string) => {
      res.statusCode = code;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: false, error }));
    };
    Promise.all([import("./server/session.mjs"), import("./server/auth.mjs")])
      .then(([{ parseCookies, verifySession, COOKIE_NAME }, { LESSON_EMAIL_DOMAIN }]) => {
        let session: any = null;
        try {
          session = verifySession((parseCookies(req.headers.cookie) as Record<string, string>)[COOKIE_NAME]);
        } catch {
          /* no AUTH_SECRET → no real session can exist → the local developer */
        }
        if (String(session?.email ?? "").endsWith(`@${LESSON_EMAIL_DOMAIN}`)) {
          return deny(403, "model developers only");
        }
        next();
      })
      .catch((e) => deny(500, `auth error: ${String(e)}`));
  };

  return {
    name: "snapshot-api",
    configureServer(server) {
      server.middlewares.use("/api/save-snapshot", requireDeveloper);
      server.middlewares.use("/api/delete-snapshot", requireDeveloper);

      server.middlewares.use(
        "/api/save-snapshot",
        jsonPost(({ name, data }, reply) => {
          const safe = safeName(name);
          if (!safe) return reply(400, { ok: false, error: "invalid name" });
          const json = JSON.stringify(data, null, 2);
          fs.writeFileSync(path.join(canonicalDir, `${safe}.json`), json);
          fs.writeFileSync(path.join(servedDir, `${safe}.json`), json);
          rebuildIndex(canonicalDir);
          rebuildIndex(servedDir);
          reply(200, { ok: true, name: safe });
        }),
      );

      server.middlewares.use(
        "/api/delete-snapshot",
        jsonPost(({ name }, reply) => {
          const safe = safeName(name);
          if (!safe) return reply(400, { ok: false, error: "invalid name" });
          for (const d of [canonicalDir, servedDir]) {
            const file = path.join(d, `${safe}.json`);
            if (fs.existsSync(file)) fs.unlinkSync(file);
            rebuildIndex(d);
          }
          reply(200, { ok: true, name: safe });
        }),
      );
    },
  };
}

// Dev-only proxy: POST /api/chat { prompt, conversation_id?, context? } forwards
// to the "explain-labs_claude" bot (a Claude bot built specifically for this
// project, on the Tailnet port 8090) and echoes its reply back. The bot URL +
// API key are read from server-side env (EXPLAIN_BOT_URL / EXPLAIN_BOT_API_KEY)
// and NEVER exposed to the browser bundle — same reason the cradle-webapp proxies
// through a Next.js route instead of calling the bot directly. `env` is the
// loadEnv() result so values in .env.local are picked up without a VITE_ prefix
// (a VITE_ prefix would leak them into the client build).
function explainBotApi(env: Record<string, string>): Plugin {
  const baseUrl = env.EXPLAIN_BOT_URL || process.env.EXPLAIN_BOT_URL || "";
  const apiKey = env.EXPLAIN_BOT_API_KEY || process.env.EXPLAIN_BOT_API_KEY || "";

  return {
    name: "explain-bot-api",
    configureServer(server) {
      server.middlewares.use("/api/chat", (req: any, res: any, next: () => void) => {
        if (req.method !== "POST") return next();
        let raw = "";
        req.on("data", (c: Buffer) => (raw += c));
        req.on("end", async () => {
          const reply = (code: number, obj: unknown) => {
            res.statusCode = code;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify(obj));
          };
          if (!baseUrl || !apiKey) {
            return reply(400, {
              error:
                "explain bot not configured — set EXPLAIN_BOT_URL and EXPLAIN_BOT_API_KEY in .env.local and restart the dev server",
            });
          }
          try {
            const { prompt, conversation_id, context, attachments } = JSON.parse(raw || "{}");
            // Prepend the live patient-state block so the bot can answer about
            // "this patient". The bot treats the whole string as the user turn.
            const fullPrompt = context
              ? `Current simulated patient state:\n${context}\n\n---\n\n${prompt ?? ""}`
              : (prompt ?? "");
            // Forward any uploaded files (PDF/CSV/image) so the bot can extract
            // target values. The bot's reply (incl. an optional `artifact` with a
            // built patient definition) is returned verbatim below.
            const upstream = await fetch(`${baseUrl}/v1/ask`, {
              method: "POST",
              headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
              body: JSON.stringify({
                prompt: fullPrompt,
                ...(conversation_id ? { conversation_id } : {}),
                ...(Array.isArray(attachments) && attachments.length ? { attachments } : {}),
              }),
            });
            const text = await upstream.text();
            res.statusCode = upstream.status;
            res.setHeader(
              "content-type",
              upstream.headers.get("content-type") ?? "application/json",
            );
            res.end(text);
          } catch (e) {
            reply(502, { error: `explain bot unreachable: ${String(e)}` });
          }
        });
      });
    },
  };
}

// Dev-only auth proxy: POST /api/auth/login, POST /api/auth/logout, GET
// /api/auth/me. Credentials are checked against MongoDB (MONGODB_URI) with bcrypt
// and a signed HttpOnly session cookie is issued (AUTH_SECRET). MongoDB/bcrypt run
// only in this Node dev process — they are never bundled into the client, exactly
// like the EXPLAIN_BOT_API_KEY isolation above. Auth logic lives in shared
// server/*.mjs modules reused verbatim by the prod server (server/index.mjs).
function authApi(env: Record<string, string>): Plugin {
  // The shared server/*.mjs modules read process.env (as the prod server does via
  // --env-file). Vite's loadEnv() does NOT populate process.env, so bridge the two
  // server-side-only secrets across here without exposing them to the client.
  if (env.MONGODB_URI && !process.env.MONGODB_URI) process.env.MONGODB_URI = env.MONGODB_URI;
  if (env.AUTH_SECRET && !process.env.AUTH_SECRET) process.env.AUTH_SECRET = env.AUTH_SECRET;
  for (const k of ["NICUPICU_LAUNCH_SECRET", "LAUNCH_STATIC_KEYS"]) {
    if (env[k] && !process.env[k]) process.env[k] = env[k];
  }
  return {
    name: "auth-api",
    configureServer(server) {
      // Lazy import keeps mongodb out of the config-eval path until a request hits.
      const handlers = () => import("./server/auth.mjs");
      const sendJson = (res: any, code: number, obj: unknown, setCookie?: string) => {
        res.statusCode = code;
        res.setHeader("content-type", "application/json");
        if (setCookie) res.setHeader("set-cookie", setCookie);
        res.end(JSON.stringify(obj));
      };
      const readBody = (req: any) =>
        new Promise<any>((resolve) => {
          let raw = "";
          req.on("data", (c: Buffer) => (raw += c));
          req.on("end", () => {
            try {
              resolve(JSON.parse(raw || "{}"));
            } catch {
              resolve({});
            }
          });
        });

      server.middlewares.use("/api/auth/login", (req: any, res: any, next: () => void) => {
        if (req.method !== "POST") return next();
        readBody(req).then(async (body) => {
          try {
            const { login } = await handlers();
            const r = await login(body, { secure: false });
            sendJson(res, r.status, r.body, r.setCookie);
          } catch (e) {
            sendJson(res, 500, { error: `auth error: ${String(e)}` });
          }
        });
      });

      server.middlewares.use("/api/auth/register", (req: any, res: any, next: () => void) => {
        if (req.method !== "POST") return next();
        readBody(req).then(async (body) => {
          try {
            const { register } = await handlers();
            const r = await register(body, { secure: false });
            sendJson(res, r.status, r.body, r.setCookie);
          } catch (e) {
            sendJson(res, 500, { error: `auth error: ${String(e)}` });
          }
        });
      });

      server.middlewares.use("/api/auth/logout", (req: any, res: any, next: () => void) => {
        if (req.method !== "POST") return next();
        handlers().then(({ logout }) => {
          const r = logout({ secure: false });
          sendJson(res, r.status, r.body, r.setCookie);
        });
      });

      server.middlewares.use("/api/auth/me", (req: any, res: any, next: () => void) => {
        if (req.method !== "GET") return next();
        handlers().then(async ({ me }) => {
          try {
            const r = await me(req.headers.cookie);
            sendJson(res, r.status, r.body, r.setCookie);
          } catch (e) {
            sendJson(res, 500, { error: `auth error: ${String(e)}` });
          }
        });
      });

      // GET /api/auth/launch?t=… — nicupicu lesson launch (see server/auth.mjs launch()).
      server.middlewares.use("/api/auth/launch", (req: any, res: any, next: () => void) => {
        if (req.method !== "GET") return next();
        const token = new URL(req.url, "http://localhost").searchParams.get("t");
        const redirect = (r: { status: number; location: string; setCookie?: string }) => {
          res.statusCode = r.status;
          res.setHeader("location", r.location);
          res.setHeader("cache-control", "no-store");
          res.setHeader("referrer-policy", "no-referrer");
          if (r.setCookie) res.setHeader("set-cookie", r.setCookie);
          res.end();
        };
        handlers()
          .then(({ launch }) => launch(token, { secure: false, ip: req.socket.remoteAddress || "" }))
          .then(redirect)
          .catch((e) => {
            console.error("launch error:", String(e));
            redirect({ status: 302, location: "/login?launch=error" });
          });
      });

      server.middlewares.use("/api/auth/users", (req: any, res: any, next: () => void) => {
        if (req.method !== "GET") return next();
        handlers().then(async ({ listUsers }) => {
          try {
            const r = await listUsers(req.headers.cookie);
            sendJson(res, r.status, r.body);
          } catch (e) {
            sendJson(res, 500, { error: `auth error: ${String(e)}` });
          }
        });
      });

      server.middlewares.use(
        "/api/auth/set-model-developer",
        (req: any, res: any, next: () => void) => {
          if (req.method !== "POST") return next();
          readBody(req).then(async (body) => {
            try {
              const { setModelDeveloper } = await handlers();
              const r = await setModelDeveloper(req.headers.cookie, body);
              sendJson(res, r.status, r.body);
            } catch (e) {
              sendJson(res, 500, { error: `auth error: ${String(e)}` });
            }
          });
        },
      );
    },
  };
}

// Dev-only proxy: /api/states/* — per-user save / list / get / delete of full
// model states in MongoDB. Auth-scoped (session cookie); shares server/states.mjs
// verbatim with the prod server (server/index.mjs). Relies on authApi() above
// having bridged MONGODB_URI / AUTH_SECRET into process.env.
function statesApi(): Plugin {
  return {
    name: "states-api",
    configureServer(server) {
      const handlers = () => import("./server/states.mjs");
      const sendJson = (res: any, code: number, obj: unknown) => {
        res.statusCode = code;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(obj));
      };
      const readBody = (req: any) =>
        new Promise<any>((resolve) => {
          let raw = "";
          req.on("data", (c: Buffer) => (raw += c));
          req.on("end", () => {
            try {
              resolve(JSON.parse(raw || "{}"));
            } catch {
              resolve({});
            }
          });
        });
      const fail = (res: any, e: unknown) =>
        sendJson(res, 500, { error: `states error: ${String(e)}` });

      server.middlewares.use("/api/states/save", (req: any, res: any, next: () => void) => {
        if (req.method !== "POST") return next();
        readBody(req).then(async (body) => {
          try {
            const { saveState } = await handlers();
            const r = await saveState(req.headers.cookie, body);
            sendJson(res, r.status, r.body);
          } catch (e) {
            fail(res, e);
          }
        });
      });

      server.middlewares.use("/api/states/list", (req: any, res: any, next: () => void) => {
        if (req.method !== "GET") return next();
        handlers().then(async ({ listStates }) => {
          try {
            const r = await listStates(req.headers.cookie);
            sendJson(res, r.status, r.body);
          } catch (e) {
            fail(res, e);
          }
        });
      });

      server.middlewares.use("/api/states/get", (req: any, res: any, next: () => void) => {
        if (req.method !== "GET") return next();
        handlers().then(async ({ getState }) => {
          try {
            const id = new URL(req.url, "http://localhost").searchParams.get("id");
            const r = await getState(req.headers.cookie, id);
            sendJson(res, r.status, r.body);
          } catch (e) {
            fail(res, e);
          }
        });
      });

      server.middlewares.use("/api/states/delete", (req: any, res: any, next: () => void) => {
        if (req.method !== "POST") return next();
        readBody(req).then(async (body) => {
          try {
            const { deleteState } = await handlers();
            const r = await deleteState(req.headers.cookie, body);
            sendJson(res, r.status, r.body);
          } catch (e) {
            fail(res, e);
          }
        });
      });

      server.middlewares.use("/api/states/set-default", (req: any, res: any, next: () => void) => {
        if (req.method !== "POST") return next();
        readBody(req).then(async (body) => {
          try {
            const { setDefaultState } = await handlers();
            const r = await setDefaultState(req.headers.cookie, body);
            sendJson(res, r.status, r.body);
          } catch (e) {
            fail(res, e);
          }
        });
      });

      server.middlewares.use(
        "/api/states/set-default-local",
        (req: any, res: any, next: () => void) => {
          if (req.method !== "POST") return next();
          readBody(req).then(async (body) => {
            try {
              const { setDefaultLocalState } = await handlers();
              const r = await setDefaultLocalState(req.headers.cookie, body);
              sendJson(res, r.status, r.body);
            } catch (e) {
              fail(res, e);
            }
          });
        },
      );
    },
  };
}

// COOP/COEP make `crossOriginIsolated === true`, which activates
// SharedArrayBuffer — the preferred realtime data-plane transport
// (ChannelWriter auto-falls back to transferable ArrayBuffers when these
// headers are absent, so the app still works without them).
const crossOriginIsolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig(({ mode }) => {
  // Load all env (no prefix filter) so server-side-only EXPLAIN_BOT_* vars in
  // .env.local reach the chat proxy without being exposed to the client bundle.
  const env = loadEnv(mode, process.cwd(), "");
  return {
  plugins: [vue(), tailwindcss(), snapshotApi(), explainBotApi(env), authApi(env), statesApi()],
  // Whether the dev server has a MongoDB configured (a boolean only — never the
  // URI). Without one, `npm run dev` runs in local mode: the client hides the
  // DB-backed features (cloud states, admin) instead of calling them. Read by the
  // client only under DEV (see src/stores/auth.ts); prod always has the DB.
  define: { __EXPLAIN_DEV_DB__: JSON.stringify(!!env.MONGODB_URI) },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@explain": fileURLToPath(new URL("./explain-engine", import.meta.url)),
    },
  },
  // the ModelEngine worker is spawned as an ES module
  worker: { format: "es" },
  // Split the heavy front-end vendors into their own chunks so no single chunk
  // blows past the 500 kB warning and the browser can cache them independently.
  // (mongodb/bcryptjs are server-only — lazy-imported in the dev plugins above —
  // so they never reach the client bundle.)
  build: {
    // pixi.js (~554 kB) and primevue (~591 kB) are single libraries already
    // tree-shaken to what we use; they can't be split further without dynamic
    // imports, so lift the warning threshold above them.
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (!id.includes("node_modules")) return;
          if (id.includes("pixi.js")) return "pixi";
          if (id.includes("primevue") || id.includes("@primevue") || id.includes("primeicons"))
            return "primevue";
          if (id.includes("markdown-it")) return "markdown";
          if (id.includes("uplot")) return "uplot";
          if (id.includes("/vue/") || id.includes("@vue") || id.includes("vue-router") || id.includes("pinia"))
            return "vue";
        },
      },
    },
  },
  server: { headers: crossOriginIsolation },
  preview: { headers: crossOriginIsolation },
  };
});
