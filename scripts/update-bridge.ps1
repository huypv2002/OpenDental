# Windows PowerShell 5.1. Updates the existing Bridge checkout and restarts its API.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $root
try {
  foreach ($tool in @('git', 'node', 'npm.cmd')) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "Missing command: $tool" }
  }
  if (-not (Test-Path -LiteralPath '.env')) { throw 'Missing .env in this Bridge checkout.' }
  $branch = (& git branch --show-current | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $branch -ne 'main') { throw 'Expected Bridge branch main. No files were reset.' }
  & git diff --quiet HEAD --
  if ($LASTEXITCODE -ne 0) { throw 'Tracked source has local changes. Preserve/review them before updating; no reset was performed.' }
  & git pull --ff-only origin main
  if ($LASTEXITCODE -ne 0) { throw 'Git pull failed. The running Bridge was not stopped.' }
  & npm.cmd ci --omit=dev --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed. The running Bridge was not stopped.' }
  & node --check src/server.js
  if ($LASTEXITCODE -ne 0) { throw 'Bridge source check failed.' }
  & node scripts/configure-metlife.mjs
  if ($LASTEXITCODE -ne 0) { throw 'MetLife configuration failed. The running Bridge was not stopped.' }
  $portText = & node scripts/bridge-port.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Could not read Bridge port.' }
  $bridgePort = 0
  if (-not [int]::TryParse(($portText | Out-String).Trim(), [ref]$bridgePort) -or $bridgePort -lt 1 -or $bridgePort -gt 65535) { throw 'Invalid Bridge port.' }
  $owners = @(Get-NetTCPConnection -State Listen -LocalPort $bridgePort -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
  foreach ($ownerId in $owners) {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$ownerId"
    if (-not $proc -or $proc.Name -ne 'node.exe' -or $proc.CommandLine -notmatch '(?i)(?:^|[\s"\/\\])src[\/\\]server\.js(?:[\s"]|$)') {
      throw "Port $bridgePort belongs to an unrecognized process ($ownerId). Nothing was stopped."
    }
    $service = Get-CimInstance Win32_Service -Filter "ProcessId=$ownerId"
    if ($service) { throw 'Bridge is managed by a Windows service. Restart it through that service manager.' }
  }
  foreach ($ownerId in $owners) {
    Stop-Process -Id $ownerId -ErrorAction Stop
    Wait-Process -Id $ownerId -Timeout 15 -ErrorAction SilentlyContinue
  }
  Start-Process -FilePath $env:ComSpec -WorkingDirectory $root -ArgumentList '/k', 'title Open Dental Bridge API & npm start'
  $ready = $false
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Seconds 1
    try {
      $health = Invoke-RestMethod -Uri "http://127.0.0.1:$bridgePort/health" -TimeoutSec 2
      if ($health.ok -eq $true) { $ready = $true; break }
    } catch { }
  }
  if (-not $ready) { throw 'Bridge did not pass /health. Inspect the Open Dental Bridge API window.' }
  # Keep an existing tunnel; only launch the named tunnel if none is running.
  $tunnels = @(Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" | Where-Object { $_.CommandLine -match '(?i)\btunnel\s+run\s+["'']?od-bridge(?:["''\s]|$)' })
  if ($tunnels.Count -eq 0) {
    if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) { throw 'Bridge is healthy locally, but cloudflared is not on PATH.' }
    Start-Process -FilePath $env:ComSpec -WorkingDirectory $root -ArgumentList '/k', 'title Cloudflare Tunnel - od-bridge & cloudflared tunnel run od-bridge'
  }
  Write-Host 'Bridge updated and /health passed. Existing tunnel retained or launched.'
  Write-Host 'R5: open MetLife Assistant 0.3.2 on clinic LAN. Automatic SERVER:3008 connection, no login or JSON needed.'
  exit 0
} catch {
  Write-Host ("UPDATE FAILED: " + $_.Exception.Message) -ForegroundColor Red
  exit 1
}
