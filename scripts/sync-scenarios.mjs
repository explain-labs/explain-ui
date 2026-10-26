// Populate public/model_definitions/ from the engine submodule's canonical
// scenario library, then regenerate index.json.
//
// After the engine was split into its own repo (mounted as the `explain-engine/`
// submodule), the canonical scenarios live at explain-engine/model_definitions/.
// The Vue app still serves them statically from public/model_definitions/, so
// this script copies them across. It is:
//   - additive: it copies/overwrites canonical files but never deletes extras,
//     so developer/user snapshots written into public/ persist. The exception:
//     copies of scenarios the engine archived, renamed or deleted are removed.
//   - idempotent: safe to run on every `predev` / `prebuild`.
//
// index.json is rebuilt as the sorted union of every scenario basename present
// in public/ after the copy (canonical ∪ snapshots), matching the shape the app
// and the vite snapshotApi plugin expect (a JSON array of names, no .json).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const srcDir = path.join(root, "explain-engine", "model_definitions");
const dstDir = path.join(root, "public", "model_definitions");

if (!fs.existsSync(srcDir)) {
  console.error(
    `[sync-scenarios] ${srcDir} not found — is the 'explain-engine' submodule initialised?\n` +
      `  run: git submodule update --init`,
  );
  process.exit(1);
}
fs.mkdirSync(dstDir, { recursive: true });

let copied = 0;
for (const f of fs.readdirSync(srcDir)) {
  if (!f.endsWith(".json") || f === "index.json") continue;
  fs.copyFileSync(path.join(srcDir, f), path.join(dstDir, f));
  copied++;
}

// scenarios the engine has moved to model_definitions/archive/ are no longer served: drop their
// earlier copies (the copy step is additive, so they would otherwise linger in public/). Only names
// present in the archive are removed; developer/user snapshots are untouched.
const archiveDir = path.join(srcDir, "archive");
let archived = 0;
if (fs.existsSync(archiveDir)) {
  for (const f of fs.readdirSync(archiveDir)) {
    if (!f.endsWith(".json") || fs.existsSync(path.join(srcDir, f))) continue;
    const served = path.join(dstDir, f);
    if (fs.existsSync(served)) { fs.rmSync(served); archived++; }
  }
}

// scenarios the engine renamed (explain-engine/helpers/ScenarioAliases.js; the engine's load() maps the
// old name to the current file) or deleted without archiving: drop their served copies too, so an
// old name is not listed beside its successor and a deleted scenario is not served stale
const DELETED = [
  // removed 2026-10-25 during the re-validation, to be rebuilt from scratch on the term baby
  "preterm_25wk", "preterm_28wk", "preterm_30wk", "fetus_25wk", "fetus_term",
  "bischoff_no_pda", "bischoff_ltr_pda", "bischoff_bidir_pda",
];
const aliasesFile = path.join(root, "explain-engine", "helpers", "ScenarioAliases.js");
const { SCENARIO_ALIASES = {} } = fs.existsSync(aliasesFile) ? await import(pathToFileURL(aliasesFile).href) : {};
let retired = 0;
for (const name of [...Object.keys(SCENARIO_ALIASES), ...DELETED]) {
  if (fs.existsSync(path.join(srcDir, `${name}.json`))) continue;
  const served = path.join(dstDir, `${name}.json`);
  if (fs.existsSync(served)) { fs.rmSync(served); retired++; }
}

const names = fs
  .readdirSync(dstDir)
  .filter((f) => f.endsWith(".json") && f !== "index.json")
  .map((f) => f.slice(0, -".json".length))
  .sort();
fs.writeFileSync(path.join(dstDir, "index.json"), JSON.stringify(names, null, 2) + "\n");

console.log(`[sync-scenarios] copied ${copied} canonical scenario(s); removed ${archived} archived, ${retired} renamed/deleted; index lists ${names.length}.`);
