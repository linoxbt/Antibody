# Antibody installer for Windows (PowerShell). Downloads Antibody, installs its
# dependencies and adds an `antibody` command. Re-running it updates.
#
#   irm https://antibody-memory.netlify.app/install.ps1 | iex
#
# Settings (optional): $env:ANTIBODY_APP_DIR (default %LOCALAPPDATA%\Antibody\app),
# $env:ANTIBODY_REPO, $env:ANTIBODY_REF. Your data and keys live in %USERPROFILE%\.antibody
# (ANTIBODY_HOME); this script never touches them.

& {
  # Native tools write progress to stderr; failures are caught by exit code below, not by stderr.
  $ErrorActionPreference = 'Continue'
  $Repo = if ($env:ANTIBODY_REPO) { $env:ANTIBODY_REPO } else { 'https://github.com/linoxbt/Antibody.git' }
  $Ref = if ($env:ANTIBODY_REF) { $env:ANTIBODY_REF } else { 'main' }
  $Root = Join-Path $env:LOCALAPPDATA 'Antibody'
  $Dir = if ($env:ANTIBODY_APP_DIR) { $env:ANTIBODY_APP_DIR } else { Join-Path $Root 'app' }
  $Bin = Join-Path $Root 'bin'

  function Ok($m) { Write-Host "  + $m" -ForegroundColor Green }
  function Fail($m, [string[]]$fix) {
    Write-Host ''
    Write-Host "x $m" -ForegroundColor Red
    foreach ($f in $fix) { Write-Host "  $f" }
    Write-Host ''
    Write-Host '  More fixes: https://antibody-memory.netlify.app/install#troubleshooting'
    throw 'Antibody was not installed (see the message above).'
  }

  Write-Host 'Antibody installer' -ForegroundColor White

  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Fail 'git is not installed.' @('Install it: winget install --id Git.Git -e', 'Then open a NEW PowerShell window and run this installer again.')
  }
  Ok ((git --version) -replace 'git version ', 'git ')

  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Fail 'Node.js is not installed (Antibody needs version 22 or newer).' @('Install it: winget install OpenJS.NodeJS.LTS', 'Or download the LTS installer from https://nodejs.org', 'Then open a NEW PowerShell window and run this installer again.')
  }
  $major = [int](node -p "process.versions.node.split('.')[0]")
  if ($major -lt 22) {
    Fail "Node.js $(node -v) is too old; Antibody needs 22 or newer." @('Update it: winget upgrade OpenJS.NodeJS.LTS (or install from https://nodejs.org)', 'Then open a NEW PowerShell window and run this installer again.')
  }
  Ok "Node.js $(node -v)"
  if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Fail 'npm is missing.' @('npm ships with Node.js: reinstall Node.js 22 or newer.') }
  Ok "npm $(npm -v)"

  if (Test-Path (Join-Path $Dir '.git')) {
    Write-Host "Updating $Dir"
    git -C "$Dir" fetch --depth 1 origin $Ref
    if ($LASTEXITCODE -ne 0) { Fail 'Could not reach GitHub to update.' @('Check your internet connection, or a proxy/firewall blocking github.com.') }
    git -C "$Dir" checkout -q -B $Ref FETCH_HEAD
  } elseif (Test-Path $Dir) {
    Fail "$Dir exists but is not an Antibody install." @('Move it away, or choose another folder: $env:ANTIBODY_APP_DIR = "C:\antibody-app", then run the installer again.')
  } else {
    Write-Host "Downloading Antibody into $Dir"
    New-Item -ItemType Directory -Force -Path (Split-Path $Dir) | Out-Null
    git clone -q --depth 1 --branch $Ref $Repo "$Dir"
    if ($LASTEXITCODE -ne 0) { Fail "Could not download Antibody from $Repo." @('Check your internet connection, or a proxy/firewall blocking github.com.') }
  }
  Ok "source at $(git -C "$Dir" rev-parse --short HEAD)"

  Write-Host 'Installing dependencies (about a minute)'
  Push-Location $Dir
  try {
    npm ci --omit=dev --no-audit --no-fund --loglevel=error
    if ($LASTEXITCODE -ne 0) { Fail 'npm could not install the dependencies.' @('Out of disk space? Free some and re-run.', 'Behind a proxy? npm config set proxy http://host:port', 'Then run this installer again; it picks up where it stopped.') }
  } finally { Pop-Location }
  Ok 'dependencies installed'

  New-Item -ItemType Directory -Force -Path $Bin | Out-Null
  $cmd = Join-Path $Bin 'antibody.cmd'
  Set-Content -Path $cmd -Encoding ASCII -Value "@echo off`r`nnode `"$Dir\bin\antibody.mjs`" %*"
  Ok "command installed at $cmd"

  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not (($userPath -split ';') -contains $Bin)) {
    [Environment]::SetEnvironmentVariable('Path', ($(if ($userPath) { "$userPath;" } else { '' }) + $Bin), 'User')
    Ok 'added to your PATH (new windows pick it up)'
  }
  if (-not (($env:Path -split ';') -contains $Bin)) { $env:Path = "$env:Path;$Bin" }

  & $cmd --help | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail 'The antibody command did not start.' @("Run it directly to see why: node `"$Dir\bin\antibody.mjs`" --help") }

  Write-Host ''
  Write-Host 'Antibody is installed.' -ForegroundColor White
  Write-Host '  Try it (simulated, no keys needed):'
  Write-Host '    antibody setup     # keys and a practice account'
  Write-Host '    antibody up        # starts Antibody and prints your sign-in link'
  Write-Host ''
  Write-Host '  Guide: https://antibody-memory.netlify.app/install'
}
