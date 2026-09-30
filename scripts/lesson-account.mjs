// Manage nicupicu.nl lesson accounts: one Explain account per congenital heart
// lesion, entered through GET /api/auth/launch instead of the login page (see
// launch() in server/auth.mjs and docs/ui/NICUPICU_INTEGRATION.md).
//
// Run:  node --env-file=.env.local scripts/lesson-account.mjs <command> [options]
//
//   create  --id tof --name "Tetralogy of Fallot" --scenario tof
//           [--state <cloudStateId>] [--allow-switch] [--writable] [--base <url>]
//           Create the account and print its launch link.
//   update  --id tof [--name …] [--scenario …] [--state …|--state none]
//           [--allow-switch|--no-allow-switch] [--writable|--readonly]
//           Change the lesson profile. The launch link stays valid.
//   rotate  --id tof [--base <url>]   New launch link; every old link stops working.
//   disable --id tof                  Block launches and end existing sessions.
//   enable  --id tof                  Undo disable (then run rotate for a link).
//   list                              All lesson accounts.
//   sign    --id tof [--ttl 120] [--base <url>]
//           Mint a signed (mode B) launch link with NICUPICU_LAUNCH_SECRET. This is
//           what a nicupicu backend does per click; use it here for testing.
//
// The static key is printed once; only its sha256 is stored. --base (or the
// EXPLAIN_PUBLIC_URL env var) is the public Explain origin used in printed links.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getUsersCollection } from "../server/db.mjs";
import { signSession } from "../server/session.mjs";
import { LESSON_ID_RE, lessonEmail, hashLaunchKey } from "../server/auth.mjs";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) opts[key] = true;
    else {
      opts[key] = next;
      i++;
    }
  }
  return { cmd, opts };
}

