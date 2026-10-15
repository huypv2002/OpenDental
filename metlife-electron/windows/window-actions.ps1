function AssertFocus($main){
 [uint32]$pidValue=0;[void][OdNative]::GetWindowThreadProcessId([OdNative]::GetForegroundWindow(),[ref]$pidValue)
 if($pidValue -ne $main.Current.ProcessId){throw 'Focus moved outside Open Dental. Automation stopped.'}
}
function Click($e,$main){
 AssertFocus $main
 if(-not $e.Current.IsEnabled -or $e.Current.IsOffscreen){throw 'Control is not interactive'}
 # UIA Invoke may block until a modal closes; never retry it with a second click.
 # Use the verified visible control rectangle with focus checks for OD actions.
 $r=$e.Current.BoundingRectangle
 if($r.Width -lt 3 -or $r.Height -lt 3){throw 'Control has no click target'}
 [void][OdNative]::SetCursorPos([int]($r.Left+$r.Width/2),[int]($r.Top+$r.Height/2))
 [OdNative]::mouse_event(2,0,0,0,[UIntPtr]::Zero);[OdNative]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
}
