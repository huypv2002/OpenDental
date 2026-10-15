param([ValidateSet('x86','x64')][string]$FixtureArchitecture='x64')
$ErrorActionPreference='Stop'
$root=(Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$windows=Join-Path $root 'windows'
$out=Join-Path $env:TEMP ('metlife-uia-test-'+[Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($out)
$fixture=$null
$second=$null
try{
 $exe=Join-Path $out ('OpenDentalFixture'+$FixtureArchitecture+'.exe')
 $compiler=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
 & $compiler /nologo /target:winexe "/platform:$FixtureArchitecture" "/out:$exe" /r:System.Windows.Forms.dll /r:System.Drawing.dll (Join-Path $PSScriptRoot 'OpenDentalFixture.cs')
 if($LASTEXITCODE -ne 0){throw 'Fixture compilation failed'}
 . (Join-Path $windows 'uia-client.ps1')
 InitializeOdUia
 Add-Type -AssemblyName System.Drawing
 Add-Type -AssemblyName System.Windows.Forms
 . (Join-Path $windows 'native-api.ps1')
 . (Join-Path $windows 'window-actions.ps1')
 if($script:odProvider.backend -cne 'UIA3-COM'){throw 'Wrong backend'}
 [IO.File]::WriteAllText($exe+'.config','<configuration><startup><supportedRuntime version="v4.0" sku=".NETFramework,Version=v4.8" /></startup></configuration>')
 $fixture=Start-Process -FilePath $exe -PassThru
 $handle=[IntPtr]::Zero
 for($i=0;$i -lt 200;$i++){
  $fixture.Refresh();$handle=$fixture.MainWindowHandle
  if($fixture.HasExited){throw ('Fixture exited before opening its window, exit code '+$fixture.ExitCode)}
  if($handle -eq [IntPtr]::Zero){
   foreach($candidateHandle in [OdNative]::TopWindows()){
    [uint32]$owner=0;[void][OdNative]::GetWindowThreadProcessId($candidateHandle,[ref]$owner)
    if($owner -eq $fixture.Id -and [OdNative]::IsWindowVisible($candidateHandle)){
     $candidate=[System.Windows.Automation.AutomationElement]::FromHandle($candidateHandle)
     if($candidate.Current.AutomationId -ceq 'FormOpenDental'){$handle=$candidateHandle;break}
    }
   }
  }
  if($handle -ne [IntPtr]::Zero){break};Start-Sleep -Milliseconds 100
 }
 if($handle -eq [IntPtr]::Zero){$details=if(Test-Path ($exe+'.error.txt')){Get-Content -Raw ($exe+'.error.txt')}else{'No fixture exception log'};throw ('Fixture did not create a native window: '+$details)}
 $AE=[System.Windows.Automation.AutomationElement]
 $TS=[System.Windows.Automation.TreeScope]
 $TC=[System.Windows.Automation.Condition]::TrueCondition
 $main=$AE::FromHandle($handle)
 if($main.Current.AutomationId -cne 'FormOpenDental'){throw ('Main ID mismatch: '+$main.Current.AutomationId)}
 function FindControl([string]$id){
  $found=@($main.FindAll($TS::Descendants,[System.Windows.Automation.PropertyCondition]::new($AE::AutomationIdProperty,$id)))
  if($found.Count -ne 1){throw ('Fixture control not unique: '+$id)}
  return $found[0]
 }
 $account=FindControl 'ControlAccount'
 if($account.Current.ProcessId -ne $fixture.Id){throw 'Wrong fixture process'}
 $amount=FindControl 'textAmount';$value=$amount.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
 if($value.Current.Value -cne '35.00'){throw 'Value read failed'}
 $value.SetValue('42.50');if($value.Current.Value -cne '42.50'){throw 'Value write/readback failed'}
 $note=FindControl 'textNote'
 $text=$note.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern).DocumentRange.GetText(-1)
 if($text -notlike '*Synthetic fixture only*'){throw 'TextPattern read failed'}
 $list=FindControl 'listPayType'
 $items=@($list.FindAll($TS::Descendants,$TC)|Where-Object{$_.Current.Name -ceq 'Insurance Paid'})
 if($items.Count -ne 1){throw 'Selection item not found'}
 $pattern=$null
 if(-not $items[0].TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern,[ref]$pattern)){throw 'SelectionItemPattern unavailable'}
 $pattern.Select();if(-not $pattern.Current.IsSelected){throw 'Selection verification failed'}
 (FindControl 'butAction').GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
 if($value.Current.Value -cne '77.00'){throw 'Nonmodal Invoke/readback failed'}
 [void][OdNative]::SetForegroundWindow($handle)
 Start-Sleep -Milliseconds 200
 # Use the real OCR and exact production list selector on an OD-style painted control.
 . (Join-Path $windows 'ocr.ps1')
 . (Join-Path $windows 'workflow.ps1')
 function Elements($element){@($element.FindAll($TS::Descendants,$TC))}
 $painted=FindControl 'listCustomPayType'
 if(@(Elements $painted|Where-Object{$_.Current.ControlType -eq [System.Windows.Automation.ControlType]::ListItem}).Count -ne 0){throw 'Painted fixture unexpectedly exposes standard ListItems'}
 SetListExact $painted 'Insurance Paid' $main
 Start-Sleep -Milliseconds 100
 $readSelection=(FindControl 'textPaintedSelection').GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
 if($readSelection.Current.Value -cne 'Insurance paid'){throw 'Painted list did not select the offscreen exact target'}
 SetListExact $painted 'Credit Card' $main
 Start-Sleep -Milliseconds 100
 if($readSelection.Current.Value -cne 'Credit Card'){throw 'Painted list did not scan upward to target above viewport'}
 $missing=$false
 try{SetListExact $painted 'Absent Payment Type' $main}catch{
  if($_.Exception.Message -notlike '*after scanning down and up*'){throw}
  $missing=$true
 }
 if(-not $missing){throw 'Missing list label was accepted'}
 # Match and Ctrl-select actual painted Account rows before any Payment is opened.
 . (Join-Path $windows 'account-selection.ps1')
 function ById($scope,[string]$id){
  $found=@($scope.FindAll($TS::Descendants,[System.Windows.Automation.PropertyCondition]::new($AE::AutomationIdProperty,$id)))
  if($found.Count -ne 1){throw ('Test control not unique: '+$id)};return $found[0]
 }
 $draft=[pscustomobject]@{patNum='99';patientName='TEST, RYAN';splits=@(
  [pscustomobject]@{code='D0120';date='2026-09-20';tooth='';providerAbbr='DOC'},
  [pscustomobject]@{code='D2392';date='2026-09-20';tooth='14';providerAbbr='DOC'}
 )}
 SelectAccountProcedures $account $draft $main
 Start-Sleep -Milliseconds 100
 $selection=(FindControl 'textAccountSelection').GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value
 if($selection -cne '0,2'){throw ('Wrong real Account selection: '+$selection)}
 # Exercise the production click helper: a modal-opening Invoke can block the caller.
 Click (FindControl 'butPopup') $main
 $popup=$null
 for($i=0;$i -lt 40;$i++){
  $found=@($main.FindAll($TS::Descendants,[System.Windows.Automation.PropertyCondition]::new($AE::AutomationIdProperty,'FormPayment')))
  if($found.Count -eq 1){$popup=$found[0];break};Start-Sleep -Milliseconds 100
 }
 if($null -eq $popup){throw 'Nested WinForms modal not found'}
 $popup.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern).Close()
 Start-Sleep -Milliseconds 200
 # Execute the same full adapter and child PowerShell process used by Electron.
 $invoke=Join-Path $PSScriptRoot 'invoke-adapter.cjs'
 $raw=& node $invoke $out
 if($LASTEXITCODE -ne 0){throw ('Real adapter inspection failed: '+($raw -join "`n"))}
 $inspection=($raw -join "`n")|ConvertFrom-Json
 if(-not $inspection.ok -or $inspection.patNum -cne '99' -or -not $inspection.accountVisible){throw ('Bad adapter result: '+($raw -join "`n"))}
 $second=Start-Process -FilePath $exe -PassThru
 for($i=0;$i -lt 80;$i++){
  $second.Refresh();if($second.MainWindowHandle -ne [IntPtr]::Zero){break};Start-Sleep -Milliseconds 100
 }
 if($second.MainWindowHandle -eq [IntPtr]::Zero){throw 'Second fixture did not start'}
 $raw=& node $invoke $out
 if($LASTEXITCODE -ne 1){throw 'Adapter did not refuse two OD main windows'}
 $ambiguous=($raw -join "`n")|ConvertFrom-Json
 if($ambiguous.ok -or $ambiguous.error -notlike '*2*' -or -not (Test-Path (Join-Path $ambiguous.diagnosticFolder 'window-discovery.json'))){throw ('Bad ambiguity/diagnostics response: '+($raw -join "`n"))}
 Write-Output "PASS UIA3 client $([IntPtr]::Size*8)-bit / WinForms $FixtureArchitecture`: native COM startup, exact form/control IDs, descendant search, Value/Text/Selection/Invoke/Window patterns, production OCR selection of offscreen painted list items in both directions, missing-item refusal, exact Account Ctrl-selection of nonadjacent procedures, modal click and full Node-to-PowerShell OD adapter inspect, two-window refusal and saved diagnostics."
}finally{
 if($second -and -not $second.HasExited){Stop-Process -Id $second.Id -Force}
 if($fixture -and -not $fixture.HasExited){Stop-Process -Id $fixture.Id -Force}
 Remove-Item -LiteralPath $out -Recurse -Force -ErrorAction SilentlyContinue
}