function die(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function baseUrl(opts) {
  const b = typeof opts.base === "string" ? opts.base : process.env.EXPLAIN_PUBLIC_URL;
  return (b || "http://localhost:8080").replace(/\/+$/, "");
}

function launchUrl(opts, token) {
  return `${baseUrl(opts)}/api/auth/launch?t=${encodeURIComponent(token)}`;
}

function requireId(opts) {
  const id = typeof opts.id === "string" ? opts.id.trim().toLowerCase() : "";
  if (!LESSON_ID_RE.test(id)) {
    die("--id is required: lowercase letters, digits, '-' or '_', at most 40 characters");
  }
  return id;
}

// Warn (don't fail) when a bundled scenario name isn't found, since the canonical
// set lives in the engine submodule and may be ahead of or behind this checkout.
function checkScenario(name) {
  const candidates = [
    path.join(ROOT, "explain-engine", "model_definitions", `${name}.json`),
    path.join(ROOT, "public", "model_definitions", `${name}.json`),
  ];
  if (!candidates.some((p) => fs.existsSync(p))) {
    console.warn(`warning: scenario "${name}" not found in model_definitions/ — the lesson will`);
    console.warn("         fall back to the default scenario until it is added.");
  }
}

function newKey() {
  return crypto.randomBytes(32).toString("base64url");
}

function describe(doc) {
  const l = doc.lesson;
  const start = l.stateId ? `state ${l.stateId}` : `scenario ${l.scenario ?? "(none)"}`;
  const flags = [
    l.readonly !== false ? "read-only" : "writable",
    l.allowScenarioSwitch ? "switch allowed" : null,
    doc.disabled ? "DISABLED" : null,
    doc.launchKeyHash ? null : "no static link",
  ].filter(Boolean);
  return `${l.id.padEnd(20)} ${String(doc.name ?? "").padEnd(32)} ${start}  [${flags.join(", ")}]`;
}

// Apply --scenario/--state/--allow-switch/--writable flags onto a lesson profile.
function applyProfileOpts(lesson, opts) {
  if (typeof opts.scenario === "string") {
    checkScenario(opts.scenario);
    lesson.scenario = opts.scenario;
  }
  if (typeof opts.state === "string") lesson.stateId = opts.state === "none" ? null : opts.state;
  if (opts["allow-switch"]) lesson.allowScenarioSwitch = true;
  if (opts["no-allow-switch"]) lesson.allowScenarioSwitch = false;
  if (opts.writable) lesson.readonly = false;
  if (opts.readonly) lesson.readonly = true;
  return lesson;
}

const { cmd, opts } = parseArgs(process.argv.slice(2));
const users = await getUsersCollection();

switch (cmd) {
  case "create": {
    const id = requireId(opts);
    if (typeof opts.name !== "string") die("--name is required");
    if (typeof opts.scenario !== "string" && typeof opts.state !== "string") {
      die("--scenario or --state is required");
    }
    const email = lessonEmail(id);
    if (await users.findOne({ $or: [{ "lesson.id": id }, { email }] })) {
      die(`lesson "${id}" already exists — use update or rotate`);
    }
    const key = newKey();
    const lesson = applyProfileOpts(
      { id, scenario: null, stateId: null, allowScenarioSwitch: false, readonly: true },
      opts,
    );
    await users.insertOne({
      name: opts.name,
      email,
      institution: "nicupicu.nl",
      admin: false,
      modelDeveloper: false,
      defaultState: null,
      defaultLocalState: null,
      lesson,
      launchKeyHash: hashLaunchKey(key),
      launchKeyCreatedAt: new Date(),
    });
    console.log(`created lesson account "${id}" (${email})`);
    console.log(`launch link (shown once — store it now):\n\n  ${launchUrl(opts, `${id}.${key}`)}\n`);
    break;
  }
  case "update": {
    const id = requireId(opts);
    const doc = await users.findOne({ "lesson.id": id });
    if (!doc) die(`no lesson "${id}"`);
    const lesson = applyProfileOpts({ ...doc.lesson }, opts);
    const set = { lesson };
    if (typeof opts.name === "string") set.name = opts.name;
    await users.updateOne({ _id: doc._id }, { $set: set });
    console.log(describe({ ...doc, ...set }));
    break;
  }
  case "rotate": {
    const id = requireId(opts);
    const key = newKey();
    const r = await users.updateOne(
      { "lesson.id": id },
      { $set: { launchKeyHash: hashLaunchKey(key), launchKeyCreatedAt: new Date() } },
    );
    if (!r.matchedCount) die(`no lesson "${id}"`);
    console.log(`rotated "${id}"; old links no longer work.`);
    console.log(`new launch link (shown once):\n\n  ${launchUrl(opts, `${id}.${key}`)}\n`);
    break;
  }
  case "disable":
  case "enable": {
    const id = requireId(opts);
    const r = await users.updateOne({ "lesson.id": id }, { $set: { disabled: cmd === "disable" } });
    if (!r.matchedCount) die(`no lesson "${id}"`);
    console.log(`${cmd}d "${id}"`);
    break;
  }
  case "list": {
    const docs = await users.find({ lesson: { $type: "object" } }).sort({ "lesson.id": 1 }).toArray();
    if (!docs.length) console.log("no lesson accounts");
    for (const d of docs) console.log(describe(d));
    break;
  }
  case "sign": {
    const id = requireId(opts);
    const secret = process.env.NICUPICU_LAUNCH_SECRET;
    if (!secret) die("NICUPICU_LAUNCH_SECRET is not set");
    const ttl = Number(opts.ttl ?? 120);
    const token = signSession(
      { iss: "nicupicu", aud: "explain", sub: id, jti: crypto.randomUUID() },
      { maxAge: ttl, secret },
    );
    console.log(launchUrl(opts, token));
    break;
  }
  default:
    console.log("usage: lesson-account.mjs create|update|rotate|disable|enable|list|sign [options]");
    console.log("see the header of scripts/lesson-account.mjs for options");
    process.exit(cmd ? 1 : 0);
}
process.exit(0);
