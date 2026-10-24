# Native Windows UI Automation adapter. One JSON request on stdin, JSON-lines on stdout.
# Patient data is never interpolated into executable PowerShell or command arguments.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class LukNative {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int command);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags,uint dx,uint dy,uint data,UIntPtr info);
}
'@
# UIA rectangles are physical pixels; coordinate fallbacks must use the same space.
try {[void][LukNative]::SetThreadDpiAwarenessContext([IntPtr](-4))} catch {[void][LukNative]::SetProcessDPIAware()}
. (Join-Path $PSScriptRoot 'phone-link-policy.ps1')
$AE = [System.Windows.Automation.AutomationElement]
$Scope = [System.Windows.Automation.TreeScope]
$TrueCondition = [System.Windows.Automation.Condition]::TrueCondition
$ButtonType = [System.Windows.Automation.ControlType]::Button
$EditType = [System.Windows.Automation.ControlType]::Edit
function Trace([string]$Message) { [Console]::Out.WriteLine((@{type='trace';message=$Message} | ConvertTo-Json -Compress)) }
function Windows([string]$Pattern) {
  @($AE::RootElement.FindAll($Scope::Children,$TrueCondition) | Where-Object {
    $_.Current.Name -match $Pattern -and $_.Current.BoundingRectangle.Width -gt 260 -and $_.Current.BoundingRectangle.Height -gt 220
  } | Sort-Object @{Expression={$_.Current.BoundingRectangle.Width * $_.Current.BoundingRectangle.Height};Descending=$true})
}
function Wait-Window([string]$Pattern, [int]$Seconds=15) {
  $until = [DateTime]::UtcNow.AddSeconds($Seconds)
  do {
    $items = @(Windows $Pattern)
    if ($items.Count -gt 0) { return $items[0] }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $until)
  throw 'Could not find the application window. Keep it signed in on an unlocked desktop.'
}
function Foreground($Window) {
  $handle = [IntPtr]$Window.Current.NativeWindowHandle
  [void][LukNative]::ShowWindow($handle,9)
  [void][LukNative]::SetForegroundWindow($handle)
  try { $Window.SetFocus() } catch {}
  Start-Sleep -Milliseconds 250
  Assert-Focus $Window
}
function Assert-Focus($Window) {
  $focus = $AE::FocusedElement
  if ($null -eq $focus -or $focus.Current.ProcessId -ne $Window.Current.ProcessId) { throw 'Focus moved outside the target app. Automation stopped.' }
}
function Keys($Window,[string]$Keys,[int]$Delay=180) {
  Assert-Focus $Window
  [System.Windows.Forms.SendKeys]::SendWait($Keys)
  Start-Sleep -Milliseconds $Delay
}
function Click-Element($Element) {
  $rect = $Element.Current.BoundingRectangle
  if ($rect.IsEmpty -or $rect.Width -le 0) { throw 'The target control is not visible.' }
  [void][LukNative]::SetCursorPos([int]($rect.Left + $rect.Width/2),[int]($rect.Top + $rect.Height/2))
  [LukNative]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
  [LukNative]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
  Start-Sleep -Milliseconds 160
}
function Elements($Window) { @($Window.FindAll($Scope::Descendants,$TrueCondition)) }
function Value($Element) {
  try {
    $pattern = $Element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    return [string]$pattern.Current.Value
  } catch {
    try {
      $pattern = $Element.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
      return [string]$pattern.DocumentRange.GetText(-1)
    } catch {
      try { return [string]$Element.GetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern).Current.Value } catch {return ''}
    }
  }
}
function Clipboard-Text([string]$Text) {
  for ($i=0; $i -lt 5; $i++) {
    try {
      [System.Windows.Forms.Clipboard]::SetText($Text)
      if ([System.Windows.Forms.Clipboard]::GetText() -ceq $Text) {return}
    } catch {}
    Start-Sleep -Milliseconds 180
  }
  throw 'Could not verify clipboard contents.'
}
function Paste($Window,[string]$Text,[bool]$Clear=$true) {
  if ($Clear) {Keys $Window '^a'; Keys $Window '{BACKSPACE}'}
  Clipboard-Text $Text
  Keys $Window '^v' 350
}
function In-ComposePane($Window,$Element) {
  $w=$Window.Current.BoundingRectangle;$r=$Element.Current.BoundingRectangle
  return -not $Element.Current.IsOffscreen -and $Element.Current.IsEnabled -and (($r.Left+$r.Right)/2) -ge ($w.Left+$w.Width*0.42) -and $r.Right -ge ($w.Left+$w.Width*0.50) -and (($r.Top+$r.Bottom)/2) -ge ($w.Top+$w.Height*0.60) -and $r.Bottom -ge ($w.Top+$w.Height*0.68) -and $r.Width -ge [Math]::Min(220,$w.Width*0.12)
}
function Is-MessageInput($Window,$Element) {
  if ($null -eq $Element) {return $false}
  try {
    $c=$Element.Current;$r=$c.BoundingRectangle;$w=$Window.Current.BoundingRectangle
    return Test-LukMessageInput $w $r $c.AutomationId $c.Name $c.ControlType.ProgrammaticName $c.IsOffscreen $c.IsEnabled
  } catch {return $false}
}
function Focus-MessageInput($Window,$Element) {
  # TextBox bounds include emoji/GIF/attachment controls. Prefer UIA SetFocus,
  # then click the left text area rather than the center of the entire bounds.
  try {$Element.SetFocus();Start-Sleep -Milliseconds 180} catch {}
  $focus=$AE::FocusedElement
  if (Is-MessageInput $Window $focus) {Assert-Focus $Window;return $focus}
  $r=$Element.Current.BoundingRectangle
  Assert-Focus $Window
  [void][LukNative]::SetCursorPos([int]($r.Left+[Math]::Min(80,$r.Width*0.20)),[int]($r.Top+$r.Height/2))
  [LukNative]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
  [LukNative]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
  Start-Sleep -Milliseconds 180
  $focus=$AE::FocusedElement
  if (Is-MessageInput $Window $focus) {Assert-Focus $Window;return $focus}
  return $null
}
function Compose-Controls($Window) {
  $w=$Window.Current.BoundingRectangle
  $scored=@(Elements $Window | ForEach-Object {
    try {
      $e=$_;$c=$e.Current;$r=$c.BoundingRectangle
      if (In-ComposePane $Window $e) {
        $knownInput=$c.AutomationId -eq 'InputTextBox';$score=0
        if ($knownInput -or $c.Name -notmatch '(?i)Search|New message|Recipient|Conversation|Notification|Zalo|Connected|Motorola|Battery|Mute|Calls|Photos|Tìm kiếm') {
          if ($knownInput) {$score+=280}
          if ($c.ClassName -eq 'TextBox') {$score+=40}
          if ($c.Name -match '(?i)^(Send a message|Type a message|Nhập tin nhắn|Tin nhắn)$') {$score+=120}
          if ($c.Name -match '(?i)^(Send a message|Type a message)') {$score+=100}
          if ($c.Name -match '(?i)Send a message|Type a message|Write a message|Message|Nhập tin nhắn|Tin nhắn') {$score+=80}
          if ($c.ControlType -eq $EditType) {$score+=90}
          elseif ($c.ControlType -eq [System.Windows.Automation.ControlType]::Document) {$score+=70}
          elseif ($c.ControlType -eq [System.Windows.Automation.ControlType]::Pane) {$score+=25}
          elseif ($c.ControlType -eq [System.Windows.Automation.ControlType]::Text) {$score+=15}
          if ($r.Bottom -gt ($w.Top+$w.Height*0.72)) {$score+=30}
          if ($r.Width -gt 180) {$score+=10}
          $score += [int]((($r.Left+$r.Right)/2-$w.Left)/$w.Width*15) + [int](($r.Top-$w.Top)/$w.Height*30)
          if ($score -gt 0) {[PSCustomObject]@{element=$e;score=$score;top=$r.Top}}
        }
      }
    } catch {}
  } | Sort-Object @{Expression={$_.score};Descending=$true},@{Expression={$_.top};Descending=$true})
  return @($scored | ForEach-Object {$_.element})
}
function Focus-Compose($Window) {
  Foreground $Window
  foreach ($e in @(Compose-Controls $Window | Select-Object -First 8)) {
    try {
      if(Is-MessageInput $Window $e){$focus=Focus-MessageInput $Window $e;if($null -ne $focus){return $focus}}
    } catch {}
  }
  # The original Python fallback uses coordinates relative to the Phone Link window.
  $w=$Window.Current.BoundingRectangle
  foreach ($y in @(0.84,0.87,0.89,0.92)) {
    foreach ($x in @(0.72,0.62,0.84)) {
      Assert-Focus $Window
      [void][LukNative]::SetCursorPos([int]($w.Left+$w.Width*$x),[int]($w.Top+$w.Height*$y))
      [LukNative]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
      [LukNative]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
      Start-Sleep -Milliseconds 120
      $focus=$AE::FocusedElement
      if(Is-MessageInput $Window $focus){return $focus}
    }
  }
  # Match Python's non-destructive Tab fallback; never Enter/Space during focus search.
  foreach ($key in @('{TAB}','{TAB}','{TAB}','+{TAB}','+{TAB}')) {
    Keys $Window $key 180
    $focus=$AE::FocusedElement
    if(Is-MessageInput $Window $focus){return $focus}
  }
  throw 'Could not focus the real Phone Link compose input. Capture the UI snapshot.'
}
function Is-Recipient($Window,$Element) {
  if ($null -eq $Element) {return $false}
  $c=$Element.Current;$w=$Window.Current.BoundingRectangle;$r=$c.BoundingRectangle
  return -not $c.IsOffscreen -and $c.IsEnabled -and $r.Top -lt ($w.Top+$w.Height*0.55) -and $r.Left -gt ($w.Left+$w.Width*0.25) -and $c.Name -notmatch '(?i)Search|Tìm kiếm' -and ($c.ControlType -eq $EditType -or $c.AutomationId -match '(?i)Recipient|Contact|ToTextBox')
}
function Open-PhoneLink {
  Start-Process explorer.exe 'shell:AppsFolder\Microsoft.YourPhone_8wekyb3d8bbwe!App'
  return Wait-Window '(?i)Phone Link|Your Phone|Liên kết Điện thoại' 20
}
function Close-Window($Window) {
  try {
    $pattern = $Window.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern)
    $pattern.Close()
  } catch {Trace 'Phone Link could not be closed; inspect it manually.'}
}
function Compose-Sms($Request) {
  if ([string]$Request.phone -notmatch '\d') {throw 'Missing phone number.'}
  if ([string]::IsNullOrWhiteSpace([string]$Request.message)) {throw 'The template message is empty.'}
  foreach ($old in @(Windows '(?i)Phone Link|Your Phone|Liên kết Điện thoại')) {Close-Window $old}
  Start-Sleep -Milliseconds 2000
  try {$window = Open-PhoneLink} catch {Trace 'Retrying Phone Link launch.';$window = Open-PhoneLink}
  Foreground $window
  Keys $window '{ESC}'
  $messages = @(Elements $window | Where-Object { ($_.Current.AutomationId -eq 'MessagingNodeAutomationId' -or $_.Current.Name -match '(?i)^(Messages|Tin nhắn|Mensajes)$') -and -not $_.Current.IsOffscreen })
  if ($messages.Count -gt 0) {Click-Element $messages[0];Start-Sleep -Milliseconds 350}
  # Start a fresh conversation, preserving the same sequential workflow as Python.
  $new = @(Elements $window | Where-Object { ($_.Current.AutomationId -eq 'NewMessageButton' -or $_.Current.Name -match '(?i)^(New message|New Message|Tin nhắn mới|Nuevo mensaje)$') -and -not $_.Current.IsOffscreen })
  if ($new.Count -gt 0) {Click-Element $new[0]} else {Keys $window '^n' 700}
  Start-Sleep -Milliseconds $(if($Request.fd2){1100}else{3000})
  $window = Wait-Window '(?i)Phone Link|Your Phone|Liên kết Điện thoại' 8
  Assert-Focus $window
  $recipient = $AE::FocusedElement
  if (-not (Is-Recipient $window $recipient)) {
    $wr=$window.Current.BoundingRectangle
    $recipientControls=@(Elements $window | Where-Object {
      Is-Recipient $window $_
    })
    if ($recipientControls.Count -eq 0) {throw 'New message did not focus a recipient input. Capture the UI snapshot.'}
    $recipient=$recipientControls[0];Click-Element $recipient
  }
  Paste $window ([string]$Request.phone)
  $expectedPhone = ([string]$Request.phone -replace '\D','')
  $actualPhone = (Value $recipient) -replace '\D',''
  if ($actualPhone.Length -eq 11 -and $actualPhone.StartsWith('1')) {$actualPhone=$actualPhone.Substring(1)}
  if ($actualPhone -ne $expectedPhone) {throw 'Could not verify the recipient number in Phone Link. No SMS sent.'}
  Keys $window '{ENTER}' $(if($Request.fd2){1000}else{3000})
  $window = Wait-Window '(?i)Phone Link|Your Phone|Liên kết Điện thoại' 8
  # The compose control can change after selecting a recipient. Refresh the entire UIA tree.
  $verified = $false
  for ($attempt=0; $attempt -lt 3; $attempt++) {
    $field = Focus-Compose $window
    if ($null -ne $field) {
      $field=Focus-MessageInput $window $field
      if ($null -eq $field) {throw 'Phone Link lost the compose input focus. No SMS sent.'}
      Assert-Focus $window
      Paste $window ([string]$Request.message)
      $until = [DateTime]::UtcNow.AddSeconds(3)
      do {
        $fresh = @($field) + @(Compose-Controls $window)
        foreach ($candidate in $fresh) {
          $actual = (Value $candidate).Replace("`r`n","`n").Trim()
          $expected = ([string]$Request.message).Replace("`r`n","`n").Trim()
          if ($actual -ceq $expected) {$field=$candidate;$verified=$true;break}
        }
        if (-not $verified) {Start-Sleep -Milliseconds 160}
      } while (-not $verified -and [DateTime]::UtcNow -lt $until)
    }
    if ($verified) {break}
    Start-Sleep -Milliseconds 400
    $window = Wait-Window '(?i)Phone Link|Your Phone|Liên kết Điện thoại' 8
  }
  if (-not $verified) {throw 'Could not verify the complete template in the Phone Link compose field. Draft remains open; no Send pressed.'}
  Trace 'Recipient and complete message verified in Phone Link.'
  if ($Request.mode -eq 'send') {
    # Do not consider Enter itself a delivery receipt. The app records needs-review.
    $field=Focus-MessageInput $window $field
    if ($null -eq $field) {throw 'Phone Link lost the verified compose input focus. No Send pressed.'}
    if ((Value $field).Replace("`r`n","`n").Trim() -cne ([string]$Request.message).Replace("`r`n","`n").Trim()) {throw 'The draft changed before Send. No Send pressed.'}
    Keys $window '{ENTER}' 6000
    Close-Window $window
    return @{ok=$true;mode='send';status='needs-review'}
  }
  return @{ok=$true;mode='draft';verified=$true}
}
function Open-Patient($Request) {
  $patient=$Request.patient
  if (-not $patient.FName -or -not $patient.LName -or -not $patient.Birthdate) {throw 'Open Dental lookup requires first name, last name and birthdate.'}
  $windows = @(Windows 'Open Dental')
  if ($windows.Count -eq 0) {
    $shortcuts=@('C:\ProgramData\Microsoft\Windows\Start Menu\Programs\Open Dental.lnk','C:\ProgramData\Microsoft\Windows\Start Menu\Programs\Open Dental\Open Dental.lnk',"$env:USERPROFILE\Desktop\Open Dental.lnk",'C:\Users\Public\Desktop\Open Dental.lnk')
    $shortcut=$shortcuts | Where-Object {Test-Path -LiteralPath $_} | Select-Object -First 1
    if (-not $shortcut) {throw 'Open Dental is not open and its shortcut was not found.'}
    Start-Process -FilePath $shortcut
  }
  $window=Wait-Window 'Open Dental' 20
  Foreground $window
  Keys $window '^p' 1000
  $picker=Wait-Window '(?i)Select Patient|Select a Patient' 10
  Foreground $picker
  Paste $picker ([string]$patient.LName)
  Keys $picker '{TAB}'
  Paste $picker ([string]$patient.FName)
  Keys $picker '{TAB 6}'
  if ($patient.PatNum) {Paste $picker ([string]$patient.PatNum)}
  Keys $picker '{TAB 2}'
  $birth=[DateTime]::Parse([string]$patient.Birthdate,[Globalization.CultureInfo]::InvariantCulture).ToString('MM/dd/yyyy')
  Paste $picker $birth
  Keys $picker '{ENTER}' 1000
  # Return to the patient's chart using the same final action as Python.
  $main=Wait-Window 'Open Dental' 8
  Foreground $main
  $rect=$main.Current.BoundingRectangle
  [void][LukNative]::SetCursorPos([int]($rect.Left+48),[int]($rect.Top+134))
  Assert-Focus $main
  [LukNative]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
  [LukNative]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
  return @{ok=$true;mode='view-patient'}
}
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  switch ($request.action) {
    'sms' { $result = Compose-Sms $request }
    'open-phone' { $window = Open-PhoneLink; Foreground $window; $result=@{ok=$true} }
    'view-patient' { $result = Open-Patient $request }
    'snapshot' {
      $window = Wait-Window '(?i)Phone Link|Your Phone|Liên kết Điện thoại' 5
      $items = @(Elements $window | ForEach-Object { $c=$_.Current; @{type=$c.ControlType.ProgrammaticName;id=$c.AutomationId;name=$c.Name;focused=$c.HasKeyboardFocus;focusable=$c.IsKeyboardFocusable;class=$c.ClassName;rect=$c.BoundingRectangle.ToString();offscreen=$c.IsOffscreen;enabled=$c.IsEnabled} })
      $result=@{ok=$true;windowRect=$window.Current.BoundingRectangle.ToString();elements=$items}
    }
    default {throw 'Unsupported native automation action.'}
  }
  $result | ConvertTo-Json -Depth 8 -Compress | Write-Output
  exit 0
} catch {
  @{ok=$false;error=$_.Exception.Message} | ConvertTo-Json -Compress | Write-Output
  exit 1
}
