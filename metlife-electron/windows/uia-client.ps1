# UIA3 COM client; do not load the legacy managed UIAutomationClient/Types assemblies.
function InitializeOdUia {
 $script:odProvider=@{backend='UIA3-COM';registered=$false;assembly=$null;error=$null;clientBits=([IntPtr]::Size*8)}
 try{
  Add-Type -AssemblyName WindowsBase
  $dir=Join-Path $PSScriptRoot 'uia3'
  $manifest=Get-Content -Raw -LiteralPath (Join-Path $dir 'manifest.json')|ConvertFrom-Json
  foreach($file in $manifest.files.PSObject.Properties){
   $filePath=Join-Path $dir $file.Name
   if((Get-FileHash -LiteralPath $filePath -Algorithm SHA256).Hash -ine $file.Value){throw ('UIA library checksum mismatch: '+$file.Name)}
  }
  [void][Reflection.Assembly]::LoadFrom((Join-Path $dir 'Interop.UIAutomationClient.dll'))
  $assembly=[Reflection.Assembly]::LoadFrom((Join-Path $dir 'UIAComWrapper.dll'))
  $actual=[System.Windows.Automation.AutomationElement].Assembly
  if($actual.FullName -cne $assembly.FullName){throw ('Unexpected UIA assembly: '+$actual.FullName)}
  # Force native COM creation here, rather than reporting a successful DLL load only.
  $desktop=[System.Windows.Automation.AutomationElement]::RootElement
  if($null -eq $desktop){throw 'UIA3 returned no desktop'}
  $script:odProvider.registered=$true
  $script:odProvider.assembly=$actual.FullName
 }catch{
  $script:odProvider.error=$_.Exception.Message
  throw ('Không khởi tạo được UIA3 COM: '+$script:odProvider.error)
 }
}
