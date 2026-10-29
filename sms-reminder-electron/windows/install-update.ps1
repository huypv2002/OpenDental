param(
  [Parameter(Mandatory=$true)][string]$Plan
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$p = Get-Content -LiteralPath $Plan -Raw | ConvertFrom-Json
$work = Split-Path -Parent $Plan
$log = Join-Path $work 'install.log'
$source = Join-Path $work 'extracted'
$backup = Join-Path $work 'backup'
$installed = New-Object System.Collections.Generic.List[string]
try {
  if ((Get-FileHash -LiteralPath $p.archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $p.sha256) { throw 'Update checksum mismatch.' }
  $target = [IO.Path]::GetFullPath([string]$p.target).TrimEnd('\')
  if (!(Test-Path -LiteralPath (Join-Path $target 'LUK Dental SMS Electron.exe'))) { throw 'App folder not found.' }
  $zip = [IO.Compression.ZipFile]::OpenRead($p.archive)
  try {
    foreach ($entry in $zip.Entries) {
      $name = $entry.FullName.Replace('/', '\')
      $dest = [IO.Path]::GetFullPath((Join-Path $source $name))
      if (!$dest.StartsWith(([IO.Path]::GetFullPath($source) + '\'), [StringComparison]::OrdinalIgnoreCase) -or $name.Contains(':')) { throw 'Invalid archive path.' }
      if ($name -match '(?i)(^|\\)(sms_config\.json|state\.json)$') { throw 'Update must not contain workstation data.' }
    }
  } finally { $zip.Dispose() }
  if (Test-Path -LiteralPath $source) { Remove-Item -LiteralPath $source -Recurse -Force }
  [IO.Compression.ZipFile]::ExtractToDirectory($p.archive, $source)
  if (!(Test-Path -LiteralPath (Join-Path $source 'LUK Dental SMS Electron.exe')) -or !(Test-Path -LiteralPath (Join-Path $source 'resources\app.asar'))) { throw 'Incomplete update archive.' }
  $proc = Get-Process -Id $p.pid -ErrorAction SilentlyContinue
  if ($proc -and !$proc.WaitForExit(90000)) { throw 'App did not close. Update cancelled.' }
  Start-Sleep -Seconds 2
  foreach ($file in Get-ChildItem -LiteralPath $source -Recurse -File) {
    $relative = $file.FullName.Substring($source.Length + 1)
    $dest = Join-Path $target $relative
    $old = Join-Path $backup $relative
    if (Test-Path -LiteralPath $dest) {
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $old) | Out-Null
      Copy-Item -LiteralPath $dest -Destination $old -Force
    }
    $installed.Add($relative)
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
    Copy-Item -LiteralPath $file.FullName -Destination $dest -Force
  }
  'Update installed successfully.' | Out-File -LiteralPath $log
} catch {
  $_ | Out-File -LiteralPath $log
  foreach ($relative in $installed) {
    $dest = Join-Path $target $relative
    $old = Join-Path $backup $relative
    if (Test-Path -LiteralPath $old) { Copy-Item -LiteralPath $old -Destination $dest -Force }
    else { Remove-Item -LiteralPath $dest -Force -ErrorAction SilentlyContinue }
  }
}
# Restart in the same folder so existing Windows scheduler paths remain valid.
$exe = Join-Path $p.target 'LUK Dental SMS Electron.exe'
if ($p.resumeMonitoring) { Start-Process -FilePath $exe -WorkingDirectory $p.target -ArgumentList '--start-reminder-monitoring' }
else { Start-Process -FilePath $exe -WorkingDirectory $p.target }
