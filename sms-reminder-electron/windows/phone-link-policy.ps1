# Pure control policy, shared by the native adapter and snapshot regression checks.
function Test-LukMessageInput($WindowRect,$Rect,[string]$Id,[string]$Name,[string]$Type,[bool]$Offscreen,[bool]$Enabled) {
  if ($Offscreen -or -not $Enabled -or $Rect.Width -le 0 -or $Rect.Height -le 0) {return $false}
  $w=$WindowRect;$r=$Rect
  $inside=$r.Left -ge $w.Left -and $r.Top -ge $w.Top -and $r.Right -le ($w.Right+2) -and $r.Bottom -le ($w.Bottom+2)
  if (-not $inside) {return $false}
  # Phone Link's stable compose ID wins over localized/accessibility names.
  if ($Id -eq 'InputTextBox') {return $true}
  $inPane=(($r.Left+$r.Right)/2) -ge ($w.Left+$w.Width*0.42) -and (($r.Top+$r.Bottom)/2) -ge ($w.Top+$w.Height*0.60) -and $r.Bottom -ge ($w.Top+$w.Height*0.68) -and $r.Width -ge [Math]::Min(220,$w.Width*0.12)
  if (-not $inPane -or $Name -match '(?i)Search|New message|Recipient|Conversation|Notification|Tìm kiếm|Tin nhắn mới') {return $false}
  return $Type -eq 'ControlType.Edit' -or $Type -eq 'ControlType.Document'
}
