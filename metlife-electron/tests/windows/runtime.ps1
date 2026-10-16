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
 Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'fixtures/payment-type-r5.png') -Destination (Join-Path $out 'payment-type-r5.png')
 Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'fixtures/outstanding-header-r5.png') -Destination (Join-Path $out 'outstanding-header-r5.png')
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
 # Regression from the user's real OD Payment Type crop (labels only, no patient data).
 $headerBitmap=[Drawing.Bitmap]::new((Join-Path $PSScriptRoot 'fixtures/outstanding-header-r5.png'))
 try{
  # Same crop as the real OD header, with only generic column names, no patient rows.
  $headerCrop=$headerBitmap.Clone([Drawing.Rectangle]::new(0,5,$headerBitmap.Width,$headerBitmap.Height-7),$headerBitmap.PixelFormat)
  try{
   $edges=@([OdNative]::HeaderDividers($headerCrop))
   if($edges.Count -ne 9){throw ('R5 header divider count: '+($edges -join ','))}
   if([Math]::Abs($edges[4]-480) -gt 2 -or [Math]::Abs($edges[5]-518) -gt 2){throw 'R5 tooth cell borders incorrect'}
  }finally{$headerCrop.Dispose()}
 }finally{$headerBitmap.Dispose()}
 foreach($checkCase in @(@{file='show-all-checked-r5.png';state=1},@{file='show-all-unchecked-r5.png';state=0})){
  $checkImage=[Drawing.Bitmap]::new((Join-Path $PSScriptRoot ('fixtures/'+$checkCase.file)))
  try{if([OdNative]::PaintedCheckState($checkImage) -ne $checkCase.state){throw ('Real R5 checkbox state failed: '+$checkCase.file)}}finally{$checkImage.Dispose()}
 }
 $unknownCheck=[Drawing.Bitmap]::new(200,24)
 try{if([OdNative]::PaintedCheckState($unknownCheck) -ne -1){throw 'Unknown checkbox image was accepted'}}finally{$unknownCheck.Dispose()}
 $captured=[Drawing.Bitmap]::new((Join-Path $PSScriptRoot 'fixtures/payment-type-r5.png'))
 try{
  $bands=@([OdNative]::SelectionBands($captured))
  if($bands.Count -ne 1 -or $bands[0].Top -ne 112 -or $bands[0].Bottom -ne 134){throw ('Real R5 highlight segmentation failed: '+($bands|ConvertTo-Json -Compress))}
 }finally{$captured.Dispose()}
 $r5Selected=SelectedText (FindControl 'listCapturedPayType') $main 'Insurance Paid'
 Write-Output ('R5 captured highlighted label: '+$r5Selected)
 if((ListKey $r5Selected) -cne 'INSURANCE PAID'){throw ('Real R5 highlighted Payment Type OCR failed: '+$r5Selected)}
 $multiple=[Drawing.Bitmap]::new(200,100);$paint=[Drawing.Graphics]::FromImage($multiple)
 try{
  $paint.Clear([Drawing.Color]::White)
  $brush=[Drawing.SolidBrush]::new([Drawing.Color]::FromArgb(175,195,215))
  try{$paint.FillRectangle($brush,1,15,198,20);$paint.FillRectangle($brush,1,60,198,20)}finally{$brush.Dispose()}
  if(@([OdNative]::SelectionBands($multiple)).Count -ne 2){throw 'Two genuinely separate selections were merged'}
 }finally{$paint.Dispose();$multiple.Dispose()}
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
 Write-Output ('ACCOUNT ROWS: '+(@(AccountRows @(OcrRows (FindControl 'gridAccount') $main))|ConvertTo-Json -Depth 5 -Compress))
 SelectAccountProcedures $account $draft $main
 Start-Sleep -Milliseconds 100
 $selection=(FindControl 'textAccountSelection').GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value
 if($selection -cne '0,2'){throw ('Wrong real Account selection: '+$selection)}
 $draft.splits[1].tooth='13'
 SelectAccountProcedures $account $draft $main
 Start-Sleep -Milliseconds 100
 $selection=(FindControl 'textAccountSelection').GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value
 if($selection -cne '0,1'){throw ('Wrong adjacent Account selection: '+$selection)}
 # Execute the actual Outstanding/Add Partials workflow on real painted controls and modals.
 . (Join-Path $windows 'payment-allocation.ps1')
 $realHeader=ChargeHeader @(OcrRows (FindControl 'headerCapturedCharges') $main)
 foreach($caption in @('Date','Patient','Prov','Code','Type')){
  if(@($realHeader.words|Where-Object{$_.text -ieq $caption}).Count -ne 1){throw ('Real R5 charge header OCR failed: '+$caption+' / '+($realHeader|ConvertTo-Json -Depth 5 -Compress))}
 }

 function Modals($scope){@(Elements $scope|Where-Object{$_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Window -and -not $_.Current.IsOffscreen})}
 function ReadValue($element){return [string]$element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value}
 function SetValue($scope,$id,$text,$owner){$field=ById $scope $id;$field.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue($text);if((ReadValue $field) -cne $text){throw 'Amount readback failed'}}
 $allocationDraft=[pscustomobject]@{patNum='99';patientName='TEST, RYAN';splitPatientName='TEST, RYAN';amount='236.40';date='2026-09-24';checkNum='SYNTHETIC';note='group number :TEST';paymentType='Insurance Paid';splits=@(
  [pscustomobject]@{code='D2392';date='2026-09-20';tooth='14';providerAbbr='DOC';description='Synthetic service';amountCents=15000},
  [pscustomobject]@{code='D0120';date='2026-09-20';tooth='';providerAbbr='DOC';description='Synthetic service';amountCents=8640}
 )}
 foreach($case in @('normal','warning','compact')){
  $warningCase=$case -ceq 'warning'
  $button=if($case -ceq 'compact'){'butAllocationCompact'}elseif($warningCase){'butAllocationWarning'}else{'butAllocation'}
  Click (FindControl $button) $main
  $payment=WaitOnly $main 'FormPayment'
  EnsureShowAllCharges $payment $main
  EnsureShowAllCharges $payment $main
  $wantedClicks=if($warningCase){'0'}else{'1'}
  if((ReadValue (ById $payment 'textShowAllClicks')) -cne $wantedClicks){throw 'Show All Charges was toggled off or clicked twice'}
  $stopped=$false
  try{AllocatePayment $payment $allocationDraft $main}catch{
   if(-not $warningCase -or $_.Exception.Message -notlike '*Unexpected dialog*Overpaid Charge Warning*'){Write-Output ('OUTSTANDING SYNTHETIC READ: '+($script:odOutstandingRead|ConvertTo-Json -Depth 12 -Compress));throw}
   $stopped=$true
  }
  if($warningCase){
   if($script:odChargeGeometry.method -cne 'verified-ocr-headers'){throw 'Missing-dividers fallback was not exercised'}
   if(-not $stopped){throw 'Overpaid Charge Warning was accepted automatically'}
   $warnings=@(Modals $main|Where-Object{$_.Current.Name -ceq 'Overpaid Charge Warning'})
   if($warnings.Count -ne 1){throw 'Warning was not preserved on screen'}
   if((ReadValue (ById $payment 'textAllocationState')) -cne '1|1|0'){throw 'Workflow continued or saved after warning'}
   # Test teardown only. Production leaves the warning and Payment untouched.
   $warnings[0].GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern).Close()
   Start-Sleep -Milliseconds 200
  }else{
   if((ReadValue (ById $payment 'textSplitTotal')) -cne '236.40'){throw 'Wrong allocation total'}
   if($case -ceq 'compact'){
    if($script:odChargeGeometry.method -ceq 'verified-ocr-headers'){throw 'Real-size R5 header still lost physical dividers'}
    $cellRows=@(ReadChargeCells (ById $payment 'gridCharges') $main $true)
    if(@(MatchChargeRows $cellRows $allocationDraft).Count -ne 2){throw 'Isolated small R5 column OCR did not match exact rows'}
   }
   if((ReadValue (ById $payment 'textAllocationState')) -cne '1|2|0'){throw 'Wrong clear/prompt/save counts'}
   function CloseWindow($window){$window.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern).Close()}
   VerifySplits $payment $allocationDraft $main
   $payment=WaitOnly $main 'FormPayment'
   AssertPayment $payment $allocationDraft $main
   Write-Output ('Full allocation/readback passed: '+$case+'; Payment remains open, Save count zero')
   $readPath=Join-Path $out 'current-outstanding-read.json'
   & node (Join-Path $root 'scripts/diagnose-outstanding.cjs') $readPath
   if($LASTEXITCODE -ne 0){throw 'Read-only diagnostic command failed'}
   $read=Get-Content -Raw -LiteralPath $readPath|ConvertFrom-Json
   if(-not $read.readOnly -or $read.saveInvoked -or $read.rawLines.Count -eq 0 -or $read.parsedRows.Count -ne 4 -or $read.parseError){throw 'Diagnostic did not capture current raw/parsed Outstanding rows'}
   $payment=WaitOnly $main 'FormPayment'
   if((ReadValue (ById $payment 'textAllocationState')) -cne '1|2|0' -or (ReadValue (ById $payment 'textSplitTotal')) -cne '236.40' -or (ReadValue (ById $payment 'textShowAllClicks')) -cne '1'){throw 'Read-only diagnostic changed the draft'}

  }
  $payment.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern).Close()
  Start-Sleep -Milliseconds 200
 }
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
 Write-Output "PASS UIA3 client $([IntPtr]::Size*8)-bit / WinForms $FixtureArchitecture`: native COM startup, exact form/control IDs, descendant search, Value/Text/Selection/Invoke/Window patterns, production OCR selection of offscreen painted list items in both directions, missing-item refusal, exact Account Ctrl-selection, family combo popup, clearing draft splits, Outstanding Ctrl-selection, per-procedure Add Partials with exact total/no Save, preserved overpaid warning, modal click and full Node-to-PowerShell OD adapter inspect, two-window refusal and saved diagnostics."
}catch{
 if($fixture -and -not $fixture.HasExited){
  try{
   $frame=[System.Windows.Forms.SystemInformation]::VirtualScreen
   $image=[Drawing.Bitmap]::new([int]$frame.Width,[int]$frame.Height);$graphics=[Drawing.Graphics]::FromImage($image)
   try{$graphics.CopyFromScreen([int]$frame.Left,[int]$frame.Top,0,0,$image.Size);$image.Save((Join-Path $root 'fixture-failure.png'),[Drawing.Imaging.ImageFormat]::Png)}finally{$graphics.Dispose();$image.Dispose()}
  }catch{}
 }
 throw
}finally{
 if($second -and -not $second.HasExited){Stop-Process -Id $second.Id -Force}
 if($fixture -and -not $fixture.HasExited){Stop-Process -Id $fixture.Id -Force}
 Remove-Item -LiteralPath $out -Recurse -Force -ErrorAction SilentlyContinue
}
