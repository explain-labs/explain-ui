// Transport-agnostic handlers for per-user saved model states, shared by the dev
// (vite.config.ts) and prod (server/index.mjs) wrappers — same shape as
// server/auth.mjs. Every handler is auth-scoped: it resolves the caller from the
// session cookie and filters all DB access by `owner_email`, so a user can only
// ever see / load / delete their own states.
//
// A saved state is the full reloadable scenario object the client already builds
// in SaveStatePanel.vue: { name, user, description, diagram_definition,
// animation_definition, configuration, model_definition }. We persist that
// verbatim under model-level fields plus ownership/metadata.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ObjectId } from "mongodb";
import { getStatesCollection, getUsersCollection } from "./db.mjs";
import { parseCookies, verifySession, COOKIE_NAME } from "./session.mjs";

// Name of the bundled model definition seeded as each new user's default state.
export const DEFAULT_STATE_NAME = "term_neonate";

/**
 * @typedef {{ status: number, body: any }} StateResult
 */

// Resolve the authenticated user from the request cookie. Returns { email, name }
// or null (→ caller responds 401). Re-reads the user doc so a deleted user can't
// ride a stale token (same guarantee as the auth `me` handler).
async function requireUser(cookieHeader) {
  const token = parseCookies(cookieHeader)[COOKIE_NAME];
  const payload = verifySession(token);
  if (!payload) return null;
  const users = await getUsersCollection();
  const user = await users.findOne({ email: payload.email });
  if (!user || user.disabled) return null;
  return {
    email: user.email,
    name: user.name ?? "",
    modelDeveloper: !!user.modelDeveloper,
    lesson: user.lesson ?? null,
  };
}

const unauth = { status: 401, body: { error: "not authenticated" } };

// Lesson accounts (nicupicu.nl, see launch() in ./auth.mjs) are shared by many
// learners, so by default they may not write: one learner must not overwrite the
// lesson for everyone. The UI hides these controls too; this is the real gate.
const readonlyLesson = (user) => !!user.lesson && user.lesson.readonly !== false;
const lessonForbidden = { status: 403, body: { error: "read-only lesson account" } };

function toObjectId(id) {
  try {
    return new ObjectId(String(id));
  } catch {
    return null;
  }
}

// Strip any client-supplied identity/id fields; we set ownership ourselves.
function pickFileParts(file = {}) {
  return {
    explain_version: file.explain_version ?? "1.0",
    description: typeof file.description === "string" ? file.description : "",
    animation_definition: file.animation_definition ?? null,
    diagram_definition: file.diagram_definition ?? null,
    configuration: file.configuration ?? null,
    model_definition: file.model_definition ?? null,
  };
}

// Sanitize a scenario name to a bare filename stem (no path traversal).
function safeScenarioName(name) {
  return String(name ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "");
}

