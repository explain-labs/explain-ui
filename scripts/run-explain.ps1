<#
Get Explain running locally — no GitHub account, SSH key, or git knowledge needed.

Usage:
  powershell -ExecutionPolicy Bypass -File run-explain.ps1 [-NoDev]

Run it from the folder where you keep your projects (it will clone explain-ui
there), or from inside an existing explain-ui clone. Re-running it updates to
the latest version and starts the app again. -NoDev sets everything up but
doesn't start the app.
#>
[CmdletBinding()]
param(
    [switch]$NoDev
)

$ErrorActionPreference = "Stop"
$RepoHttps = "https://github.com/explain-labs/explain-ui.git"

function Info($msg) { Write-Host ""; Write-Host "==> $msg" -ForegroundColor Cyan }
function Warn($msg) { Write-Host "WARNING: $msg" -ForegroundColor Yellow }
function Fail($msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }

function Invoke-Git {
    # Invoke-Git <dir> <git args...> — runs git, aborts the script on failure.
    param([string]$Dir)
    $gitArgs = $args
    & git -C $Dir @gitArgs
    if ($LASTEXITCODE -ne 0) { Fail "git $($gitArgs -join ' ') failed (in $Dir)" }
}

# --- 1. Prerequisites ---------------------------------------------------------

function Need([string]$Tool, [string]$Hint) {
    if (-not (Get-Command $Tool -ErrorAction SilentlyContinue)) {
        Fail "'$Tool' is not installed. $Hint"
    }
}

Need git  "Install it with: winget install Git.Git   (or from https://git-scm.com)"
Need node "Install it with: winget install OpenJS.NodeJS.LTS   (or from https://nodejs.org)"
Need npm  "It comes with Node.js — install Node from https://nodejs.org"

$nodeMajor = [int](& node -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt 20) {
    Warn "Node $(& node --version) detected — the app needs Node 20 or newer. Get it from https://nodejs.org"
}

# --- 2. Locate or clone the repository ----------------------------------------
# The engine submodule's recorded URL is SSH-only; the insteadOf rewrite lets
# everything fetch anonymously over HTTPS instead.

$toplevel = cmd /c "git rev-parse --show-toplevel 2>nul"
if ($LASTEXITCODE -eq 0 -and $toplevel) {
    $pkg = Join-Path $toplevel "package.json"
    if ((Test-Path $pkg) -and ((Get-Content -Raw $pkg) -match '"name": "explain-user"')) {
        Info "Using existing explain-ui clone: $toplevel"
        Set-Location $toplevel
    } else {
        Fail ("You are inside a git repository that isn't explain-ui ($toplevel).`n" +
              "       Run this script from the folder where you keep your projects, or from inside your explain-ui clone.")
    }
} elseif (Test-Path "explain-ui/package.json") {
    Info "Found an existing clone at ./explain-ui"
    Set-Location explain-ui
} else {
    Info "Downloading Explain (this can take a minute)"
    & git -c url."https://github.com/".insteadOf="git@github.com:" clone --recurse-submodules $RepoHttps
    if ($LASTEXITCODE -ne 0) { Fail "git clone failed — check your internet connection." }
    Set-Location explain-ui
}

# Persist the HTTPS rewrite for future submodule updates — but only in clones
# whose origin is already HTTPS, so SSH-based clones (developers, students) are
# left alone.
$originUrl = & git -C . remote get-url origin
if ($originUrl -like "https://*") {
    Invoke-Git . config url."https://github.com/".insteadOf "git@github.com:"
}

# --- 3. Repair the submodule if it's missing ----------------------------------

if (-not (Test-Path "explain-engine/Model.js")) {
    Info "explain-engine/ is empty — fetching the submodule"
    Invoke-Git . submodule update --init
}

# --- 4. Update to the latest version, when that is safe ------------------------

$branch = & git -C . branch --show-current
if ($branch -eq "main" -and -not (& git -C . status --porcelain --ignore-submodules=all)) {
    Info "Updating to the latest version"
    Invoke-Git . pull
    if (-not (& git -C explain-engine status --porcelain)) {
        Invoke-Git . submodule update --init
    } else {
        Warn "Skipping engine update: explain-engine has local changes."
    }
} else {
    Info "Skipping update: local changes or a non-main branch ('$branch') — leaving your checkout as it is."
}

# --- 5. Dependencies ----------------------------------------------------------

Info "Installing dependencies (npm install)"
& npm install
if ($LASTEXITCODE -ne 0) { Fail "npm install failed." }

# --- 6. Launch ----------------------------------------------------------------

if ($NoDev) {
    Info "Done — Explain is ready"
    Write-Host "Start it with:"
    Write-Host "  cd $(Get-Location)"
    Write-Host "  npm run dev        # then open the URL Vite prints"
} else {
    Info "Starting Explain — open the URL below in your browser (Ctrl-C stops it)"
    & npm run dev
}
