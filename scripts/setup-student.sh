#!/usr/bin/env bash
# One-time student setup for Explain — automates STUDENT_WORKFLOW.md section 1.
#
# Usage:
#   bash setup-student.sh [<yourname>] [--no-push]
#
# Run it from the folder where you keep your projects (it will clone explain-ui
# there), or from inside an existing explain-ui clone (it will finish/repair the
# setup). Safe to re-run at any time.
set -euo pipefail

REPO_SSH="git@github.com:explain-labs/explain-ui.git"
ENGINE_SSH="git@github.com:explain-labs/explain-engine.git"

info() { printf '\n==> %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

NAME=""
NO_PUSH=0
for arg in "$@"; do
  case "$arg" in
    --no-push) NO_PUSH=1 ;;
    -h|--help)
      echo "Usage: bash setup-student.sh [<yourname>] [--no-push]"
      exit 0
      ;;
    *) NAME="$arg" ;;
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

# --- 2. Student name → branch name -------------------------------------------

NAME=$(printf '%s' "$NAME" | tr '[:upper:]' '[:lower:]')
while ! printf '%s' "$NAME" | grep -Eq '^[a-z0-9][a-z0-9-]*$'; do
  if [ -n "$NAME" ]; then
    warn "'$NAME' won't work as a branch name — use only lowercase letters, digits and hyphens (e.g. 'tim' or 'anna-b')."
  fi
  printf 'Your name (becomes branch student/<name>): '
  read -r NAME
  NAME=$(printf '%s' "$NAME" | tr '[:upper:]' '[:lower:]')
done
BRANCH="student/$NAME"

# --- 3. SSH access to GitHub --------------------------------------------------

info "Checking SSH access to GitHub"
ssh_out=$(ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -T git@github.com 2>&1 || true)
if printf '%s' "$ssh_out" | grep -q "successfully authenticated"; then
  echo "SSH access to GitHub works."
else
  warn "Could not authenticate to GitHub over SSH."
  echo "  - Set up an SSH key: https://docs.github.com/en/authentication/connecting-to-github-with-ssh"
  echo "  - Make sure your instructor added you as a collaborator on BOTH repositories."
  printf 'Continue anyway? [y/N] '
  read -r reply
  case "$reply" in
    y|Y) ;;
    *) exit 1 ;;
  esac
fi

# --- 4. Locate or clone the repository ----------------------------------------

if toplevel=$(git rev-parse --show-toplevel 2>/dev/null); then
  if grep -q '"name": "explain-user"' "$toplevel/package.json" 2>/dev/null; then
    info "Already inside an explain-ui clone: $toplevel"
    cd "$toplevel"
  else
    die "You are inside a git repository that isn't explain-ui ($toplevel).
       Run this script from the folder where you keep your projects, or from inside your explain-ui clone."
  fi
elif [ -f explain-ui/package.json ]; then
  info "Found an existing clone at ./explain-ui"
  cd explain-ui
else
  info "Cloning explain-ui (with the explain-engine submodule)"
  git clone --recurse-submodules "$REPO_SSH"
  cd explain-ui
fi

# --- 5. Repair the submodule if it's missing ----------------------------------

git submodule sync >/dev/null 2>&1 || true

if [ ! -f explain-engine/Model.js ]; then
  info "explain-engine/ is empty — fetching the submodule"
  git submodule update --init
fi

# .gitmodules records the engine over HTTPS so that anyone can clone the app
# anonymously. Students push an engine branch of their own, so give this clone
# the SSH remote their key already authenticates against.
git -C explain-engine remote set-url origin "$ENGINE_SSH"

# --- 6. Refuse to touch branches over uncommitted work ------------------------

if [ -n "$(git status --porcelain --ignore-submodules=all)" ]; then
  die "You have uncommitted changes in explain-ui — commit or stash them, then re-run this script."
fi
if [ -n "$(git -C explain-engine status --porcelain)" ]; then
  die "You have uncommitted changes in explain-engine — commit or stash them, then re-run this script."
fi

# --- 7. Dependencies ----------------------------------------------------------

info "Installing dependencies (npm install)"
npm install

# --- 8. Branches: engine first, then the app ----------------------------------

setup_branch() {
  # $1 = directory, $2 = label for messages
  info "Setting up branch $BRANCH in the $2"
  git -C "$1" fetch origin
  if git -C "$1" show-ref --verify --quiet "refs/heads/$BRANCH"; then
    git -C "$1" checkout "$BRANCH"
  elif git -C "$1" show-ref --verify --quiet "refs/remotes/origin/$BRANCH"; then
    git -C "$1" checkout -b "$BRANCH" "origin/$BRANCH"
  else
    git -C "$1" checkout main
    git -C "$1" pull
    git -C "$1" checkout -b "$BRANCH"
  fi
  if [ "$NO_PUSH" -eq 0 ]; then
    git -C "$1" push -u origin "$BRANCH"
  fi
}

setup_branch explain-engine "engine (explain-engine)"
setup_branch . "app (explain-ui)"

# --- 9. Verify ----------------------------------------------------------------

app_branch=$(git branch --show-current)
eng_branch=$(git -C explain-engine branch --show-current)
if [ "$app_branch" != "$BRANCH" ] || [ "$eng_branch" != "$BRANCH" ]; then
  die "Branch check failed (app: '$app_branch', engine: '$eng_branch') — expected both on '$BRANCH'."
fi

info "Done — you are set up"
echo "  App repo:    $app_branch"
echo "  Engine repo: $eng_branch"
if [ "$NO_PUSH" -eq 1 ]; then
  echo "  (branches were NOT pushed to GitHub because of --no-push)"
fi
echo
echo "Next steps:"
echo "  cd $(pwd)"
echo "  npm run dev        # start the app, then open the URL Vite prints"
echo
echo "Then read STUDENT_WORKFLOW.md section 2 to write your first model."
