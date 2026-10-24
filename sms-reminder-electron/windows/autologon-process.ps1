# Same synchronous launch contract as the Python scheduler; never use stale LASTEXITCODE.
function ConvertTo-LukNativeArgument([AllowEmptyString()][string]$Value) {
  $escaped=[regex]::Replace($Value,'(\\*)"','$1$1\"')
  $escaped=[regex]::Replace($escaped,'(\\+)$','$1$1')
  return '"'+$escaped+'"'
}
function Invoke-LukAutologon([string]$Exe,[string]$User,[string]$Domain,[string]$Password) {
  $arguments=(ConvertTo-LukNativeArgument $User)+' '+(ConvertTo-LukNativeArgument $Domain)+' '+(ConvertTo-LukNativeArgument $Password)
  try {
    try {$process=Start-Process -FilePath $Exe -ArgumentList $arguments -Wait -PassThru -ErrorAction Stop}
    catch {throw 'Could not launch Autologon64.exe. Check the file and Windows security prompt.'}
    if ($null -eq $process -or $null -eq $process.ExitCode) {throw 'Autologon did not return an exit code. Setup stopped.'}
    if ($process.ExitCode -ne 0) {throw "Autologon returned exit code $($process.ExitCode). Scheduler tasks were not created."}
  } finally {$arguments=$null;$Password=$null}
}
