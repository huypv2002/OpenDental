# Compile and copy the in-process OD hash plugin. Does not write payments or patch CDT.
param(
 [string]$InstallDir,
 [switch]$Register
)
$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot -Parent
if (-not $InstallDir) {
 $InstallDir=$env:METLIFE_OD_INSTALL_DIR
}
if (-not $InstallDir) {
 $InstallDir=@("${env:ProgramFiles(x86)}\Open Dental","$env:ProgramFiles\Open Dental",'C:\Open Dental') |
  Where-Object { Test-Path -LiteralPath (Join-Path $_ 'OpenDentBusiness.dll') } |
  Select-Object -First 1
}
if (-not $InstallDir) { throw 'Open Dental installation not found.' }
$InstallDir=(Resolve-Path -LiteralPath $InstallDir).Path
$business=Join-Path $InstallDir 'OpenDentBusiness.dll'
$compiler=Join-Path $env:SystemRoot 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw '.NET Framework C# compiler not found.' }
$source=Join-Path $PSScriptRoot 'od-hash-plugin\LukMetlifeHash.cs'
if (-not (Test-Path -LiteralPath $source)) { throw "Missing $source" }
$buildDir=Join-Path $env:TEMP ('luk-metlife-hash-plugin-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $buildDir | Out-Null
try {
 $dll=Join-Path $buildDir 'LukMetlifeHash.dll'
 & $compiler /nologo /target:library /platform:x86 /optimize+ /reference:$business /out:$dll $source
 if ($LASTEXITCODE -ne 0) { throw 'Plugin compilation failed.' }
 $dest=Join-Path $InstallDir 'LukMetlifeHash.dll'
 Copy-Item -LiteralPath $dll -Destination $dest -Force
 Write-Host "Copied plugin to $dest"
}
finally {
 Remove-Item -LiteralPath $buildDir -Recurse -Force -ErrorAction SilentlyContinue
}
$sql=@"
INSERT INTO program (ProgName,ProgDesc,Enabled,Path,CommandLine,Note,PluginDllName,ButtonImage,FileTemplate,FilePath,IsDisabledByHq,CustErr)
SELECT 'LukMetlifeHash','LUK MetLife SecurityHash helper',1,'','','Named pipe hash helper for MetLife SQL payments. No UI.','LukMetlifeHash.dll','','','',0,''
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM program WHERE PluginDllName='LukMetlifeHash.dll');
UPDATE program SET Enabled=1, PluginDllName='LukMetlifeHash.dll' WHERE PluginDllName='LukMetlifeHash.dll' OR ProgName='LukMetlifeHash';
"@
$sqlPath=Join-Path $root 'luk-metlife-hash-plugin.sql'
Set-Content -LiteralPath $sqlPath -Value $sql -Encoding ASCII
Write-Host "SQL saved to $sqlPath"
Write-Host 'Close Open Dental, run the SQL, then start Open Dental and leave it logged in on SERVER.'
if ($Register) {
 Write-Host 'This script does not run SQL. Execute luk-metlife-hash-plugin.sql in MariaDB, then restart Open Dental.'
}
