# Explain

Explain is an interactive physiological simulation that runs entirely in your
browser. It models a patient — circulation, respiration, blood gases, heart,
shunts, and the devices around them (ventilator, ECLS, monitor) — as a network
of compartments computed in real time, with scenarios ranging from a healthy
term neonate to complex congenital heart defects.

This repository is the web app (Vue 3 + Vite). The simulation engine itself
lives in [`explain-engine/`](explain-engine/), a git submodule that runs inside
a Web Worker.

## Run it locally

You need [git](https://git-scm.com) and [Node.js 20+](https://nodejs.org). Then,
from the folder where you keep your projects:

**macOS / Linux**

```sh
curl -fsSLO https://raw.githubusercontent.com/explain-labs/explain-ui/main/scripts/run-explain.sh
bash run-explain.sh
```

**Windows (PowerShell)**

```powershell
irm https://raw.githubusercontent.com/explain-labs/explain-ui/main/scripts/run-explain.ps1 -OutFile run-explain.ps1
powershell -ExecutionPolicy Bypass -File .\run-explain.ps1
```

The script clones this repository (with the engine submodule), installs
dependencies, and starts the app — open the URL it prints. Re-run the same
script any time to update to the latest version and start again. Add
`--no-dev` (`-NoDev` on Windows) to set everything up without starting the app.

### By hand

The engine submodule is recorded with an SSH URL, so a plain
`git clone --recurse-submodules` fails without a GitHub SSH key. Rewrite it to
HTTPS while cloning:

```sh
git -c url."https://github.com/".insteadOf="git@github.com:" \
  clone --recurse-submodules https://github.com/explain-labs/explain-ui.git
cd explain-ui
git config url."https://github.com/".insteadOf "git@github.com:"
npm install
npm run dev
```

## Working on Explain

- **Students / contributors** — build your own models and scenarios on your own
  branch: see [STUDENT_WORKFLOW.md](STUDENT_WORKFLOW.md) (one-time setup via
  `scripts/setup-student.sh` / `.ps1`).
- **Documentation** — [docs/README.md](docs/README.md) indexes both the UI docs
  (`docs/ui/`) and the engine's physiological model docs
  (`explain-engine/docs/`).
