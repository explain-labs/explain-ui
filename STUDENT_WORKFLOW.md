# Student workflow

How to build your own models and scenarios on top of Explain without ever touching
shared code, and how to hand your work in.

Explain is two repositories. **`explain-ui`** is the web app you clone; **`explain-engine`**
is the physiological simulation engine, mounted inside it as a git submodule at
`explain-engine/`. You will work in both, each on your own branch.

The rule that makes this painless: **never edit `ModelIndex.js` or
`src/model-interface/registry.ts`.** Those are shared files that everyone's work would
collide in. Instead there are two extension points that are empty on `main` and yours to
fill in — `explain-engine/CustomModelIndex.js` and
`src/model-interface/custom-registry.ts`. Because your branch only *adds* files and appends
lines to otherwise-empty stubs, picking up changes from `main` stays conflict-free.

---

## 1. One-time setup

You need two things before you start: your instructor must add you as a collaborator on
both repositories, and you need [an SSH key registered with GitHub](https://docs.github.com/en/authentication/connecting-to-github-with-ssh).

### The easy way: the setup script

The setup script does everything in this section for you — checks your tools, clones the
repository with its engine submodule, installs dependencies, and creates + pushes your
`student/<yourname>` branch in both repositories. Run it from the folder where you keep
your projects; it is safe to re-run if something goes wrong halfway.

macOS / Linux:

```sh
curl -fsSLO https://raw.githubusercontent.com/Dobutamine/explain-ui/main/scripts/setup-student.sh
bash setup-student.sh <yourname>
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/Dobutamine/explain-ui/main/scripts/setup-student.ps1 -OutFile setup-student.ps1
powershell -ExecutionPolicy Bypass -File .\setup-student.ps1 <yourname>
```

When it finishes, start the app with `npm run dev` and skip ahead to section 2.

### By hand (what the script does)

```sh
git clone --recurse-submodules git@github.com:Dobutamine/explain-ui.git
cd explain-ui
npm install
```

`--recurse-submodules` matters. Without it, `explain-engine/` is an empty directory and
nothing works. If you already cloned without it, run `git submodule update --init` now.

Create your branch in the app repo:

```sh
git checkout -b student/<yourname>
```

Then the same inside the engine. A freshly cloned submodule sits on a **detached HEAD**
(it is pinned to one specific commit rather than a branch), so you check out `main` first:

```sh
cd explain-engine
git checkout main && git pull
git checkout -b student/<yourname>
git push -u origin student/<yourname>
cd ..
git push -u origin student/<yourname>
```

Check it worked — both should print `student/<yourname>`:

```sh
git branch --show-current
git -C explain-engine branch --show-current
```

Start the app with `npm run dev` and open the URL Vite prints.

---

## 2. Writing your own model

### The class (engine repo)

Copy the annotated template and rename it:

```sh
cd explain-engine
cp custom_models/_ExampleModel.js custom_models/MyModel.js
```

Rename the class and its `static model_type` inside. **Give the `model_type` a distinctive
name** — something like `TimBaroreflexV2`, not `Heart`. A custom model whose `model_type`
matches a built-in *replaces* that built-in throughout the engine, which is occasionally
useful and more often a typo. The engine logs a warning when it happens.

`custom_models/README.md` documents the class contract (constructor, `init_model`,
`calc_model`) and the factor / effective-value convention. Read it once before you start.

### Register it

Add one line to `explain-engine/CustomModelIndex.js`:

```js
export { MyModel } from "./custom_models/MyModel";
```

Forgetting this line is the usual cause of `ERROR: <type> model not found` at build.

### Use it in a scenario

Scenarios live in `explain-engine/model_definitions/*.json`. Copy one as a starting point
and name yours `student_<yourname>_<something>.json`:

```sh
cp model_definitions/term_neonate.json model_definitions/student_<yourname>_experiment.json
```

Add an entry to its `model_definition.models` map:

```json
"MyModel": {
  "name": "MyModel",
  "model_type": "MyModel",
  "is_enabled": true,
  "description": "what it does"
}
```

Order matters when your model depends on values another model computes this step — place
it after that model in the map.

Restart `npm run dev`. Scenarios are copied from the engine into the app automatically on
every start, so yours appears in the scenario dropdown with no further steps. (The copy is
one-way: `public/model_definitions/` is generated and overwritten — always edit the file in
`explain-engine/model_definitions/`.)

### Make the parameters editable in the app

Add an entry keyed by your `model_type` to `src/model-interface/custom-registry.ts` in the
app repo. The file has a worked example in its header comment, and every supported option
is documented on the `InterfaceField` type in `src/model-interface/types.ts`.

This step is optional: without it your model still runs, it just shows no fields in the
model editor.

---

## 3. Testing without the browser

From the engine directory, build and run a scenario headless:

```sh
node scripts/probe_vitals.mjs student_<yourname>_experiment
```

A build failure exits non-zero — that is the check that proves your model registered.
Physiological numbers are printed as labelled `ok` / `LOW` / `HIGH` verdicts and always
exit `0`, so **read the printed table**; never conclude "it passed" from the exit code
alone. See `explain-engine/docs/TESTING.md` for the full script inventory.

---

## 4. Committing

Your work spans two repositories, so it takes two commits. **Always push the engine
first** — the app repo records *which engine commit* it uses, and that commit has to exist
on the server before anyone else can fetch it.

```sh
cd explain-engine
git add custom_models/MyModel.js CustomModelIndex.js model_definitions/student_<yourname>_experiment.json
git commit -m "add MyModel"
git push
cd ..

git add src/model-interface/custom-registry.ts explain-engine
git commit -m "wire MyModel into the model editor"
git push
```

`git add explain-engine` is not a mistake — it records the engine commit your app branch
should use. Do it every time you push engine work, otherwise a fresh clone of your branch
gets the old engine code.

---

## 5. Picking up changes from `main`

Do this regularly, and always **engine first, then app**:

```sh
cd explain-engine
git fetch origin
git rebase origin/main
git push --force-with-lease
cd ..

git fetch origin
git rebase origin/main
git push --force-with-lease
npm install          # only needed if package-lock.json changed
```

`--force-with-lease` rewrites your branch on the server, which is safe because the branch
is yours alone. Never run it on a branch you share with someone else.

If the app rebase stops on a conflict in `explain-engine` itself, that is the recorded
engine commit disagreeing — not a code conflict. Resolve it by pointing at your own engine
branch and continuing:

```sh
git -C explain-engine checkout student/<yourname>
git add explain-engine
git rebase --continue
```

---

## 6. Handing work in

Open a pull request in **each** repository, from `student/<yourname>` to `main`, on GitHub.

Note that the app-repo pull request shows your engine work only as a one-line change of a
commit hash — the actual model code is reviewable in the engine pull request. Link the two
so they can be read together.

---

## Troubleshooting

**`explain-engine/` is empty** — cloned without `--recurse-submodules`. Run
`git submodule update --init`.

**PowerShell says "running scripts is disabled on this system"** — start the setup script
exactly as shown in section 1, with `powershell -ExecutionPolicy Bypass -File .\setup-student.ps1`;
that bypasses the policy for this one run without changing any system setting.

**`ERROR: <type> model not found` at build** — either a `model_type` typo in the scenario
JSON, or a missing export line in `CustomModelIndex.js`.

**`Cannot access 'BaseModelClass' before initialization`** — your model was imported from
somewhere too early in the module graph. Custom models must be reached only through
`CustomModelIndex.js`; don't import them from files inside `base_models/`.

**Your model runs but the editor shows no fields** — no entry for its `model_type` in
`src/model-interface/custom-registry.ts`. This is silent by design.

**Your scenario is missing from the dropdown** — it must be in
`explain-engine/model_definitions/` (not `public/model_definitions/`, which is generated),
and the dev server needs a restart to re-run the copy.

**Engine changes don't show up in the app** — the app is pinned to a recorded engine
commit. Check `git -C explain-engine branch --show-current`; if it says something other
than your branch, you are on a detached HEAD: `git -C explain-engine checkout student/<yourname>`.

**A built-in model behaves strangely** — check the browser console for
`custom model overrides built-in '<type>'`. Your `model_type` collides with a core model;
rename it.

---

## For instructors

One-time, in the GitHub web interface, for **both** repositories:

1. **Settings → Collaborators** — add each student with **Write** access.
2. **Settings → Branches** — add a protection rule for `main`: require a pull request
   before merging, and block force pushes and deletions. Leave `student/*` unprotected so
   students can force-push their own rebases.

Keep the three extension-point files empty on `main` —
`explain-engine/CustomModelIndex.js`, `src/model-interface/custom-registry.ts`, and the
`custom_models/` directory apart from its README and `_ExampleModel.js`. Their emptiness is
what guarantees students' rebases stay conflict-free.

When you merge a student's engine pull request, bump the submodule on the app's `main`
afterwards so the app picks the new engine commit up.
