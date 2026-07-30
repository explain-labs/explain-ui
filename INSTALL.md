# Installation Guide

This is the **Explain** web app — a Vue 3 + Vite + TypeScript front end around the
`explain/` physiological simulation engine (which runs in a Web Worker). This guide covers
**macOS**, **Windows**, and **Linux**.

> **The simulator runs fully standalone.** `npm install` + `npm run dev` is all you need to
> run the engine and the whole UI locally. The optional backend (AI chat, user accounts,
> server-saved states) needs extra config — see [Optional: backend features](#optional-backend-features).
> No native compilation is required (all dependencies are pure JavaScript), so you do **not**
> need Python, a C/C++ toolchain, Xcode, or Visual Studio Build Tools.

---

## 1. Prerequisites

You need two things: **Node.js** and **git**.

- **Node.js 20.12 LTS or newer** (Node 22 LTS recommended). Vite 6 requires Node 18.18+, and
  the production server script (`npm run start`) uses `--env-file`, which needs **Node 20.6+**.
  Installing Node also installs **npm**, the package manager this project uses.
- **git** — to clone the repository.

Verify after installing:

```sh
node -v   # should print v20.12+ (ideally v22.x)
npm -v
git --version
```

### macOS

Pick one:

**Option A — Homebrew (simplest).** If you don't have Homebrew, install it from
<https://brew.sh>, then:

```sh
brew install node git
```

**Option B — nvm (recommended if you juggle Node versions).**

```sh
brew install nvm        # then follow the printed instructions to add nvm to your shell profile
nvm install --lts
nvm use --lts
```

git is also bundled with the Xcode Command Line Tools (`xcode-select --install`) if you
prefer not to use Homebrew for it.

### Windows

**Option A — winget (built into Windows 10/11).** In PowerShell:

```powershell
winget install OpenJS.NodeJS.LTS
winget install Git.Git
```

Close and reopen your terminal afterward so `PATH` updates.

**Option B — installers.** Download the **LTS** Node installer from
<https://nodejs.org> and git from <https://git-scm.com/download/win>, and run both.

**Option C — nvm-windows** (for multiple Node versions): install from
<https://github.com/coreybutler/nvm-windows/releases>, then `nvm install lts` and
`nvm use <version>`.

> **Terminal:** use **PowerShell** or **Windows Terminal**. The commands in this guide work
> as-is there. (Optional: WSL2 gives you a full Linux environment — if you use it, follow the
> Linux steps instead.)

### Linux

**Option A — nvm (recommended; avoids `sudo`/distro-version issues).**

```sh
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
# reopen the terminal (or `source ~/.bashrc`), then:
nvm install --lts
nvm use --lts
sudo apt-get install -y git          # Debian/Ubuntu; use your distro's package manager otherwise
```

**Option B — NodeSource (system-wide install).** For Debian/Ubuntu:

```sh
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git
```

> Avoid the default `apt`/`dnf` `nodejs` package on older distros — it is often too old for
> Vite 6. nvm or NodeSource gives you a current LTS.

---

## 2. Get the code and install dependencies

```sh
git clone --recurse-submodules <repository-url>
cd explain-ui
npm install
```

`--recurse-submodules` is required: the simulation engine lives in a separate repository
mounted at `explain-engine/`, and without the flag that directory is left empty and nothing
runs. If you already cloned without it, `git submodule update --init` fixes an existing
checkout.

`npm install` reads `package-lock.json` and downloads dependencies into `node_modules/`
(this takes a minute or two the first time). Use plain **npm** — don't mix in yarn/pnpm, so
the lockfile stays authoritative.

> On Windows, if you cloned into a deeply nested folder and hit a path-length error, either
> clone closer to the drive root (e.g. `C:\dev\`) or enable long paths:
> `git config --system core.longpaths true`.

---

## 3. Run the app (development)

```sh
npm run dev
```

Vite prints a local URL — open **<http://localhost:5173>** in a modern browser
(Chrome, Edge, Firefox, or Safari). The page hot-reloads as you edit. Stop the server with
`Ctrl+C`.

That's it — the simulation engine, scenarios, charts, and diagram editor all work with no
further setup.

### Available scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start the Vite dev server (hot reload) at `http://localhost:5173`. |
| `npm run build` | Type-check (`vue-tsc --noEmit`) then build the production bundle into `dist/`. |
| `npm run preview` | Serve the built `dist/` locally to sanity-check a production build. |
| `npm run typecheck` | Run the TypeScript type-check only (no build). |
| `npm run start` | Run the production Node server (`server/index.mjs`) with `.env.local`. See below. |
| `npm run serve` | Same production server, but expects env vars already in the environment. |

---

## 4. Production build & serve

```sh
npm run build      # outputs dist/
npm run start      # serves dist/ on http://localhost:8080 (override with PORT)
```

`npm run start` runs a tiny zero-dependency Node server (`server/index.mjs`) that serves the
static build **with the COOP/COEP headers the realtime engine prefers** and hosts the
optional `/api/*` backend routes. It loads `.env.local` via `--env-file` (Node 20.6+). If your
process manager already injects env vars, use `npm run serve` instead. Override the port with
the `PORT` env var and the static directory with `DIST_DIR`.

> **Why the COOP/COEP headers?** They make `crossOriginIsolated === true`, which enables
> `SharedArrayBuffer` — the preferred realtime data-plane transport. The engine
> **automatically falls back** to transferable `ArrayBuffer`s when the headers are absent, so
> the app still works behind reverse proxies that strip them; you just lose the fastest path.
> If you put this behind nginx/Caddy/etc., preserve those two response headers for best
> performance.

---

## Optional: backend features

The **AI chat panel ("Explain Labs"), user login/registration, and server-saved model
states** are extra features that need a backend. Without configuration these features are
simply inactive — **the simulator itself is unaffected.**

To enable them, copy the example env file and fill it in:

```sh
cp .env.local.example .env.local      # Windows PowerShell: copy .env.local.example .env.local
```

| Variable | Enables | Notes |
|---|---|---|
| `EXPLAIN_BOT_URL` | AI chat (`/api/chat`) | Base URL of the Explain bot; the proxy calls `${EXPLAIN_BOT_URL}/v1/ask`. The bot lives on a private Tailnet, so this machine must be able to reach it. |
| `EXPLAIN_BOT_API_KEY` | AI chat | The bot's `X-API-Key`. |
| `MONGODB_URI` | Login & saved states | Full MongoDB connection string (the database name is taken from the path). |
| `AUTH_SECRET` | Login sessions | Secret used to sign session cookies. Generate one with `openssl rand -base64 32`. |

> **Never** prefix these with `VITE_` — that would inline the secrets into the client bundle.
> They are read server-side only (by the Vite dev middleware in development, and by
> `server/index.mjs` in production). See `server/README.md` for backend specifics.

After editing `.env.local`, restart `npm run dev` (or `npm run start`) so the values are
picked up.

---

## Troubleshooting

- **`node: command not found` / wrong version after install** — open a **new** terminal so
  `PATH` updates. With nvm, run `nvm use --lts` in each new shell (or set a default:
  `nvm alias default lts/*`).
- **Vite errors mentioning an unsupported Node version** — you're on Node < 18.18. Upgrade to
  Node 20.12+ / 22 LTS.
- **Windows: `npm` scripts blocked by execution policy** — if PowerShell refuses to run
  `npm.ps1`, run once:
  `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned`.
- **Port 5173 (dev) or 8080 (prod) already in use** — for dev: `npm run dev -- --port 5174`;
  for prod: `PORT=5174 npm run start` (PowerShell: `$env:PORT=5174; npm run start`).
- **Chat panel says the bot isn't configured** — set `EXPLAIN_BOT_URL` + `EXPLAIN_BOT_API_KEY`
  in `.env.local` and restart. This is expected when the backend isn't set up; the simulator
  still works.
- **A blank page or worker errors after a stale build** — delete `node_modules/.vite` (Vite's
  cache) and restart, or reinstall with `rm -rf node_modules && npm install`
  (Windows: `rmdir /s /q node_modules` then `npm install`).

---

## Next steps

- **Writing your own models and scenarios:** [`STUDENT_WORKFLOW.md`](./STUDENT_WORKFLOW.md) —
  branches, the custom-model extension points, and how to hand work in.
- **Documentation index:** [`docs/README.md`](./docs/README.md) — the UI⇄engine map.
- **Engine architecture & model reference:** [`explain-engine/README.md`](./explain-engine/README.md)
  and the per-model docs in [`explain-engine/docs/`](./explain-engine/docs/) (start with
  [`explain-engine/docs/ARCHITECTURE.md`](./explain-engine/docs/ARCHITECTURE.md)). Both live in the
  engine submodule — run `git submodule update --init` if that directory is empty.
- **UI architecture:** [`docs/ui/UI_ARCHITECTURE.md`](./docs/ui/UI_ARCHITECTURE.md).
- **Production server details:** [`server/README.md`](./server/README.md).
