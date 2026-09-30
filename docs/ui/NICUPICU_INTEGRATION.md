# nicupicu.nl integration: lesson accounts and launch links

[nicupicu.nl](https://nicupicu.nl) teaches congenital heart lesions (tetralogy of Fallot, HLHS, d-TGA, …) to physicians in training and critical-care physicians. Each module links to Explain, and the learner lands straight in the right lesion scenario without seeing the login page.

This works through **one lesson account per lesion**, entered with a **launch link** instead of a password:

```
nicupicu module page ──(new tab)──▶ GET /api/auth/launch?t=<token>
                                     │ verify token → set explain_session cookie (8 h)
                                     ▼
                                   302 → /  ── MainPage loads the lesson's scenario
```

- **No password ever goes in a URL.** Passwords in links leak through browser history, server logs and `Referer` headers. The launch token takes the password's place. A lesson account has no password at all, so it cannot be used on `/login`.
- **The token disappears from the address bar** after the redirect. The launch response is sent with `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.
- **Open Explain in a new tab, not an iframe.** The session cookie is `SameSite=Lax`, so a top-level navigation carries it but a cross-site iframe does not, and browsers increasingly block third-party cookies anyway. The app's COOP/COEP headers also don't mix well with embedding.
- **A launch replaces any existing session.** A learner already logged in to Explain with a personal account becomes the lesson account after clicking a lesson link. Signing out and back in restores the personal account.

## Lesson accounts

A lesson account is a normal `users` document with a `lesson` profile and no `password`:

| field | meaning |
|---|---|
| `lesson.id` | Short id used in links, e.g. `tof` (`[a-z0-9_-]`, at most 40 characters). |
| `name` | Shown as the lesson badge in the header, e.g. "Tetralogy of Fallot". |
| `email` | `<id>@lesson.nicupicu`. It is only an internal key; self-registration with this domain is refused. |
| `lesson.scenario` | Bundled scenario to open (a file stem in `model_definitions/`). |
| `lesson.stateId` | *Optional.* Id of a curated cloud state; takes precedence over `scenario`. Anyone can own the state (usually the admin who built it), and the lesson account may read exactly this one. |
| `lesson.allowScenarioSwitch` | Show a scenario picker. Default off. |
| `lesson.readonly` | Default **on**. Cloud save, delete and set-default are refused by the server (403), and the save panel is hidden. |
| `launchKeyHash` | sha256 of the static launch key (mode A). |
| `disabled` | Blocks launches; existing sessions stop working on their next request. |

In the app, a lesson session shows the lesson title and a **Restart lesson** button, which reloads the starting scenario. The session lasts 8 hours.

## Managing accounts

`scripts/lesson-account.mjs` talks to the MongoDB named by `MONGODB_URI`. Run it from a machine whose `.env.local` points at the production `explain` database. Set `EXPLAIN_PUBLIC_URL`, or pass `--base`, so the printed links use the public origin (`https://modeling.explain-labs.com`).

```sh
S="node --env-file=.env.local scripts/lesson-account.mjs"
$S create  --id tof  --name "Tetralogy of Fallot" --scenario tof --base https://modeling.explain-labs.com
$S create  --id hlhs --name "Hypoplastic left heart syndrome" --scenario hlhs
$S update  --id tof  --state 66f0c0ffee…      # start from a curated cloud state instead
$S update  --id tof  --allow-switch           # let learners pick other scenarios
$S rotate  --id tof                           # new link; every old tof link stops working
$S disable --id tof                           # block launches and end sessions (enable undoes it)
$S list
```

The static link is printed **once**; only its hash is stored. If a link is lost, run `rotate` and update nicupicu.

## Launch tokens

`/api/auth/launch?t=` accepts two token forms, so nicupicu can start simple and harden later without any change on the Explain side.

### Mode A: static link (works today, from any static page or CMS)

The token is `<lessonId>.<random key>`, as printed by `create` and `rotate`. Put it on the module page:

```html
<a href="https://modeling.explain-labs.com/api/auth/launch?t=tof.Qm9…" target="_blank" rel="noopener noreferrer">
  Open the ToF model in Explain
</a>
```

Anyone who has the link can open the lesson. That is acceptable for read-only educational content, and it is no worse than a shared password. Rotate a link if it leaks.

### Mode B: signed, short-lived link (once nicupicu has its own backend)

nicupicu's server mints a fresh token for each click and redirects the learner to it. Only people logged in to nicupicu can reach Explain, and a copied link expires within minutes.

The token is an HS256 JWT signed with the shared secret `NICUPICU_LAUNCH_SECRET`, which is set on the Explain server. It must carry these claims:

| claim | value |
|---|---|
| `iss` | `"nicupicu"` |
| `aud` | `"explain"` |
| `sub` | the lesson id, e.g. `"tof"` |
| `iat`, `exp` | `exp - iat` ≤ 300 s (use 120 s) |
| `jti` | a unique id; each token works **once** |

Node reference signer:

```js
import crypto from "node:crypto";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
export function explainLaunchUrl(lessonId) {
  const now = Math.floor(Date.now() / 1000);
  const data = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({
    iss: "nicupicu", aud: "explain", sub: lessonId, iat: now, exp: now + 120, jti: crypto.randomUUID(),
  })}`;
  const sig = crypto.createHmac("sha256", process.env.NICUPICU_LAUNCH_SECRET).update(data).digest("base64url");
  return `https://modeling.explain-labs.com/api/auth/launch?t=${data}.${sig}`;
}
```

PHP reference signer:

```php
function explain_launch_url(string $lessonId): string {
    $b64 = fn($s) => rtrim(strtr(base64_encode($s), '+/', '-_'), '=');
    $now = time();
    $data = $b64(json_encode(['alg' => 'HS256', 'typ' => 'JWT'])) . '.' . $b64(json_encode([
        'iss' => 'nicupicu', 'aud' => 'explain', 'sub' => $lessonId,
        'iat' => $now, 'exp' => $now + 120, 'jti' => bin2hex(random_bytes(16)),
    ]));
    $sig = $b64(hash_hmac('sha256', $data, getenv('NICUPICU_LAUNCH_SECRET'), true));
    return "https://modeling.explain-labs.com/api/auth/launch?t=$data.$sig";
}
```

The module page links to a nicupicu route such as `/explain/tof`, which responds with `302 Location: explainLaunchUrl("tof")`.

- **Testing without nicupicu:** `node --env-file=.env.local scripts/lesson-account.mjs sign --id tof` prints a working mode-B link.
- **Retiring static links:** once every module page uses mode B, set `LAUNCH_STATIC_KEYS=off` on the Explain server.
- **LMS option:** if nicupicu is later built on an LMS (Moodle, Canvas), LTI 1.3 can be added as a third token form that feeds the same session flow.

## Server configuration

| env var | where | meaning |
|---|---|---|
| `TRUST_PROXY=1` | production (behind Caddy) | Rate-limit launches by the client IP in `X-Forwarded-For`. Without it, every request appears to come from `127.0.0.1`, and all visitors share one limit. |
| `NICUPICU_LAUNCH_SECRET` | when mode B is used | Shared secret for signed tokens. Generate one with `openssl rand -base64 32` and share it with nicupicu over a secure channel. |
| `LAUNCH_STATIC_KEYS=off` | optional | Reject mode-A links. |

## Failure handling

An invalid, expired, replayed or rate-limited token redirects to `/login?launch=invalid`, where the login page asks the learner to reopen the link from nicupicu.nl. The rate limit is 30 attempts per minute per IP. A server error redirects to `/login?launch=error`.

## Testing locally

Under `npm run dev` the app normally auto-logs in as the local developer. When a lesson launch has set a real session, the dev auth store adopts that session instead. You need a working `MONGODB_URI` and `AUTH_SECRET` in `.env.local`, then open `http://localhost:<dev port>/api/auth/launch?t=…`. Sign out to return to the developer account.
