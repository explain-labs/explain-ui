# Production server

Zero-dependency Node server for the built app. It does the two things `vite`
does in dev but a static `dist/` can't: serves the SPA with the COOP/COEP headers
the realtime engine wants, and hosts `POST /api/chat` as a server-side proxy to
the Explain bot (so the API key never reaches the browser).

Command parsing stays in the browser (`src/services/botCommands.ts`), so this
proxy is a dumb passthrough — the same contract as the dev proxy in
`vite.config.ts`.

## Run

```sh
npm run build                 # produces dist/
npm run start                 # node --env-file=.env.local server/index.mjs  (Node 20.6+)
# or, if your process manager already injects env vars:
npm run serve                 # node server/index.mjs
```

Then open `http://localhost:8080` (override with `PORT`).

## Env

| var | meaning |
|-----|---------|
| `EXPLAIN_BOT_URL` | bot base URL, e.g. `http://lucys-mac-mini.tail990503.ts.net:8091` (proxy hits `${EXPLAIN_BOT_URL}/v1/ask`) |
| `EXPLAIN_BOT_API_KEY` | bot `X-API-Key` |
| `PORT` | listen port (default `8080`) |
| `HOST` | listen address (default: all interfaces; set `127.0.0.1` behind a reverse proxy) |
| `DIST_DIR` | static dir (default `dist`) |

The same `.env.local` used by `npm run dev` works here via `--env-file`
(`EXPLAIN_BOT_URL` / `EXPLAIN_BOT_API_KEY` are read with no `VITE_` prefix, so they
stay server-side and never enter the client bundle).

## Notes

- Needs Node 18+ (global `fetch`); `npm run start` needs Node 20.6+ for `--env-file`.
- Requires network reach to the bot (e.g. on the Tailnet) just like dev.
- Behind TLS/another reverse proxy, forward `/api/chat` and the static routes to
  this server unchanged; keep the COOP/COEP response headers intact.