// Resolve a model definition file path by name. It lives under model_definitions/
// — public/ in dev, dist/ after a build — so try both, resolved against the repo
// root (server/ is one level down) and cwd. Returns the path or null.
function modelDefinitionPath(name) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const rel = path.join("model_definitions", `${name}.json`);
  const candidates = [
    path.join(root, "public", rel),
    path.join(root, "dist", rel),
    path.join(process.cwd(), "public", rel),
    path.join(process.cwd(), "dist", rel),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// Read the bundled term_neonate definition used to seed each new user's default.
function readDefaultDefinition() {
  const p = modelDefinitionPath(DEFAULT_STATE_NAME);
  if (!p) throw new Error(`default state definition not found (${DEFAULT_STATE_NAME}.json)`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

// Seed a user's default state from the bundled term_neonate definition.
// Idempotent (upsert by owner+name). Returns the saved state's id string.
export async function seedDefaultState(user) {
  const file = readDefaultDefinition();
  const parts = pickFileParts(file);
  const now = new Date();
  const states = await getStatesCollection();
  const result = await states.findOneAndUpdate(
    { owner_email: user.email, name: DEFAULT_STATE_NAME },
    {
      $set: {
        ...parts,
        name: DEFAULT_STATE_NAME,
        description: file.description ?? parts.description,
        user: user.name ?? "",
        owner_email: user.email,
        protected: false,
        shared: false,
        shared_category: "General",
        updated_at: now,
      },
      $setOnInsert: { created_at: now },
    },
    { upsert: true, returnDocument: "after" },
  );
  const doc = result?.value ?? result;
  return String(doc?._id ?? "");
}

// POST /api/states/save { name, description?, file }
/** @returns {Promise<StateResult>} */
export async function saveState(cookieHeader, { name, description, file } = {}) {
  const user = await requireUser(cookieHeader);
  if (!user) return unauth;
  if (readonlyLesson(user)) return lessonForbidden;

  const nm = typeof name === "string" ? name.trim() : "";
  if (!nm) return { status: 400, body: { error: "a name is required" } };
  if (!file || typeof file !== "object" || !file.model_definition) {
    return { status: 400, body: { error: "missing model state to save" } };
  }

  const parts = pickFileParts(file);
  const now = new Date();
  const states = await getStatesCollection();
  // Upsert by (owner, name): re-saving the same name updates the entry rather
  // than creating a duplicate. created_at is only set on first insert.
  const result = await states.findOneAndUpdate(
    { owner_email: user.email, name: nm },
    {
      $set: {
        ...parts,
        name: nm,
        description: typeof description === "string" ? description : parts.description,
        user: user.name,
        owner_email: user.email,
        protected: false,
        shared: false,
        shared_category: "General",
        updated_at: now,
      },
      $setOnInsert: { created_at: now },
    },
    { upsert: true, returnDocument: "after" },
  );

  const doc = result?.value ?? result; // driver version tolerance
  return {
    status: 200,
    body: {
      state: {
        id: String(doc?._id ?? ""),
        name: nm,
        updated_at: now.toISOString(),
      },
    },
  };
}

// GET /api/states/list — summaries only (no heavy definition blobs).
/** @returns {Promise<StateResult>} */
export async function listStates(cookieHeader) {
  const user = await requireUser(cookieHeader);
  if (!user) return unauth;
  const states = await getStatesCollection();
  const docs = await states
    .find(
      { owner_email: user.email },
      { projection: { name: 1, description: 1, updated_at: 1, created_at: 1 } },
    )
    .sort({ updated_at: -1 })
    .toArray();
  return {
    status: 200,
    body: {
      states: docs.map((d) => ({
        id: String(d._id),
        name: d.name,
        description: d.description ?? "",
        updated_at: d.updated_at ?? null,
        created_at: d.created_at ?? null,
      })),
    },
  };
}

// GET /api/states/get?id=… — full reloadable file for the owner.
/** @returns {Promise<StateResult>} */
export async function getState(cookieHeader, id) {
  const user = await requireUser(cookieHeader);
  if (!user) return unauth;
  const oid = toObjectId(id);
  if (!oid) return { status: 400, body: { error: "invalid id" } };
  const states = await getStatesCollection();
  // A lesson account may also read the one curated state its lesson starts from,
  // which is owned by the admin who set the lesson up.
  const filter =
    user.lesson?.stateId && user.lesson.stateId === String(oid)
      ? { _id: oid }
      : { _id: oid, owner_email: user.email };
  const doc = await states.findOne(filter);
  if (!doc) return { status: 404, body: { error: "state not found" } };
  // Hand back the shape useExplain.loadFromObject expects.
  const file = {
    name: doc.name,
    user: doc.user,
    description: doc.description ?? "",
    diagram_definition: doc.diagram_definition ?? undefined,
    animation_definition: doc.animation_definition ?? undefined,
    configuration: doc.configuration ?? undefined,
    model_definition: doc.model_definition,
  };
  return { status: 200, body: { id: String(doc._id), file } };
}

// POST /api/states/delete { id }
/** @returns {Promise<StateResult>} */
export async function deleteState(cookieHeader, { id } = {}) {
  const user = await requireUser(cookieHeader);
  if (!user) return unauth;
  if (readonlyLesson(user)) return lessonForbidden;
  const oid = toObjectId(id);
  if (!oid) return { status: 400, body: { error: "invalid id" } };
  const states = await getStatesCollection();
  const r = await states.deleteOne({ _id: oid, owner_email: user.email });
  if (!r.deletedCount) return { status: 404, body: { error: "state not found" } };
  // If the deleted state was the user's default, clear the pointer.
  const users = await getUsersCollection();
  await users.updateOne(
    { email: user.email, defaultState: String(oid) },
    { $set: { defaultState: null } },
  );
  return { status: 200, body: { ok: true } };
}

// POST /api/states/set-default { id } — flag one of the caller's own states as
// their default (loaded automatically on next login). Pass id:null to clear it.
/** @returns {Promise<StateResult>} */
export async function setDefaultState(cookieHeader, { id } = {}) {
  const user = await requireUser(cookieHeader);
  if (!user) return unauth;
  if (readonlyLesson(user)) return lessonForbidden;
  const users = await getUsersCollection();
  if (id === null || id === "") {
    await users.updateOne({ email: user.email }, { $set: { defaultState: null } });
    return { status: 200, body: { defaultState: null } };
  }
  const oid = toObjectId(id);
  if (!oid) return { status: 400, body: { error: "invalid id" } };
  const states = await getStatesCollection();
  const doc = await states.findOne({ _id: oid, owner_email: user.email });
  if (!doc) return { status: 404, body: { error: "state not found" } };
  await users.updateOne({ email: user.email }, { $set: { defaultState: String(oid) } });
  return { status: 200, body: { defaultState: String(oid) } };
}

// POST /api/states/set-default-local { name } — model-developers only. Choose a
// LOCAL model definition (from model_definitions/) to load at startup; this takes
// priority over the cloud default state. Pass name:null to clear it.
/** @returns {Promise<StateResult>} */
export async function setDefaultLocalState(cookieHeader, { name } = {}) {
  const user = await requireUser(cookieHeader);
  if (!user) return unauth;
  if (readonlyLesson(user)) return lessonForbidden;
  if (!user.modelDeveloper) return { status: 403, body: { error: "model developers only" } };
  const users = await getUsersCollection();
  if (name === null || name === "") {
    await users.updateOne({ email: user.email }, { $set: { defaultLocalState: null } });
    return { status: 200, body: { defaultLocalState: null } };
  }
  const safe = safeScenarioName(name);
  if (!safe || !modelDefinitionPath(safe)) {
    return { status: 404, body: { error: "scenario not found" } };
  }
  await users.updateOne({ email: user.email }, { $set: { defaultLocalState: safe } });
  return { status: 200, body: { defaultLocalState: safe } };
}
