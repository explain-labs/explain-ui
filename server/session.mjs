// Stateless session tokens + cookie helpers, shared by the dev and prod auth
// endpoints. A token is a compact HS256 JWT (header.payload.signature, all
// base64url) signed with AUTH_SECRET — implemented with node:crypto so we add no
// jsonwebtoken dependency. The token rides in an HttpOnly cookie so it is never
// readable from JS (resists XSS token theft); the server is the real boundary.

import crypto from "node:crypto";

export const COOKIE_NAME = "explain_session";
const MAX_AGE_SECONDS = 7 * 24 * 60 * 60; // 7 days

function b64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function b64urlJson(obj) {
  return b64url(JSON.stringify(obj));
}

function getSecret() {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET not set");
  return secret;
}

function hmac(data, secret) {
  return b64url(crypto.createHmac("sha256", secret ?? getSecret()).update(data).digest());
}

// Sign a session payload (extra claims merged in). Returns the JWT string.
// `maxAge` (seconds) shortens the lifetime, e.g. for lesson-account sessions;
// `secret` overrides AUTH_SECRET (used to mint test launch tokens).
export function signSession(payload, { maxAge = MAX_AGE_SECONDS, secret } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const body = { iat: now, exp: now + maxAge, ...payload };
  const head = b64urlJson({ alg: "HS256", typ: "JWT" });
  const data = `${head}.${b64urlJson(body)}`;
  return `${data}.${hmac(data, secret)}`;
}

// Verify a token; returns the payload object or null (bad signature / expired / malformed).
// `secret` defaults to AUTH_SECRET; the launch endpoint passes the separate
// NICUPICU_LAUNCH_SECRET to verify externally signed launch tokens.
export function verifySession(token, secret) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts;
  // timing-safe signature check
  const expected = hmac(`${head}.${body}`, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64").toString("utf8"));
    if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

// Parse a Cookie request header into { name: value }.
export function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Build the Set-Cookie value carrying the session token. `secure` adds the
// Secure attribute (prod / https); omit in dev where the app is plain http.
export function sessionCookie(token, { secure = false, maxAge = MAX_AGE_SECONDS } = {}) {
  const attrs = [
    `${COOKIE_NAME}=${token}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${maxAge}`,
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

// Set-Cookie value that immediately expires the session cookie (logout).
export function clearCookie({ secure = false } = {}) {
  const attrs = [`${COOKIE_NAME}=`, "HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=0"];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}
