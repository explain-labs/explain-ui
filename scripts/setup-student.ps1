<#
One-time student setup for Explain — automates STUDENT_WORKFLOW.md section 1.

Usage:
  powershell -ExecutionPolicy Bypass -File setup-student.ps1 [<yourname>] [-NoPush]

Run it from the folder where you keep your projects (it will clone explain-ui
there), or from inside an existing explain-ui clone (it will finish/repair the
setup). Safe to re-run at any time.
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)][string]$Name = "",
    [switch]$NoPush
)

$ErrorActionPreference = "Stop"
$RepoSsh = "git@github.com:Dobutamine/explain-ui.git"

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

function Test-GitRef([string]$Dir, [string]$Ref) {
    & git -C $Dir show-ref --verify --quiet $Ref
    return ($LASTEXITCODE -eq 0)
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

# --- 2. Student name → branch name -------------------------------------------

$Name = $Name.ToLowerInvariant()
while ($Name -cnotmatch '^[a-z0-9][a-z0-9-]*$') {
    if ($Name -ne "") {
        Warn "'$Name' won't work as a branch name — use only lowercase letters, digits and hyphens (e.g. 'tim' or 'anna-b')."
    }
    $Name = (Read-Host "Your name (becomes branch student/<name>)").ToLowerInvariant()
}
$Branch = "student/$Name"

# --- 3. SSH access to GitHub --------------------------------------------------

Info "Checking SSH access to GitHub"
$sshOk = $false
if (Get-Command ssh -ErrorAction SilentlyContinue) {
    $sshOut = cmd /c "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -T git@github.com 2>&1"
    if (($sshOut -join "`n") -match "successfully authenticated") { $sshOk = $true }
}
if ($sshOk) {
    Write-Host "SSH access to GitHub works."
} else {
    Warn "Could not authenticate to GitHub over SSH."
    Write-Host "  - Set up an SSH key: https://docs.github.com/en/authentication/connecting-to-github-with-ssh"
    Write-Host "  - Make sure your instructor added you as a collaborator on BOTH repositories."
    $reply = Read-Host "Continue anyway? [y/N]"
    if ($reply -notmatch '^[yY]$') { exit 1 }
}

# --- 4. Locate or clone the repository ----------------------------------------

$toplevel = cmd /c "git rev-parse --show-toplevel 2>nul"
if ($LASTEXITCODE -eq 0 -and $toplevel) {
    $pkg = Join-Path $toplevel "package.json"
    if ((Test-Path $pkg) -and ((Get-Content -Raw $pkg) -match '"name": "explain-user"')) {
        Info "Already inside an explain-ui clone: $toplevel"
        Set-Location $toplevel
    } else {
        Fail ("You are inside a git repository that isn't explain-ui ($toplevel).`n" +
              "       Run this script from the folder where you keep your projects, or from inside your explain-ui clone.")
    }
} elseif (Test-Path "explain-ui/package.json") {
    Info "Found an existing clone at ./explain-ui"
    Set-Location explain-ui
} else {
    Info "Cloning explain-ui (with the explain-engine submodule)"
    & git clone --recurse-submodules $RepoSsh
    if ($LASTEXITCODE -ne 0) { Fail "git clone failed — check your SSH access and collaborator invitation." }
    Set-Location explain-ui
}

# --- 5. Repair the submodule if it's missing ----------------------------------

if (-not (Test-Path "explain-engine/Model.js")) {
    Info "explain-engine/ is empty — fetching the submodule"
    Invoke-Git . submodule update --init
}

# --- 6. Refuse to touch branches over uncommitted work ------------------------

if (& git -C . status --porcelain --ignore-submodules=all) {
    Fail "You have uncommitted changes in explain-ui — commit or stash them, then re-run this script."
}
if (& git -C explain-engine status --porcelain) {
    Fail "You have uncommitted changes in explain-engine — commit or stash them, then re-run this script."
}

# --- 7. Dependencies ----------------------------------------------------------

Info "Installing dependencies (npm install)"
& npm install
if ($LASTEXITCODE -ne 0) { Fail "npm install failed." }

# --- 8. Branches: engine first, then the app ----------------------------------

function Setup-Branch([string]$Dir, [string]$Label) {
    Info "Setting up branch $Branch in the $Label"
    Invoke-Git $Dir fetch origin
    if (Test-GitRef $Dir "refs/heads/$Branch") {
        Invoke-Git $Dir checkout $Branch
    } elseif (Test-GitRef $Dir "refs/remotes/origin/$Branch") {
        Invoke-Git $Dir checkout -b $Branch "origin/$Branch"
    } else {
        Invoke-Git $Dir checkout main
        Invoke-Git $Dir pull
        Invoke-Git $Dir checkout -b $Branch
    }
    if (-not $NoPush) {
        Invoke-Git $Dir push -u origin $Branch
    }
}

Setup-Branch explain-engine "engine (explain-engine)"
Setup-Branch . "app (explain-ui)"

# --- 9. Verify ----------------------------------------------------------------

$appBranch = & git -C . branch --show-current
$engBranch = & git -C explain-engine branch --show-current
if ($appBranch -ne $Branch -or $engBranch -ne $Branch) {
    Fail "Branch check failed (app: '$appBranch', engine: '$engBranch') — expected both on '$Branch'."
}

Info "Done — you are set up"
Write-Host "  App repo:    $appBranch"
Write-Host "  Engine repo: $engBranch"
if ($NoPush) {
    Write-Host "  (branches were NOT pushed to GitHub because of -NoPush)"
}
Write-Host ""
Write-Host "Next steps:"
Write-Host "  cd $(Get-Location)"
Write-Host "  npm run dev        # start the app, then open the URL Vite prints"
Write-Host ""
Write-Host "Then read STUDENT_WORKFLOW.md section 2 to write your first model."
