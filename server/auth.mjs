// Transport-agnostic auth handlers, shared by the dev (vite.config.ts) and prod
// (server/index.mjs) wrappers. Each returns { status, body, setCookie? } so the
// caller only has to write the HTTP response — no Express/Connect coupling.

import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { getUsersCollection, getLaunchJtiCollection } from "./db.mjs";
import { seedDefaultState } from "./states.mjs";
import {
  signSession,
  verifySession,
  parseCookies,
  sessionCookie,
  clearCookie,
  COOKIE_NAME,
} from "./session.mjs";

/**
 * @typedef {{ status: number, body: any, setCookie?: string }} AuthResult
 */

// Fields safe to expose to the browser (never the password hash / _id internals).
function publicUser(doc) {
  return {
    email: doc.email,
    name: doc.name ?? "",
    admin: !!doc.admin,
    institution: doc.institution ?? "",
    modelDeveloper: !!doc.modelDeveloper,
    defaultState: doc.defaultState ?? null,
    defaultLocalState: doc.defaultLocalState ?? null,
    lesson: publicLesson(doc),
  };
}

// The lesson profile of a lesson account (see launch() below), or null for a
// normal account. `title` is the account name, shown as the lesson badge.
function publicLesson(doc) {
  const l = doc.lesson;
  if (!l || typeof l !== "object") return null;
  return {
    id: l.id,
    title: doc.name ?? l.id,
    scenario: l.scenario ?? null,
    stateId: l.stateId ?? null,
    allowScenarioSwitch: !!l.allowScenarioSwitch,
    readonly: l.readonly !== false,
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;
const BCRYPT_ROUNDS = 10;

// POST /api/auth/register { name, email, institution, password }
// Open self-registration: creates a non-admin user and signs them in (sets the
// session cookie) on success — same shape as login so the client lands logged in.
/** @returns {Promise<AuthResult>} */
export async function register(
  { name, email, institution, password } = {},
  { secure = false } = {},
) {
  const bad = (msg) => ({ status: 400, body: { error: msg } });
  const nm = typeof name === "string" ? name.trim() : "";
  const em = typeof email === "string" ? email.trim().toLowerCase() : "";
  const inst = typeof institution === "string" ? institution.trim() : "";
  const pw = typeof password === "string" ? password : "";

  if (!nm) return bad("name is required");
  if (!EMAIL_RE.test(em)) return bad("a valid email is required");
  if (em.endsWith(`@${LESSON_EMAIL_DOMAIN}`)) return bad("this email domain is reserved");
  if (pw.length < MIN_PASSWORD) return bad(`password must be at least ${MIN_PASSWORD} characters`);

  const users = await getUsersCollection();
  // Case-insensitive duplicate check (matches login's lookup).
  const safe = em.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const existing = await users.findOne({ email: { $regex: `^${safe}$`, $options: "i" } });
  if (existing) return { status: 409, body: { error: "an account with this email already exists" } };

  const hash = await bcrypt.hash(pw, BCRYPT_ROUNDS);
  const doc = {
    name: nm,
    email: em,
    institution: inst,
    password: hash,
    admin: false,
    modelDeveloper: false,
    defaultState: null,
    defaultLocalState: null,
  };
  try {
    const result = await users.insertOne(doc);
    // Seed the new user's default state from the bundled term_neonate definition
    // and point defaultState at it. Best-effort: a failure here must not break
    // registration, so we log and continue without a default.
    try {
      const stateId = await seedDefaultState({ email: em, name: nm });
      if (stateId) {
        await users.updateOne({ _id: result.insertedId }, { $set: { defaultState: stateId } });
        doc.defaultState = stateId;
      }
    } catch (seedErr) {
      console.error("seedDefaultState failed for", em, "-", String(seedErr));
    }
    const token = signSession({ sub: String(result.insertedId), email: em });
    return {
      status: 201,
      body: { user: publicUser(doc) },
      setCookie: sessionCookie(token, { secure }),
    };
  } catch (e) {
    // Unique-index collision (if one exists on email) → treat as duplicate.
    if (e && e.code === 11000) {
      return { status: 409, body: { error: "an account with this email already exists" } };
    }
    throw e;
  }
}

// POST /api/auth/login { email, password }
/** @returns {Promise<AuthResult>} */
export async function login({ email, password } = {}, { secure = false } = {}) {
  const invalid = { status: 401, body: { error: "invalid email or password" } };
  if (typeof email !== "string" || typeof password !== "string" || !email || !password) {
    return invalid;
  }
  const users = await getUsersCollection();
  // Case-insensitive email match; emails are stored lower-cased in practice but
  // be forgiving on input. Anchored exact match, escaping regex metachars.
  const safe = email.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const user = await users.findOne({ email: { $regex: `^${safe}$`, $options: "i" } });
  if (!user || user.disabled || typeof user.password !== "string") return invalid;
  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return invalid;

  const token = signSession({ sub: String(user._id), email: user.email });
  return {
    status: 200,
    body: { user: publicUser(user) },
    setCookie: sessionCookie(token, { secure }),
  };
}

// GET /api/auth/me — hydrate the session from the cookie.
/** @returns {Promise<AuthResult>} */
export async function me(cookieHeader) {
  const token = parseCookies(cookieHeader)[COOKIE_NAME];
  const payload = verifySession(token);
  if (!payload) return { status: 401, body: { error: "not authenticated" } };
  // Re-read from the DB so a deleted/edited user can't ride a stale token.
  const users = await getUsersCollection();
  const user = await users.findOne({ email: payload.email });
  if (!user || user.disabled) return { status: 401, body: { error: "not authenticated" } };
  return { status: 200, body: { user: publicUser(user) } };
}

// POST /api/auth/logout — clear the cookie.
/** @returns {AuthResult} */
export function logout({ secure = false } = {}) {
  return { status: 200, body: { ok: true }, setCookie: clearCookie({ secure }) };
}

// --- Admin-only endpoints ---------------------------------------------------

// Resolve the caller and require admin rights. Returns the user doc, or a
// { status, body } error object the caller should return as-is.
async function requireAdmin(cookieHeader) {
  const payload = verifySession(parseCookies(cookieHeader)[COOKIE_NAME]);
  if (!payload) return { error: { status: 401, body: { error: "not authenticated" } } };
  const users = await getUsersCollection();
  const user = await users.findOne({ email: payload.email });
  if (!user || user.disabled) return { error: { status: 401, body: { error: "not authenticated" } } };
  if (!user.admin) return { error: { status: 403, body: { error: "admin only" } } };
  return { user, users };
}

// GET /api/auth/users — admin: list all users (public fields only).
/** @returns {Promise<AuthResult>} */
export async function listUsers(cookieHeader) {
  const ctx = await requireAdmin(cookieHeader);
  if (ctx.error) return ctx.error;
  const docs = await ctx.users.find({}, { projection: { password: 0 } }).toArray();
  return { status: 200, body: { users: docs.map(publicUser) } };
}

// POST /api/auth/set-model-developer { email, modelDeveloper } — admin: flip a
// user's model-developer flag.
/** @returns {Promise<AuthResult>} */
export async function setModelDeveloper(cookieHeader, { email, modelDeveloper } = {}) {
  const ctx = await requireAdmin(cookieHeader);
  if (ctx.error) return ctx.error;
  const em = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (!em) return { status: 400, body: { error: "email is required" } };
  const safe = em.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const result = await ctx.users.findOneAndUpdate(
    { email: { $regex: `^${safe}$`, $options: "i" } },
    { $set: { modelDeveloper: !!modelDeveloper } },
    { returnDocument: "after" },
  );
  const doc = result?.value ?? result;
  if (!doc) return { status: 404, body: { error: "user not found" } };
  return { status: 200, body: { user: publicUser(doc) } };
}

// --- Lesson launch (nicupicu.nl) ---------------------------------------------
//
// GET /api/auth/launch?t=<token> — log a visitor straight into a lesson account
// (one per congenital heart lesion) and redirect to the app, skipping /login.
// Lesson accounts are user docs with a `lesson` sub-document and no password, so
// they can only be entered through here. Two token forms are accepted:
//
//   A. static key   "<lessonId>.<key>"  — a fixed link that a static page can
//      carry. Only sha256(key) is stored (`launchKeyHash`); rotating it revokes
//      every old link. Disable with LAUNCH_STATIC_KEYS=off.
//   B. signed JWT   HS256 with NICUPICU_LAUNCH_SECRET, claims
//      { iss:"nicupicu", aud:"explain", sub:<lessonId>, iat, exp, jti } —
//      minted per click by a nicupicu backend; short-lived and single-use.
//
// See docs/ui/NICUPICU_INTEGRATION.md. Managed with scripts/lesson-account.mjs.

export const LESSON_ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
export const LESSON_EMAIL_DOMAIN = "lesson.nicupicu";
const LESSON_SESSION_SECONDS = 8 * 60 * 60; // a lesson session lasts a working day
const LAUNCH_TOKEN_MAX_TTL = 5 * 60; // signed tokens may live at most 5 minutes
const CLOCK_SKEW = 60;

export function lessonEmail(id) {
  return `${id}@${LESSON_EMAIL_DOMAIN}`;
}

export function hashLaunchKey(key) {
  return crypto.createHash("sha256").update(key).digest("hex");
}

// Simple fixed-window per-IP limiter (in-memory, per process): launch accepts a
// guessable token shape, so cap how fast one client can try keys.
const LAUNCH_WINDOW_MS = 60_000;
const LAUNCH_MAX_PER_WINDOW = 30;
const launchHits = new Map();

function launchRateLimited(ip) {
  const now = Date.now();
  if (launchHits.size > 10_000) {
    for (const [k, v] of launchHits) if (v.reset <= now) launchHits.delete(k);
  }
  const hit = launchHits.get(ip);
  if (!hit || hit.reset <= now) {
    launchHits.set(ip, { count: 1, reset: now + LAUNCH_WINDOW_MS });
    return false;
  }
  hit.count += 1;
  return hit.count > LAUNCH_MAX_PER_WINDOW;
}

// Verify a mode-B token. Returns { lessonId, jti, exp } or null.
function verifySignedLaunch(token) {
  const secret = process.env.NICUPICU_LAUNCH_SECRET;
  if (!secret) return null;
  const p = verifySession(token, secret);
  if (!p) return null;
  const now = Math.floor(Date.now() / 1000);
  const audOk = Array.isArray(p.aud) ? p.aud.includes("explain") : p.aud === "explain";
  if (p.iss !== "nicupicu" || !audOk) return null;
  if (typeof p.exp !== "number" || typeof p.iat !== "number") return null;
  if (p.exp - p.iat > LAUNCH_TOKEN_MAX_TTL || p.iat > now + CLOCK_SKEW) return null;
  if (typeof p.sub !== "string" || !LESSON_ID_RE.test(p.sub)) return null;
  if (typeof p.jti !== "string" || !p.jti || p.jti.length > 128) return null;
  return { lessonId: p.sub, jti: p.jti, exp: p.exp };
}

/**
 * @returns {Promise<{ status: number, location: string, setCookie?: string }>}
 */
export async function launch(token, { secure = false, ip = "" } = {}) {
  const fail = { status: 302, location: "/login?launch=invalid" };
  if (launchRateLimited(ip)) return fail;
  if (typeof token !== "string" || !token || token.length > 2048) return fail;

  const parts = token.split(".");
  let lessonId = null;
  let staticKey = null;
  let signed = null;
  if (parts.length === 3) {
    signed = verifySignedLaunch(token);
    if (!signed) return fail;
    lessonId = signed.lessonId;
  } else if (parts.length === 2) {
    if (process.env.LAUNCH_STATIC_KEYS === "off") return fail;
    [lessonId, staticKey] = parts;
    if (!LESSON_ID_RE.test(lessonId) || staticKey.length < 20 || staticKey.length > 128) return fail;
  } else {
    return fail;
  }

  const users = await getUsersCollection();
  const user = await users.findOne({ "lesson.id": lessonId });
  if (!user || user.disabled) return fail;

  if (staticKey !== null) {
    if (typeof user.launchKeyHash !== "string") return fail;
    const a = Buffer.from(hashLaunchKey(staticKey), "hex");
    const b = Buffer.from(user.launchKeyHash, "hex");
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return fail;
  } else {
    // Single use: the unique index turns a replayed jti into a duplicate-key error.
    const jtis = await getLaunchJtiCollection();
    try {
      await jtis.insertOne({ jti: signed.jti, expiresAt: new Date((signed.exp + CLOCK_SKEW) * 1000) });
    } catch (e) {
      if (e && e.code === 11000) return fail;
      throw e;
    }
  }

  const session = signSession(
    { sub: String(user._id), email: user.email, lesson: lessonId },
    { maxAge: LESSON_SESSION_SECONDS },
  );
  return {
    status: 302,
    location: "/",
    setCookie: sessionCookie(session, { secure, maxAge: LESSON_SESSION_SECONDS }),
  };
}
