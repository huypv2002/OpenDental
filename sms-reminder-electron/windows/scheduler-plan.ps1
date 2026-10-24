# Pure task definitions, shared by the Windows installer and source parity checks.
function Get-LukSmsTaskPlan($Config,[string]$Runtime,[string]$RuntimeConfig,[string]$AppDir) {
  $prefix='LUK Dental SMS Electron'
  @{
    name="$prefix - Enable Auto Login";time=$Config.enableLogin;principal='SYSTEM';exe='powershell.exe';args="-NoProfile -ExecutionPolicy Bypass -File `"$Runtime`" -Mode enable-login -ConfigPath `"$RuntimeConfig`"";workingDirectory=$AppDir
  }
  @{
    name="$prefix - Daily Restart";time=$Config.restart;principal='SYSTEM';exe='shutdown.exe';args='/r /t 0';workingDirectory=$AppDir
  }
  @{
    name="$prefix - Start Monitoring";time=$Config.startTool;principal='INTERACTIVE';exe='powershell.exe';args="-NoProfile -ExecutionPolicy Bypass -File `"$Runtime`" -Mode run -ConfigPath `"$RuntimeConfig`"";workingDirectory=$AppDir
  }
  @{
    name="$prefix - Lock Screen";time=$Config.lock;principal='INTERACTIVE';exe='powershell.exe';args="-NoProfile -ExecutionPolicy Bypass -File `"$Runtime`" -Mode lock -ConfigPath `"$RuntimeConfig`"";workingDirectory=$AppDir
  }
}
