# Pure launch planning for both source checkouts and packaged builds.
function Get-LukSmsTarget([string]$AppDir) {
  $dir=[IO.Path]::GetFullPath($AppDir).TrimEnd([char[]]@([IO.Path]::DirectorySeparatorChar,[IO.Path]::AltDirectorySeparatorChar))
  $exe=[IO.Path]::Combine($dir,'LUK Dental SMS Electron.exe')
  $packaged=[IO.File]::Exists($exe) -or [IO.File]::Exists([IO.Path]::Combine($dir,'resources/windows/scheduler.ps1'))
  if ($packaged) {
    $root=$dir;$appPath='';$scripts=[IO.Path]::Combine($dir,'resources/windows')
  } else {
    $root=if([IO.File]::Exists([IO.Path]::Combine($dir,'package.json'))){$dir}else{[IO.Directory]::GetParent($dir).FullName}
    $package=[IO.Path]::Combine($root,'package.json')
    if (-not [IO.File]::Exists($package) -or [IO.File]::ReadAllText($package) -notmatch '"name"\s*:\s*"luk-dental-sms-electron"') {throw 'Run the BAT from sms-reminder-electron/windows, or use the complete packaged folder.'}
    $appPath=$root;$exe=[IO.Path]::Combine($root,'node_modules/electron/dist/electron.exe');$scripts=[IO.Path]::Combine($root,'windows')
  }
  $autologon=[IO.Path]::Combine($dir,'Autologon64.exe')
  if (-not [IO.File]::Exists($autologon) -and [IO.File]::Exists([IO.Path]::Combine($root,'Autologon64.exe'))) {$autologon=[IO.Path]::Combine($root,'Autologon64.exe')}
  return @{exe=$exe;appPath=$appPath;workingDirectory=$root;runtimeDir=$dir;autologon=$autologon;installer=[IO.Path]::Combine($scripts,'scheduler.ps1')}
}
function Get-LukSmsRuntimeDir($Config) {
  if ($Config.runtimeDir) {return [string]$Config.runtimeDir}
  return [IO.Path]::GetDirectoryName([string]$Config.exe)
}
function Get-LukSmsLaunch($Config,[string[]]$Arguments=@()) {
  $argsList=@()
  if ($Config.appPath) {
    $value=[string]$Config.appPath
    $escaped=[regex]::Replace($value,'(\\*)"','$1$1\"')
    $escaped=[regex]::Replace($escaped,'(\\+)$','$1$1')
    $argsList+=('"'+$escaped+'"')
  }
  $argsList+=$Arguments
  $workDir=if($Config.workingDirectory){[string]$Config.workingDirectory}else{[IO.Path]::GetDirectoryName([string]$Config.exe)}
  $start=@{FilePath=[string]$Config.exe;WorkingDirectory=$workDir;PassThru=$true}
  if($argsList.Count -gt 0){$start.ArgumentList=$argsList -join ' '}
  return $start
}
