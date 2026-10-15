param([ValidateSet('x86','x64')][string]$FixtureArchitecture='x64')
$ErrorActionPreference='Stop'
$root=(Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$windows=Join-Path $root 'windows'
$out=Join-Path $env:TEMP ('metlife-uia-test-'+[Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($out)
$fixture=$null
try{
 $exe=Join-Path $out ('OpenDentalFixture'+$FixtureArchitecture+'.exe')
 $compiler=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
 & $compiler /nologo /target:winexe "/platform:$FixtureArchitecture" "/out:$exe" /r:System.Windows.Forms.dll /r:System.Drawing.dll (Join-Path $PSScriptRoot 'OpenDentalFixture.cs')
 if($LASTEXITCODE -ne 0){throw 'Fixture compilation failed'}
 . (Join-Path $windows 'uia-client.ps1')
 InitializeOdUia
 if($script:odProvider.backend -cne 'UIA3-COM'){throw 'Wrong backend'}
 $fixture=Start-Process -FilePath $exe -PassThru
 $handle=[IntPtr]::Zero
 for($i=0;$i -lt 80;$i++){
  $fixture.Refresh();$handle=$fixture.MainWindowHandle
  if($handle -ne [IntPtr]::Zero){break};Start-Sleep -Milliseconds 100
 }
 if($handle -eq [IntPtr]::Zero){throw 'Fixture did not create a native window'}
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
 (FindControl 'butPopup').GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
 $popup=$null
 for($i=0;$i -lt 40;$i++){
  $found=@($main.FindAll($TS::Descendants,[System.Windows.Automation.PropertyCondition]::new($AE::AutomationIdProperty,'FormPayment')))
  if($found.Count -eq 1){$popup=$found[0];break};Start-Sleep -Milliseconds 100
 }
 if($null -eq $popup){throw 'Nested WinForms modal not found'}
 $popup.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern).Close()
 Start-Sleep -Milliseconds 200
 # Execute the same full adapter and child PowerShell process used by Electron.
 $powershell=[Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
 $raw='{"action":"inspect"}'|& $powershell -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass -File (Join-Path $windows 'od-automation.ps1')
 if($LASTEXITCODE -ne 0){throw ('Real adapter inspection failed: '+($raw -join "`n"))}
 $inspection=($raw -join "`n")|ConvertFrom-Json
 if(-not $inspection.ok -or $inspection.patNum -cne '99' -or -not $inspection.accountVisible){throw ('Bad adapter result: '+($raw -join "`n"))}
 Write-Output "PASS UIA3 client $([IntPtr]::Size*8)-bit / WinForms $FixtureArchitecture`: native COM startup, exact form/control IDs, descendant search, Value/Text/Selection/Invoke/Window patterns and full OD adapter inspect."
}finally{
 if($fixture -and -not $fixture.HasExited){Stop-Process -Id $fixture.Id -Force}
 Remove-Item -LiteralPath $out -Recurse -Force -ErrorAction SilentlyContinue
}
