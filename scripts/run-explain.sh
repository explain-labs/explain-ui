#!/usr/bin/env bash
# Get Explain running locally — no GitHub account, SSH key, or git knowledge needed.
#
# Usage:
#   bash run-explain.sh [--no-dev]
#
# Run it from the folder where you keep your projects (it will clone explain-ui
# there), or from inside an existing explain-ui clone. Re-running it updates to
# the latest version and starts the app again. --no-dev sets everything up but
# doesn't start the app.
set -euo pipefail

REPO_HTTPS="https://github.com/explain-labs/explain-ui.git"

info() { printf '\n==> %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

NO_DEV=0
for arg in "$@"; do
  case "$arg" in
    --no-dev) NO_DEV=1 ;;
    -h|--help)
      echo "Usage: bash run-explain.sh [--no-dev]"
      exit 0
      ;;
    *) die "Unknown option '$arg'. Usage: bash run-explain.sh [--no-dev]" ;;
  esac
done

# --- 1. Prerequisites ---------------------------------------------------------

need() {
  command -v "$1" >/dev/null 2>&1 && return 0
  if [ "$(uname -s)" = "Darwin" ]; then
    die "'$1' is not installed. Install it with Homebrew (https://brew.sh): brew install $2"
  else
    die "'$1' is not installed. Install it with your package manager, e.g.: sudo apt install $2"
  fi
}

need git git
need node nodejs
need npm nodejs

node_major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$node_major" -lt 20 ]; then
  warn "Node $(node --version) detected — the app needs Node 20 or newer. Get it from https://nodejs.org"
fi

# --- 2. Locate or clone the repository ----------------------------------------

if toplevel=$(git rev-parse --show-toplevel 2>/dev/null); then
  if grep -q '"name": "explain-user"' "$toplevel/package.json" 2>/dev/null; then
    info "Using existing explain-ui clone: $toplevel"
    cd "$toplevel"
  else
    die "You are inside a git repository that isn't explain-ui ($toplevel).
       Run this script from the folder where you keep your projects, or from inside your explain-ui clone."
  fi
elif [ -f explain-ui/package.json ]; then
  info "Found an existing clone at ./explain-ui"
  cd explain-ui
else
  info "Downloading Explain (this can take a minute)"
  git clone --recurse-submodules "$REPO_HTTPS"
  cd explain-ui
fi

# Adopt the submodule URL recorded in .gitmodules. This is a no-op for fresh
# clones and repairs older ones, whose stored engine URL predates the move to
# the explain-labs org and to HTTPS.
git submodule sync >/dev/null 2>&1 || true

# --- 3. Repair the submodule if it's missing ----------------------------------

if [ ! -f explain-engine/Model.js ]; then
  info "explain-engine/ is empty — fetching the submodule"
  git submodule update --init
fi

# --- 4. Update to the latest version, when that is safe ------------------------

branch=$(git branch --show-current)
if [ "$branch" = "main" ] && [ -z "$(git status --porcelain --ignore-submodules=all)" ]; then
  info "Updating to the latest version"
  git pull
  if [ -z "$(git -C explain-engine status --porcelain)" ]; then
    git submodule update --init
  else
    warn "Skipping engine update: explain-engine has local changes."
  fi
else
  info "Skipping update: local changes or a non-main branch ('$branch') — leaving your checkout as it is."
fi

# --- 5. Dependencies ----------------------------------------------------------

info "Installing dependencies (npm install)"
npm install

# --- 6. Launch ----------------------------------------------------------------

if [ "$NO_DEV" -eq 1 ]; then
  info "Done — Explain is ready"
  echo "Start it with:"
  echo "  cd $(pwd)"
  echo "  npm run dev        # then open the URL Vite prints"
else
  info "Starting Explain — open the URL below in your browser (Ctrl-C stops it)"
  exec npm run dev
fi
