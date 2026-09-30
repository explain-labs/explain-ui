# PagesAndAuth

The app is a three-route Vue SPA: a single working page (`MainPage.vue`) behind an auth gate, plus a login and a register screen. Authentication is **cookie-based** — credentials are checked server-side (MongoDB + bcrypt) and the session is a signed **HttpOnly** cookie the client JS cannot read; the Pinia auth store mirrors only the public user fields and never holds a token. The router guard is a UX gate; the server-side cookie check is the real security boundary. Everything the user actually interacts with lives inside `MainPage.vue`, a three-column PrimeVue `Tabs` workspace over the two-plane engine bridge (control plane via `useExplain`, data plane via `useRealtimeBus`; see [UI_ARCHITECTURE](./UI_ARCHITECTURE.md)).

## What lives here

| File | Responsibility |
|---|---|
| `src/main.ts` | App bootstrap: Pinia, router, PrimeVue (`DarkBlue` Aura preset), `v-tooltip`, `ConfirmationService` |
| `src/App.vue` | Shell — just `<router-view />` |
| `src/router/index.ts` | Three routes + `beforeEach` auth guard |
| `src/stores/auth.ts` | `useAuthStore`: session state, `fetchMe()`, dev auto-login, admin helpers |
| `src/pages/MainPage.vue` | The three-column workspace (controls / viz / numerics + run bar) |
| `src/pages/LoginPage.vue` | Branded sign-in form |
| `src/pages/RegisterPage.vue` | Open self-registration form |

## `main.ts` bootstrap

`createApp(App)` chains `createPinia()`, `router`, `PrimeVue`, and `ConfirmationService`, registers the `tooltip` directive (used everywhere as `v-tooltip.top=…`), and mounts `#app`. The PrimeVue theme is a **`DarkBlue` preset** built with `definePreset(Aura, …)` — it remaps Aura's emerald primary to the blue palette and sets a deep-blue dark-mode accent (`darkModeSelector: ".dark"`). Styles: `primeicons/primeicons.css` + `./styles/theme.css`.

## Routes + guard (`router/index.ts`)

| Path | Name | Component | Meta |
|---|---|---|---|
| `/` | `main` | `MainPage` | `requiresAuth: true` |
| `/login` | `login` | `LoginPage` | — |
| `/register` | `register` | `RegisterPage` | — |

History mode is `createWebHistory()`. `beforeEach(async (to))`:

1. On the first navigation, rehydrate the session from the cookie — `if (!auth.ready) await auth.fetchMe()`.
2. A `requiresAuth` route hit by an unauthenticated user → redirect to `{ name: "login", query: { redirect: to.fullPath } }`.
3. An already-authed user visiting `/login` or `/register` → bounced to `{ name: "main" }`.

The guard comment is explicit that this is a UX gate; the server's cookie check is the real boundary.

## `stores/auth.ts` (`useAuthStore`)

State: `user: AuthUser | null`, `status` (`idle`/`loading`/`authed`/`error`), `error`, `ready` (initial cookie check done), and the `isAuthenticated` getter (`user !== null`). **`AuthUser` is public-only** — `email`, `name`, `admin`, `institution`, `modelDeveloper`, `defaultState`, `defaultLocalState`. There is **no token**: the session is the HttpOnly cookie, so all fetches pass `credentials: "include"` and the store just mirrors what the server hands back.

| Method | Purpose |
|---|---|
| `login(email, password)` | POST `/api/auth/login`; on success stores `data.user` + sets `ready`. |
| `register(fields)` | POST `/api/auth/register`; server signs the user in (sets cookie) on success. |
| `fetchMe()` | Rehydrate from the cookie via `/api/auth/me`. **Dev bypass:** in `import.meta.env.DEV` it auto-logs-in a local `developer` account (`makeDevUser`) and never touches MongoDB. |
| `logout()` | POST `/api/auth/logout`; clears client state regardless of network outcome. |
| `listUsers()` / `setModelDeveloper(email, value)` | Admin-only (`/api/auth/users`, `/api/auth/set-model-developer`). |
| `setDefaultLocalState(name)` | Dev-only: persist the developer's startup scenario to `localStorage`. |

