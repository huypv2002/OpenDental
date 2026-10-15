# Discover native OD windows by process/session, then verify their UIA form identity.
# Never choose by patient name, title substring, foreground window, or list order.
function SelectOdMain($candidates){
 $unique=@{}
 foreach($candidate in $candidates){
  if([long]$candidate.handle -gt 0 -and $candidate.id -ceq 'FormOpenDental'){
   $unique[([string]$candidate.processId+':'+[string]$candidate.handle)]=$candidate
  }
 }
 $matches=@($unique.Values)
 if($matches.Count -gt 1){throw "Tìm thấy $($matches.Count) cửa sổ Open Dental. Chỉ giữ một cửa sổ OD rồi thử lại."}
 if($matches.Count -eq 0){throw 'OD đang chạy nhưng chưa đọc được cửa sổ chính qua UI Automation. Kiểm tra desktop đã mở khóa và chạy MetLife cùng quyền với OD; xem window-discovery.json để chẩn đoán.'}
 return $matches[0].element
}
function FindOdMain {
 $session=[Diagnostics.Process]::GetCurrentProcess().SessionId
 $processes=@(Get-Process -Name 'OpenDental*' -ErrorAction SilentlyContinue|Where-Object{$_.SessionId -eq $session})
 $script:odDiscovery=@{sessionId=$session;processes=@($processes|ForEach-Object{@{id=$_.Id;name=$_.ProcessName;sessionId=$_.SessionId}});windows=@();errors=@()}
 if($processes.Count -eq 0){throw 'Không tìm thấy tiến trình Open Dental trong phiên Windows này. Mở OD trên cùng máy và cùng desktop với MetLife.'}
 $processIds=@($processes|ForEach-Object{$_.Id})
 $handles=@{}
 foreach($process in $processes){
  try{if($process.MainWindowHandle -ne [IntPtr]::Zero){$handles[[string]$process.MainWindowHandle]=$process.MainWindowHandle}}catch{}
 }
 foreach($handle in [OdNative]::TopWindows()){
  [uint32]$owner=0
  [void][OdNative]::GetWindowThreadProcessId($handle,[ref]$owner)
  if($owner -in $processIds -and [OdNative]::IsWindowVisible($handle)){$handles[[string]$handle]=$handle}
 }
 $candidates=@()
 foreach($handle in $handles.Values){
  try{
   $root=$AE::FromHandle([IntPtr]$handle)
   $info=$root.Current
   $script:odDiscovery.windows+=@{handle=[string]$handle;processId=$info.ProcessId;id=$info.AutomationId;title=$info.Name;className=$info.ClassName;frameworkId=$info.FrameworkId;offscreen=$info.IsOffscreen;minimized=[OdNative]::IsIconic([IntPtr]$handle)}
   if($info.ProcessId -notin $processIds){continue}
   $forms=@($root)
   if($info.AutomationId -cne 'FormOpenDental'){
    $condition=[System.Windows.Automation.PropertyCondition]::new($AE::AutomationIdProperty,'FormOpenDental')
    $forms+=@($root.FindAll($TS::Descendants,$condition))
   }
   foreach($form in $forms){
    $current=$form.Current
    if($current.ProcessId -in $processIds -and $current.AutomationId -ceq 'FormOpenDental'){
     $candidates+=@{handle=[string]$current.NativeWindowHandle;processId=$current.ProcessId;id=$current.AutomationId;element=$form}
    }
   }
  }catch{$script:odDiscovery.errors+=@{handle=[string]$handle;error=$_.Exception.Message}}
 }
 return SelectOdMain $candidates
}
