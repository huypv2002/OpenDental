# Internal helper for NEW split values only. Never reads/writes the OD database,
# modifies an existing row, patches a DLL, or disables integrity checks.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
 $rawInput = [Console]::In.ReadToEnd()
 $inputData = $rawInput | ConvertFrom-Json
 $candidates = @()
 if ($env:METLIFE_OD_INSTALL_DIR) { $candidates += $env:METLIFE_OD_INSTALL_DIR }
 $candidates += @("${env:ProgramFiles(x86)}\Open Dental", "$env:ProgramFiles\Open Dental", 'C:\Open Dental')
 $install = $candidates | Where-Object { Test-Path -LiteralPath (Join-Path $_ 'OpenDentBusiness.dll') } | Select-Object -First 1
 if (-not $install) { throw 'OpenDentBusiness.dll was not found on SERVER. Check the OD installation directory; METLIFE_OD_INSTALL_DIR is optional for a custom location.' }
 $install = (Resolve-Path -LiteralPath $install).Path
 [Environment]::CurrentDirectory = $install
 Set-Location -LiteralPath $install
 $dll = Join-Path $install 'OpenDentBusiness.dll'
 $architecture = [Reflection.AssemblyName]::GetAssemblyName($dll).ProcessorArchitecture.ToString()
 if ($architecture -eq 'X86' -and [IntPtr]::Size -eq 8) {
  $info = New-Object Diagnostics.ProcessStartInfo
  $info.FileName = Join-Path $env:SystemRoot 'SysWOW64\WindowsPowerShell\v1.0\powershell.exe'
  $info.Arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $PSCommandPath + '"'
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardInput = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $info.EnvironmentVariables['METLIFE_OD_INSTALL_DIR'] = $install
  $info.StandardOutputEncoding = New-Object System.Text.UTF8Encoding($false)
  $child = [Diagnostics.Process]::Start($info)
  $child.StandardInput.Write($rawInput)
  $child.StandardInput.Close()
  $stdout = $child.StandardOutput.ReadToEndAsync()
  $stderr = $child.StandardError.ReadToEndAsync()
  if (-not $child.WaitForExit(12000)) { $child.Kill(); throw 'The 32-bit OD helper timed out.' }
  [Console]::Write($stdout.Result)
  exit $child.ExitCode
 }
 $assembly = [Reflection.Assembly]::LoadFrom($dll)
 $version = $assembly.GetName().Version
 if ($version.Major -ne 24 -or $version.Minor -ne 3) { throw 'The installed OD assembly must be version 24.3 for this adapter.' }
 $splitType = $assembly.GetType('OpenDentBusiness.PaySplit', $true)
 $serviceType = $assembly.GetType('OpenDentBusiness.PaySplits', $true)
 $method = $serviceType.GetMethod('HashFields', [Type[]]@($splitType))
 if (-not $method) { throw 'The installed OD assembly does not expose PaySplits.HashFields.' }
 $results = @()
 foreach ($row in @($inputData.splits)) {
  if ([string]$row.patNum -notmatch '^[1-9]\d{0,17}$' -or [string]$row.amount -notmatch '^\d+\.\d{2}$' -or [string]$row.date -notmatch '^\d{4}-\d{2}-\d{2}$') { throw 'Invalid new split input.' }
  $split = [Activator]::CreateInstance($splitType)
  $splitType.GetField('PatNum').SetValue($split, [long]$row.patNum)
  $splitType.GetField('SplitAmt').SetValue($split, [double]::Parse($row.amount, [Globalization.CultureInfo]::InvariantCulture))
  $splitType.GetField('DatePay').SetValue($split, [DateTime]::ParseExact($row.date, 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture))
  $hash = [string]$method.Invoke($null, @($split))
  # OD catches native library failures and returns the exception type as text.
  # Never accept that text as a valid hash, or use a blank fallback.
  if ([string]::IsNullOrWhiteSpace($hash) -or $hash.Length -lt 16 -or $hash -match 'Exception$' -or $hash -match '\s') { throw 'OD did not return a valid SecurityHash for the new split. Check CDT.dll and its dependencies on SERVER.' }
  $results += $hash
 }
 @{ok=$true;version=$version.ToString();culture=[Globalization.CultureInfo]::CurrentCulture.Name;hashes=@($results)} | ConvertTo-Json -Compress -Depth 5
 exit 0
} catch {
 @{ok=$false;error=$_.Exception.Message} | ConvertTo-Json -Compress
 exit 1
}
