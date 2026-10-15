# OD UIA adapter: patient selection, new Payment, allocation, optional explicit Save. No merchant charge actions.
$ErrorActionPreference='Stop'
[Console]::InputEncoding=New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
$request=[Console]::In.ReadToEnd()|ConvertFrom-Json
. (Join-Path $PSScriptRoot 'uia-client.ps1')
try{InitializeOdUia}catch{
 $startupError=$_.Exception.Message
 $diagnosticFolder=$null
 try{
  if($request.diagnosticDir){
   $diagnosticFolder=Join-Path ([string]$request.diagnosticDir) ('startup-'+[Guid]::NewGuid().ToString('N'))
   [void][IO.Directory]::CreateDirectory($diagnosticFolder)
   @{error=$startupError;provider=$script:odProvider}|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $diagnosticFolder 'window-discovery.json') -Encoding UTF8
  }
 }catch{}
 @{ok=$false;error=$startupError;provider=$script:odProvider;diagnosticFolder=$diagnosticFolder;saveInvoked=$false}|ConvertTo-Json -Depth 5 -Compress
 exit 1
}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
. (Join-Path $PSScriptRoot 'native-api.ps1')try{[void][OdNative]::SetThreadDpiAwarenessContext([IntPtr](-4))}catch{}
$AE=[System.Windows.Automation.AutomationElement]
$TS=[System.Windows.Automation.TreeScope]
$TC=[System.Windows.Automation.Condition]::TrueCondition
function Elements($w){@($w.FindAll($TS::Descendants,$TC))}
function ById($w,[string]$id){
 $a=@(Elements $w|Where-Object{$_.Current.AutomationId -ceq $id -and -not $_.Current.IsOffscreen})
 if($a.Count -ne 1){throw "Control not unique: $id"};return $a[0]
}
function Modals($main){@(Elements $main|Where-Object{$_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Window -and -not $_.Current.IsOffscreen})}
. (Join-Path $PSScriptRoot 'window-actions.ps1')
function ReadValue($e){
 try{$value=[string]$e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value}catch{
  $value=[string]$e.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern).DocumentRange.GetText(-1)
 }
 if($e.Current.AutomationId -ceq 'textNote'){return $value.TrimEnd([char[]]"`r`n").Replace("`r`n","`n")}
 return $value
}
function SetValue($w,[string]$id,[string]$value,$main){
 AssertFocus $main;$e=ById $w $id
 try{$e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue($value)}catch{
  if($id -cne 'textNote' -or $w.Current.AutomationId -cne 'FormPayment'){throw}
  [UIntPtr]$response=[UIntPtr]::Zero
  $sent=[OdNative]::SendMessageTimeout([IntPtr]$e.Current.NativeWindowHandle,12,[IntPtr]::Zero,$value,2,3000,[ref]$response)
  if($sent -eq [IntPtr]::Zero){throw 'Could not set Payment Note'}
 }
 if($id -ceq 'textNote'){$value=$value.TrimEnd([char[]]"`r`n").Replace("`r`n","`n")}
 if((ReadValue $e) -cne $value){throw "Readback failed: $id"}
}
function WaitModal($main,[string]$id){
 for($i=0;$i -lt 40;$i++){
  $all=@(Modals $main);$a=@($all|Where-Object{$_.Current.AutomationId -ceq $id})
  if($a.Count -eq 1){return $a[0]}
  if($all.Count -gt 0 -and -not ($id -eq 'FormPayment' -and $all.Count -eq 1 -and $all[0].Current.AutomationId -eq 'InputBox')){throw 'Unexpected modal window. Inspect OD before retrying.'}
  Start-Sleep -Milliseconds 125
 };throw "Popup not found: $id"
}
function CloseWindow($w){$w.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern).Close()}
. (Join-Path $PSScriptRoot 'workflow.ps1')
. (Join-Path $PSScriptRoot 'window-discovery.ps1')
$opened=$null
$saveInvoked=$false
$paymentHandle=$null
$automationStarted=$false
try{
 $main=FindOdMain
 if([OdNative]::IsIconic([IntPtr]$main.Current.NativeWindowHandle)){
  [void][OdNative]::ShowWindow([IntPtr]$main.Current.NativeWindowHandle,9)
  Start-Sleep -Milliseconds 250
 }
 $pat=[regex]::Match($main.Current.Name,'-\s*(\d+)\s*$').Groups[1].Value
 if($request.action -eq 'inspect'){
  @{ok=$true;patNum=$pat;title=$main.Current.Name;modals=@(Modals $main|ForEach-Object{$_.Current.Name});accountVisible=(@(Elements $main|Where-Object{$_.Current.AutomationId -ceq 'ControlAccount' -and -not $_.Current.IsOffscreen}).Count -eq 1)}|ConvertTo-Json -Depth 5 -Compress
  exit 0
 }
 . (Join-Path $PSScriptRoot 'ocr.ps1')
 if($request.action -notin @('fill-preview','save-preview','close-preview')){throw 'Unknown action'}
 if($request.action -eq 'close-preview' -and $pat -cne [string]$request.draft.patNum){throw 'Selected OD patient does not match verified PatNum.'}
 if($request.action -eq 'close-preview'){
  $modals=@(Modals $main)
  if($modals.Count -ne 1 -or $modals[0].Current.AutomationId -cne 'FormPayment'){throw 'Expected only the preview Payment window.'}
  $w=$modals[0]
  if([string]$w.Current.NativeWindowHandle -cne [string]$request.draft.windowHandle){throw 'Preview window identity changed; inspect OD manually.'}
  if((ReadValue (ById $w 'textAmount')) -cne [string]$request.draft.amount -or (ReadValue (ById $w 'textNote')) -cne ([string]$request.draft.note).TrimEnd([char[]]"`r`n").Replace("`r`n","`n")){throw 'Preview was edited or replaced; close it manually.'}
  CloseWindow $w
  Start-Sleep -Milliseconds 300
  if(@(Modals $main).Count -gt 0){throw 'OD still has a dialog; inspect before continuing.'}
  @{ok=$true;closed=$true;saveInvoked=$false}|ConvertTo-Json -Compress;exit 0
 }
 if($request.action -eq 'save-preview'){
  if($request.draft.mode -cne 'save-authorized' -or -not $request.operationId){throw 'Missing operation authorization'}
  if($pat -cne [string]$request.draft.patNum){throw 'Wrong patient before Save'}
  $payment=WaitOnly $main 'FormPayment'
  if([string]$payment.Current.NativeWindowHandle -cne [string]$request.draft.windowHandle){throw 'Payment window identity changed'}
  $paymentHandle=[string]$payment.Current.NativeWindowHandle
  [void][OdNative]::SetForegroundWindow([IntPtr]$payment.Current.NativeWindowHandle)
  AssertFocus $main
  VerifySplits $payment $request.draft $main
  $payment=WaitOnly $main 'FormPayment';AssertPayment $payment $request.draft $main
  $saveInvoked=$true
  Click (ById $payment 'butSave') $main
  for($i=0;$i -lt 50;$i++){if(@(Modals $main).Count -eq 0){break};Start-Sleep -Milliseconds 100}
  if(@(Modals $main).Count -gt 0){throw 'OD showed a dialog after Save; check SERVER result before retry'}
  @{ok=$true;saveInvoked=$true;uiClosed=$true}|ConvertTo-Json -Compress
  exit 0
 }
 if(@(Modals $main).Count -ne 0 -or -not $main.Current.IsEnabled){throw 'Close existing dialogs before creating a preview.'}
 if($request.draft.mode -notin @('preview-only','save-authorized') -or [string]$request.draft.amount -notmatch '^\d+\.\d{2}$'){throw 'Invalid preview payload'}
 [void][OdNative]::SetForegroundWindow([IntPtr]$main.Current.NativeWindowHandle)
 Start-Sleep -Milliseconds 200;AssertFocus $main
 $automationStarted=$true
 EnsurePatient $main $request.draft
 $pat=[regex]::Match($main.Current.Name,'-\s*(\d+)\s*$').Groups[1].Value
 $visibleAccount=@(Elements $main|Where-Object{$_.Current.AutomationId -ceq 'ControlAccount' -and -not $_.Current.IsOffscreen})
 if($visibleAccount.Count -eq 0){
  $mr=$main.Current.BoundingRectangle
  $rail=[System.Drawing.Bitmap]::new([int][Math]::Min(100,$mr.Width),[int][Math]::Min(650,$mr.Height))
  $rg=[System.Drawing.Graphics]::FromImage($rail);$point=$null
  try{
   $rg.CopyFromScreen([int]$mr.Left,[int]$mr.Top,0,0,$rail.Size)
   foreach($name in @('account-r5-family-state.png','account-r5-account-state.png')){
    $tpl=[System.Drawing.Bitmap]::new((Join-Path $PSScriptRoot $name))
    try{$point=[OdNative]::Locate($rail,$tpl);break}catch{}finally{$tpl.Dispose()}
   }
  }finally{$rg.Dispose();$rail.Dispose()}
  if($null -eq $point){throw 'Account navigation image not recognized; no click was made.'}
  AssertFocus $main
  [void][OdNative]::SetCursorPos([int]$mr.Left+$point.X,[int]$mr.Top+$point.Y)
  [OdNative]::mouse_event(2,0,0,0,[UIntPtr]::Zero);[OdNative]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
  Start-Sleep -Milliseconds 350
 }
 $account=ById $main 'ControlAccount'
 # Payment toolbar is owner-drawn. Search only its visible account toolbar rectangle.
 $toolbar=ById $account 'ToolBarMain';$r=$toolbar.Current.BoundingRectangle
 $bitmap=[System.Drawing.Bitmap]::new([int]$r.Width,[int]$r.Height)
 $g=[System.Drawing.Graphics]::FromImage($bitmap)
 try{
  $g.CopyFromScreen([int]$r.Left,[int]$r.Top,0,0,$bitmap.Size)
  $template=[System.Drawing.Bitmap]::new((Join-Path $PSScriptRoot 'new-payment-r5.png'))
  try{$p=[OdNative]::Locate($bitmap,$template)}finally{$template.Dispose()}
 }finally{$g.Dispose();$bitmap.Dispose()}
 AssertFocus $main
 [void][OdNative]::SetCursorPos([int]$r.Left+$p.X,[int]$r.Top+$p.Y)
 [OdNative]::mouse_event(2,0,0,0,[UIntPtr]::Zero);[OdNative]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
 $prompt=WaitModal $main 'InputBox';$opened=$prompt
 $edits=@(Elements $prompt|Where-Object{$_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Edit -and -not $_.Current.IsOffscreen})
 if($edits.Count -ne 1){throw 'Amount input is not unique'}
 $edits[0].GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue([string]$request.draft.amount)
 if((ReadValue $edits[0]) -cne [string]$request.draft.amount){throw 'Amount readback failed'}
 Click (ById $prompt 'butOK') $main
 $opened=$null
 $payment=WaitModal $main 'FormPayment';$opened=$payment;$paymentHandle=[string]$payment.Current.NativeWindowHandle
 if((ReadValue (ById $payment 'textAmount')) -cne [string]$request.draft.amount){throw 'Payment amount mismatch'}
 if((ReadValue (ById $payment 'textCheckNum')).Length -gt 0 -or (ReadValue (ById $payment 'textNote')).Length -gt 0){throw 'Payment is not a blank new draft'}
 $date=[DateTime]::ParseExact([string]$request.draft.date,'yyyy-MM-dd',[Globalization.CultureInfo]::InvariantCulture).ToString('MM-dd-yyyy')
 SetValue $payment 'textDate' $date $main
 SetValue $payment 'textCheckNum' ([string]$request.draft.checkNum) $main
 SetValue $payment 'textNote' ([string]$request.draft.note) $main
 SetListExact (ById $payment 'listPayType') ([string]$request.draft.paymentType) $main
 BuildSplits $payment $request.draft $main
 $payment=WaitOnly $main 'FormPayment'
 AssertPayment $payment $request.draft $main
 $opened=$null
 @{ok=$true;patNum=$pat;previewOpen=$true;windowHandle=$paymentHandle;saveInvoked=$false;amount=[string]$request.draft.amount;paymentTypeApplied=$true;splitsApplied=$true;requiresReview=@()}|ConvertTo-Json -Depth 4 -Compress
}catch{
 $message=$_.Exception.Message
 $diagnosticFolder=$null
 try{
  if($request.diagnosticDir){
   $diagnosticFolder=Join-Path ([string]$request.diagnosticDir) ([DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')+'-'+[Guid]::NewGuid().ToString('N'))
   [void][IO.Directory]::CreateDirectory($diagnosticFolder)
   @{error=$message;provider=$script:odProvider;discovery=$script:odDiscovery}|ConvertTo-Json -Depth 7|Set-Content -LiteralPath (Join-Path $diagnosticFolder 'window-discovery.json') -Encoding UTF8
  }
  if($diagnosticFolder -and $main){
   $nodes=@(Elements $main|ForEach-Object{@{id=$_.Current.AutomationId;name=$_.Current.Name;type=$_.Current.ControlType.ProgrammaticName;enabled=$_.Current.IsEnabled;offscreen=$_.Current.IsOffscreen;rect=$_.Current.BoundingRectangle.ToString()}})
   @{error=$message;saveInvoked=$saveInvoked;title=$main.Current.Name;nodes=$nodes}|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $diagnosticFolder 'ui.json') -Encoding UTF8
   $rect=$main.Current.BoundingRectangle
   $image=[Drawing.Bitmap]::new([int]$rect.Width,[int]$rect.Height);$graphics=[Drawing.Graphics]::FromImage($image)
   try{$graphics.CopyFromScreen([int]$rect.Left,[int]$rect.Top,0,0,$image.Size);$image.Save((Join-Path $diagnosticFolder 'od.png'),[Drawing.Imaging.ImageFormat]::Png)}finally{$graphics.Dispose();$image.Dispose()}
  }
 }catch{}
 if(-not $saveInvoked -and $automationStarted){
  for($i=0;$i -lt 5;$i++){
   $enabled=@(Modals $main|Where-Object{$_.Current.IsEnabled})
   if($enabled.Count -ne 1 -or $enabled[0].Current.AutomationId -notin @('FormPatientSelect','InputBox','FormPayment','FormPaySplitEdit','FormProcSelect')){break}
   try{CloseWindow $enabled[0]}catch{break};Start-Sleep -Milliseconds 100
  }
 }elseif(-not $saveInvoked -and $null -ne $opened){try{CloseWindow $opened}catch{}}

 @{ok=$false;error=$message;saveInvoked=$saveInvoked;windowHandle=$paymentHandle;diagnosticFolder=$diagnosticFolder}|ConvertTo-Json -Compress;exit 1
}
