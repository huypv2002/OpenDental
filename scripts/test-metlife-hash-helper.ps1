# Synthetic DLL tests for helper loading/binding/error handling only.
# Does not implement or distribute OD/CDT hashing, and never connects to a DB.
param([ValidateSet('x86','x64')][string]$FixtureArchitecture='x64')
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
   return "SYNTHETIC|"+split.PatNum+"|"+split.SplitAmt.ToString("F2",CultureInfo.InvariantCulture)+"|"+split.DatePay.ToString("yyyy-MM-dd");
  }
 }
}
'@
 $sourceFile = Join-Path $dir 'Synthetic.cs'
 [IO.File]::WriteAllText($sourceFile,$source)
 $compiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
 & $compiler /nologo /target:library ('/platform:'+$FixtureArchitecture) ('/out:'+(Join-Path $dir 'OpenDentBusiness.dll')) $sourceFile
 if ($LASTEXITCODE -ne 0) { throw 'Could not compile the synthetic helper fixture.' }
 $env:METLIFE_OD_INSTALL_DIR = $dir
 $helper = Join-Path $PSScriptRoot 'metlife-new-split-hashes.ps1'
 function RunHelper($rows) {
  $request = @{splits=@($rows)} | ConvertTo-Json -Compress -Depth 5
  $out = $request | & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $helper
  $script:helperCode = $LASTEXITCODE
  return ($out | ConvertFrom-Json)
 }
 $result = RunHelper @(@{patNum='99';amount='35.00';date='2026-09-24'},@{patNum='99';amount='1.00';date='2026-09-24'})
 if (-not $result.ok -or $helperCode -ne 0 -or $result.hashes.Count -ne 2 -or $result.hashes[0] -cne 'SYNTHETIC|99|35.00|2026-09-24') { throw ('Native helper did not bind exact new split fields: ' + ($result | ConvertTo-Json -Compress -Depth 5)) }
 foreach ($amount in @('0.02','0.03','1.001')) {
  $bad = RunHelper @(@{patNum='99';amount=$amount;date='2026-09-24'})
  if ($bad.ok -or $helperCode -eq 0) { throw 'Native helper accepted invalid input or a failed native hash.' }
 }
 'OD new-split helper passed synthetic assembly loading, exact fields, blank/error hash rejection and invalid amount rejection. Actual OD/CDT library not available in CI.'
} finally {
 $env:METLIFE_OD_INSTALL_DIR=$old
 Remove-Item -LiteralPath $dir -Recurse -Force
}