**Dev mode** skips Atlas entirely: `makeDevUser()` returns a local `developer@localhost` that is `admin: true` (so admin-only UI doesn't error) and `modelDeveloper: true` (unlocks the scenario picker + star toggle); its default local scenario is persisted per-device in `localStorage` (`explain.model.defaultLocalState`), mirroring the cloud `defaultLocalState` field.

## `MainPage.vue` — the workspace

Rendered only when `modelReady`. A sticky top header (logo, active-state name, user email, admin button, sign out), a three-column body, and a sticky bottom run bar.

### Three-column body (PrimeVue `Tabs`)

| Column | Tab model | Tabs |
|---|---|---|
| **Left ¼** — controls | `controlTab` (`"editor"`) | Model editor · Ventilator · ECLS · Resuscitation · Pregnancy/Labor · Scaler · Event scheduler |
| **Center ½** — visualization | `vizTab` (`"diagram"`) | `diagram` · `chart` · `loop` (PV-loop) · `monitor` · `ventilator` · `chat` |
| **Right ¼** — numerics | `monitorTab` (`"monitoring"`) | Monitoring (`NumericReadoutPanel` per group + export/compact/trend-window/manage controls) |

The center `chat` tab hosts `ChatPanel.vue` (see [ChatAndBot](./ChatAndBot.md)). The monitoring column derives its groups from the monitors store, synced to the scenario's `configuration.monitors` on every (re)build (`watch(modelReady, …, {immediate:true})`), and supports inline dashboard management + CSV/TSV snapshot export.

### Bottom run bar (3-col grid)

- **Left:** status indicators — `COI` (cross-origin-isolated → SharedArrayBuffer transport), `MODEL LOADED` (`modelReady`), `STATUS`, and any `error`.
- **Center:** play/stop toggle (`toggleRun`, also bound to **Spacebar** via a window keydown listener that ignores typing in inputs/textareas/selects/buttons), plus a fast-forward `calculate(calcSecs)` with a seconds `Select` (`CALC_OPTIONS`).
- **Right:** local-model loading — **only for `modelDeveloper` users** (scenario `Select`, startup-default star toggle `toggleDefaultLocal`, delete-definition) — plus `SaveStatePanel`.

### Startup load priority (`onMounted`)

0. A **lesson account** (nicupicu.nl launch) always opens its own lesson via `loadLesson()`: `lesson.stateId` if set, else `lesson.scenario`. See [Lesson launch](#lesson-launch-nicupicunl) below.
1. A model developer's chosen **local** scenario (`defaultLocalState`, if present in the scenario list).
2. The user's default **cloud** state (`defaultState` → `statesStore.loadState` → `loadFromObject`).
3. The bundled `term_neonate` (or the first available scenario).

Selecting a scenario loads it immediately (`watch(current, …)`); no Load button.

## Login / Register pages

Both are branded, centered forms backed entirely by the auth store; both call `auth.fetchMe()` on mount and skip straight into the app if already authenticated.

- **`LoginPage`** — email + password (`Password`, `:feedback="false"`, `toggle-mask`). On success routes to `redirectTarget()` — the `?redirect=` query (only if it starts with `/`) or `/`.
- **`RegisterPage`** — name, email, institution, password + confirm. Client-side checks: name & email non-empty, password ≥ `MIN_PASSWORD` (8), passwords match (`mismatch`/`canSubmit`). Creates a non-admin account; the server signs the user in (cookie) on success → routes to `/`. Open self-registration.

## Lesson launch (nicupicu.nl)

`GET /api/auth/launch?t=<token>` logs a visitor straight into a per-lesion **lesson account** and redirects to `/`, skipping `/login`. Accounts are managed with `scripts/lesson-account.mjs`; the token formats, the reference signers for nicupicu and the server env vars are in [NICUPICU_INTEGRATION](./NICUPICU_INTEGRATION.md).

- `AuthUser.lesson` (a `LessonProfile`, `null` for normal accounts) and the `auth.lesson` getter carry the profile: `id`, `title`, `scenario`, `stateId`, `allowScenarioSwitch`, `readonly`.
- In lesson mode `MainPage` shows the lesson title plus a **Restart lesson** button (`loadLesson()`) instead of the email, hides `SaveStatePanel` when `readonly`, and shows a plain scenario `Select` only when `allowScenarioSwitch`.
- The real gate is on the server: `server/states.mjs` answers 403 to save/delete/set-default for read-only lesson accounts, and lets a lesson read exactly its own `lesson.stateId`.
- A failed launch lands on `/login?launch=invalid` (or `=error`); `LoginPage` shows a short explanation.
- **Dev:** `fetchMe()` first asks `/api/auth/me` and adopts the session only if it is a lesson account, so a launch can be tested under `npm run dev`; otherwise it keeps the local developer.

## Wiring

```
main.ts ── createApp(App) + Pinia + router + PrimeVue(DarkBlue) + ConfirmationService + v-tooltip
   │
App.vue <router-view/>
   │
router.beforeEach ── auth.fetchMe() (cookie rehydrate; DEV → makeDevUser)
   │                     │ requiresAuth & !authed → /login?redirect=…
   ▼                     │ authed & on /login|/register → /main
/login  /register  ───── auth.login / auth.register (credentials: "include", HttpOnly cookie)
   │
/main (MainPage) ── controlTab | vizTab | monitorTab Tabs over useExplain (control) + renderers (data)
```

## Gotchas

- **No token, ever.** The session is an HttpOnly cookie; the store mirrors public fields only. Every auth fetch must send `credentials: "include"`.
- **Guard ≠ security.** `beforeEach` is a UX gate; a determined client can route freely — the server cookie check on each `/api/*` call is the boundary.
- **Dev auto-login bypasses MongoDB.** `import.meta.env.DEV` makes `fetchMe()` mint a local admin/model-developer `developer@localhost`; the only real session it adopts in dev is a lesson launch. Production (`DEV === false`) always uses the real login. The dev developer's startup default lives in `localStorage`, not MongoDB.
- **`redirect` is validated.** `redirectTarget()` only honours a `?redirect=` that starts with `/` (open-redirect guard).
- **Model-developer-only UI.** The scenario picker, startup-star toggle, and delete-definition button render only for `auth.user?.modelDeveloper`; `AdminUsersButton` only for `admin`.
- **COI matters for performance.** The bottom-bar `COI` flag reflects `globalThis.crossOriginIsolated`; the SharedArrayBuffer realtime transport is active only when the app is cross-origin isolated.
