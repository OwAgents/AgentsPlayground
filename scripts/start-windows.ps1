# Windows first-run launcher for Worker Agents.
# Run from PowerShell:
#   powershell -ExecutionPolicy Bypass -File .\scripts\start-windows.ps1
param(
  [int]$Port = $(if ($env:PORT) { [int]$env:PORT } else { 1456 }),
  [switch]$Clean9Router,
  [switch]$CleanOpenCode,
  [switch]$CleanAll,
  [switch]$NoStart
)

$ErrorActionPreference = 'Stop'
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $repoRoot

function Has-Command($Name) {
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Install-WithWinget($Id, $Name) {
  if (-not (Has-Command winget)) {
    throw "$Name is missing and winget is not available. Install $Name manually, then rerun this script."
  }
  Write-Host "[setup] Installing $Name with winget..."
  winget install --id $Id --exact --silent --accept-package-agreements --accept-source-agreements
}

function Refresh-Path {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$machine;$user;$env:Path"
}

function Ensure-Node {
  if (-not (Has-Command node)) {
    Install-WithWinget 'OpenJS.NodeJS.LTS' 'Node.js LTS'
    Refresh-Path
  }
  $major = [int]((node --version).TrimStart('v').Split('.')[0])
  if ($major -lt 22) {
    throw "Node.js >=22 is required; found $(node --version). Install a newer Node.js LTS and rerun."
  }
  if (-not (Has-Command npm)) { Refresh-Path }
  if (-not (Has-Command npm)) { throw 'npm is missing after Node.js check.' }
}

function Ensure-Git {
  if (-not (Has-Command git)) {
    Install-WithWinget 'Git.Git' 'Git for Windows'
    Refresh-Path
  }
  $npmPrefix = (npm config get prefix 2>$null)
  if ($npmPrefix -and (Test-Path $npmPrefix) -and ($env:Path -notlike "*$npmPrefix*")) { $env:Path = "$npmPrefix;$env:Path" }

  $gitRoot = Join-Path $env:ProgramFiles 'Git'
  foreach ($p in @((Join-Path $gitRoot 'bin'), (Join-Path $gitRoot 'usr\bin'), (Join-Path $gitRoot 'cmd'))) {
    if ((Test-Path $p) -and ($env:Path -notlike "*$p*")) { $env:Path = "$p;$env:Path" }
  }
  if (-not (Has-Command git)) { throw 'git is still missing after setup.' }
  if (-not (Has-Command bash)) { throw 'Git Bash is missing after setup.' }
}

function Ensure-Python {
  if (Has-Command py) { return }
  if (Has-Command python) { return }
  if (Has-Command python3) { return }
  Install-WithWinget 'Python.Python.3.11' 'Python 3.11'
  Refresh-Path
  if (-not (Has-Command py) -and -not (Has-Command python) -and -not (Has-Command python3)) {
    throw 'Python is still missing after setup.'
  }
}

function Stop-Port($PortNumber) {
  $listeners = Get-NetTCPConnection -LocalPort $PortNumber -State Listen -ErrorAction SilentlyContinue
  foreach ($conn in $listeners) { Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue }
}

Ensure-Node
Ensure-Git
Ensure-Python

Write-Host "[setup] node: $(node --version)"
Write-Host "[setup] npm:  $(npm --version)"
Write-Host "[setup] git:  $(git --version)"
if (Has-Command py) {
  Write-Host "[setup] python: $(py --version)"
} elseif (Has-Command python) {
  Write-Host "[setup] python: $(python --version)"
} elseif (Has-Command python3) {
  Write-Host "[setup] python: $(python3 --version)"
}

Write-Host '[setup] Installing npm dependencies...'
npm ci

if ($CleanAll -or $Clean9Router) {
  Write-Host '[setup] Cleaning 9Router state...'
  Stop-Port 20128
  Remove-Item -Recurse -Force "$HOME\9router", "$HOME\.9router", "$env:TEMP\9router.log" -ErrorAction SilentlyContinue
  Remove-Item -Force 'C:\tmp\9router.log' -ErrorAction SilentlyContinue
}

if ($CleanAll -or $CleanOpenCode) {
  Write-Host '[setup] Cleaning OpenCode state...'
  Stop-Port 18924
  npm uninstall -g opencode-ai 2>$null | Out-Null
  Remove-Item -Recurse -Force "$HOME\.opencode" -ErrorAction SilentlyContinue
  Remove-Item -Force "$env:TEMP\agent-console-agent-opencode.log", 'C:\tmp\agent-console-agent-opencode.log' -ErrorAction SilentlyContinue
}

if ($NoStart) {
  Write-Host '[setup] NoStart requested; dependencies are ready.'
  exit 0
}

$env:PORT = [string]$Port
$env:AGENT_CONSOLE_HOST = if ($env:AGENT_CONSOLE_HOST) { $env:AGENT_CONSOLE_HOST } else { '127.0.0.1' }
Write-Host "[start] Worker Agents: http://127.0.0.1:$Port"
npm start
