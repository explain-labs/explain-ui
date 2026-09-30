// Lazy singleton MongoDB connection, shared by the dev (vite.config.ts) and prod
// (server/index.mjs) auth endpoints. The connection string lives in MONGODB_URI
// (see .env.local) and INCLUDES the database name in its path, so db() with no
// argument resolves to the right database (e.g. `explain`). The MongoClient is
// cached across requests — connecting per request would exhaust the pool.

import { MongoClient } from "mongodb";

// Collection holding login credentials. Schema (confirmed against the live DB):
// { email: string, password: <bcrypt hash>, name, admin, institution, ... }.
const USERS_COLLECTION = "users";

let clientPromise = null;

function getClient() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI not set");
  // Cache the connect() promise so concurrent callers share one handshake.
  if (!clientPromise) {
    // Fail fast (default is 30 s) when the DB is configured but unreachable, e.g.
    // a local dev whose SSH tunnel to the prod Mongo is closed.
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 3000 });
    clientPromise = client.connect().catch((e) => {
      // Reset so a later request can retry instead of reusing a rejected promise.
      clientPromise = null;
      throw e;
    });
  }
  return clientPromise;
}

export async function getUsersCollection() {
  const client = await getClient();
  return client.db().collection(USERS_COLLECTION);
}

// Collection holding user-saved model states (full reloadable scenario docs,
// one per save, scoped to an owner). See server/states.mjs.
const STATES_COLLECTION = "states";

export async function getStatesCollection() {
  const client = await getClient();
  return client.db().collection(STATES_COLLECTION);
}

// Collection of already-used launch-token ids (jti), for replay protection of
// externally signed nicupicu launch tokens. A TTL index on `expiresAt` lets
// MongoDB purge each entry once its token could no longer verify anyway; the
// unique index on `jti` makes "insert" double as an atomic "was it used?" check.
const LAUNCH_JTI_COLLECTION = "launch_jti";
let jtiIndexesReady = null;

export async function getLaunchJtiCollection() {
  const client = await getClient();
  const col = client.db().collection(LAUNCH_JTI_COLLECTION);
  if (!jtiIndexesReady) {
    jtiIndexesReady = Promise.all([
      col.createIndex({ jti: 1 }, { unique: true }),
      col.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    ]).catch((e) => {
      jtiIndexesReady = null;
      throw e;
    });
  }
  await jtiIndexesReady;
  return col;
}
