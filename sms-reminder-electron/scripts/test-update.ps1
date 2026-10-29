$ErrorActionPreference = 'Stop'
$installer = Join-Path $PSScriptRoot '..\windows\install-update.ps1'
$root = Join-Path ([IO.Path]::GetTempPath()) ('luk-update-test-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $root | Out-Null
# Run the actual installer against synthetic files; never launch an EXE or wait on the test host.
function Start-Process { param($FilePath,$WorkingDirectory,$ArgumentList) $script:restarted = $FilePath; $script:restartArgs = $ArgumentList }
function Get-Process { param($Id,$ErrorAction) return $null }
function Start-Sleep { param($Seconds) }
function Assert($ok,$message) { if (!$ok) { throw $message } }
try {
  foreach ($kind in @('success','checksum','private-config','traversal','rollback')) {
    $case = Join-Path $root $kind
    $target = Join-Path $case 'App with spaces'
    $payload = Join-Path $case 'payload'
    New-Item -ItemType Directory -Path "$target\resources","$payload\resources" -Force | Out-Null
    Set-Content -LiteralPath "$target\LUK Dental SMS Electron.exe" -Value 'old-exe'
    Set-Content -LiteralPath "$target\resources\app.asar" -Value 'old-asar'
    Set-Content -LiteralPath "$target\sms_config.json" -Value 'private-config-keep'
    Set-Content -LiteralPath "$target\scheduler-runtime.json" -Value 'scheduler-keep'
    Set-Content -LiteralPath "$payload\LUK Dental SMS Electron.exe" -Value 'new-exe'
    Set-Content -LiteralPath "$payload\resources\app.asar" -Value 'new-asar'
    if ($kind -eq 'private-config') { Set-Content -LiteralPath "$payload\sms_config.json" -Value 'must-reject' }
    $archive = Join-Path $case 'update.zip'
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::CreateFromDirectory($payload,$archive)
    if ($kind -eq 'traversal') {
      $z=[IO.Compression.ZipFile]::Open($archive,[IO.Compression.ZipArchiveMode]::Update)
      $e=$z.CreateEntry('../escaped.txt');$w=New-Object IO.StreamWriter($e.Open());$w.Write('bad');$w.Dispose();$z.Dispose()
    }
    $sha=(Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($kind -eq 'checksum') { $sha='0'*64 }
    $plan=Join-Path $case 'plan.json'
    @{archive=$archive;sha256=$sha;target=$target;pid=99999999;resumeMonitoring=$true} | ConvertTo-Json | Set-Content -LiteralPath $plan
    $lock=$null
    if ($kind -eq 'rollback') { $lock=[IO.File]::Open("$target\resources\app.asar",[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None) }
    try { & $installer -Plan $plan } finally { if ($lock) {$lock.Dispose()} }
    $expected=if ($kind -eq 'success') {'new-exe'} else {'old-exe'}
    Assert ((Get-Content -LiteralPath "$target\LUK Dental SMS Electron.exe" -Raw).Trim() -eq $expected) "$kind EXE result"
    $expectedAsar=if ($kind -eq 'success') {'new-asar'} else {'old-asar'}
    Assert ((Get-Content -LiteralPath "$target\resources\app.asar" -Raw).Trim() -eq $expectedAsar) "$kind ASAR result"
    Assert ((Get-Content -LiteralPath "$target\sms_config.json" -Raw).Trim() -eq 'private-config-keep') "$kind config changed"
    Assert ((Get-Content -LiteralPath "$target\scheduler-runtime.json" -Raw).Trim() -eq 'scheduler-keep') "$kind scheduler changed"
    Assert ($script:restarted -eq "$target\LUK Dental SMS Electron.exe") "$kind restart path"
    Assert ($script:restartArgs -eq '--start-reminder-monitoring') "$kind resume monitoring"
    Assert (!(Test-Path -LiteralPath (Join-Path $case 'escaped.txt'))) "$kind path traversal"
    Write-Host "PASS update installer: $kind"
  }
} finally { Remove-Item -LiteralPath $root -Recurse -Force }
