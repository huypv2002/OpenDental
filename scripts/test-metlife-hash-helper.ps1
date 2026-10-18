# Synthetic DLL tests for helper loading/binding/error handling only.
# Does not implement or distribute OD/CDT hashing, and never connects to a DB.
param(
 [ValidateSet('x86','x64','anycpu')][string]$FixtureArchitecture='x64',
 [ValidateSet('x86','x64','anycpu')][string]$MainArchitecture
)
if (-not $MainArchitecture) { $MainArchitecture = $FixtureArchitecture }
$ErrorActionPreference = 'Stop'
$dir = Join-Path $env:TEMP ('luk-metlife-hash-test-' + [Guid]::NewGuid().ToString('N'))
$old = $env:METLIFE_OD_INSTALL_DIR
New-Item -ItemType Directory -Path $dir | Out-Null
try {
 $source = @'
using System;
using System.Reflection;
using System.Globalization;
[assembly: AssemblyVersion("24.3.61.0")]
namespace OpenDentBusiness {
 public class PaySplit { public long PatNum; public double SplitAmt; public DateTime DatePay; }
 public static class PaySplits {
  public static string HashFields(PaySplit split) {
   if(split.SplitAmt==0.02) return "";
   if(split.SplitAmt==0.03) return "DllNotFoundException";
   try { return CodeBase.SyntheticDependency.Prefix()+split.PatNum+"|"+split.SplitAmt.ToString("F2",CultureInfo.InvariantCulture)+"|"+split.DatePay.ToString("yyyy-MM-dd"); }
   catch(BadImageFormatException) { return "BadImageFormatException"; }
  }
 }
}
'@
 $sourceFile = Join-Path $dir 'Synthetic.cs'
 [IO.File]::WriteAllText($sourceFile,$source)
 $compiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
 # Separate managed dependencies reproduce the installed OD dependency graph.
 $cdtSource = Join-Path $dir 'SyntheticCdt.cs'
 [IO.File]::WriteAllText($cdtSource,'using System.Reflection; [assembly: AssemblyVersion("24.3.61.0")] namespace CDT { public static class SyntheticDependency { public static string Prefix() { return "SYNTHETIC|"; } } }')
 if ($FixtureArchitecture -eq 'anycpu') {
  # Simulate AnyCPU wrappers reaching a native x86 dependency only on Invoke.
  [IO.File]::WriteAllText($cdtSource,([IO.File]::ReadAllText($cdtSource).Replace('return "SYNTHETIC|";', 'if(System.IntPtr.Size==8) throw new System.BadImageFormatException("Synthetic x86 native dependency."); return "SYNTHETIC|";')))
 }
 & $compiler /nologo /target:library ('/platform:'+$FixtureArchitecture) ('/out:'+(Join-Path $dir 'CDT.dll')) $cdtSource
 if ($LASTEXITCODE -ne 0) { throw 'Could not compile synthetic CDT dependency.' }
 $codeBaseSource = Join-Path $dir 'SyntheticCodeBase.cs'
 [IO.File]::WriteAllText($codeBaseSource,'using System.Reflection; [assembly: AssemblyVersion("24.3.61.0")] namespace CodeBase { public static class SyntheticDependency { public static string Prefix() { return CDT.SyntheticDependency.Prefix(); } } }')
 & $compiler /nologo /target:library ('/platform:'+$FixtureArchitecture) ('/reference:'+(Join-Path $dir 'CDT.dll')) ('/out:'+(Join-Path $dir 'CodeBase.dll')) $codeBaseSource
 if ($LASTEXITCODE -ne 0) { throw 'Could not compile synthetic CodeBase dependency.' }
 & $compiler /nologo /target:library ('/platform:'+$MainArchitecture) ('/reference:'+(Join-Path $dir 'CodeBase.dll')) ('/out:'+(Join-Path $dir 'OpenDentBusiness.dll')) $sourceFile
 if ($LASTEXITCODE -ne 0) { throw 'Could not compile the synthetic helper fixture.' }
 $env:METLIFE_OD_INSTALL_DIR = $dir
 $helper = Join-Path $PSScriptRoot 'metlife-new-split-hashes.ps1'
 function RunHelper($rows) {
  $request = @{splits=@($rows)} | ConvertTo-Json -Compress -Depth 5
  $out = $request | & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $helper
  $script:helperCode = $LASTEXITCODE
  $parsed = $out | ConvertFrom-Json
  if ($parsed.retry32) {
   $out = $request | & (Join-Path $env:SystemRoot 'SysWOW64\WindowsPowerShell\v1.0\powershell.exe') -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $helper
   $script:helperCode = $LASTEXITCODE
   $parsed = $out | ConvertFrom-Json
  }
  return $parsed
 }
 $result = RunHelper @(@{patNum='99';amount='35.00';date='2026-09-24'},@{patNum='99';amount='1.00';date='2026-09-24'})
 if (-not $result.ok -or $helperCode -ne 0 -or $result.hashes.Count -ne 2 -or $result.hashes[0] -cne 'SYNTHETIC|99|35.00|2026-09-24') { throw ('Native helper did not bind exact new split fields: ' + ($result | ConvertTo-Json -Compress -Depth 5)) }
 $expectedBits = if ($FixtureArchitecture -in @('x86','anycpu')) { 32 } else { 64 }
 if ($result.processBits -ne $expectedBits) { throw ('Wrong helper architecture for OD dependencies: ' + ($result | ConvertTo-Json -Compress)) }
 foreach ($amount in @('0.02','0.03','1.001')) {
  $bad = RunHelper @(@{patNum='99';amount=$amount;date='2026-09-24'})
  if ($bad.ok -or $helperCode -eq 0) { throw 'Native helper accepted invalid input or a failed native hash.' }
 }
 Rename-Item -LiteralPath (Join-Path $dir 'CodeBase.dll') -NewName 'CodeBase.dll.hidden'
 try {
  $missing = RunHelper @(@{patNum='99';amount='35.00';date='2026-09-24'})
  if ($missing.ok -or $helperCode -eq 0 -or $missing.error -notmatch 'Missing OD dependency:.*CodeBase.dll') { throw 'Missing dependency was not diagnosed explicitly.' }
 } finally {
  Rename-Item -LiteralPath (Join-Path $dir 'CodeBase.dll.hidden') -NewName 'CodeBase.dll'
 }
 Rename-Item -LiteralPath (Join-Path $dir 'CodeBase.dll') -NewName 'CodeBase.dll.correct'
 try {
  $wrongSource = Join-Path $dir 'WrongCodeBase.cs'
  [IO.File]::WriteAllText($wrongSource,([IO.File]::ReadAllText($codeBaseSource).Replace('24.3.61.0','24.3.60.0')))
  & $compiler /nologo /target:library ('/platform:'+$FixtureArchitecture) ('/reference:'+(Join-Path $dir 'CDT.dll')) ('/out:'+(Join-Path $dir 'CodeBase.dll')) $wrongSource
  if ($LASTEXITCODE -ne 0) { throw 'Could not compile the mismatched dependency fixture.' }
  $wrong = RunHelper @(@{patNum='99';amount='35.00';date='2026-09-24'})
  if ($wrong.ok -or $helperCode -eq 0 -or $wrong.error -notmatch 'identity mismatch') { throw ('Mismatched dependency was accepted: ' + ($wrong | ConvertTo-Json -Compress)) }
 } finally {
  Remove-Item -LiteralPath (Join-Path $dir 'CodeBase.dll') -Force
  Rename-Item -LiteralPath (Join-Path $dir 'CodeBase.dll.correct') -NewName 'CodeBase.dll'
 }
 $nodeTest = Join-Path $dir 'native-launcher-test.mjs'
 [IO.File]::WriteAllText($nodeTest,@'
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
const {nativeSplitHashes}=await import(pathToFileURL(path.resolve('src/metlife/nativeSplitHashes.js')));
const hashes=await nativeSplitHashes({patNum:'99',date:'2026-09-24',splits:[{amountCents:3500},{amountCents:100}]});
assert.deepEqual(hashes,['SYNTHETIC|99|35.00|2026-09-24','SYNTHETIC|99|1.00|2026-09-24']);
await assert.rejects(nativeSplitHashes({patNum:'99',date:'2026-09-24',splits:[{amountCents:3}]}),/SecurityHash/);
console.log('Node to Windows PowerShell to synthetic OD helper passed, including architecture selection and native error rejection.');
'@)
 & node $nodeTest
 if ($LASTEXITCODE -ne 0) { throw 'Node native-helper launcher test failed.' }
 ('OD helper passed synthetic dependencies: main=' + $MainArchitecture + ', dependencies=' + $FixtureArchitecture + ', helper=' + $expectedBits + '-bit. Actual OD/CDT library not available in CI.')
} finally {
 $env:METLIFE_OD_INSTALL_DIR=$old
 Remove-Item -LiteralPath $dir -Recurse -Force
}
