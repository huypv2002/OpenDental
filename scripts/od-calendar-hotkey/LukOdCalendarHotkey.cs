// Standalone Windows client. No Open Dental DLL loading, injection, or DB access.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Automation;
using System.Windows.Forms;
using System.Drawing;

namespace LukOdCalendarHotkey {
 static class Native {
  [DllImport("user32.dll")] internal static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] internal static extern IntPtr GetLastActivePopup(IntPtr h);
  [DllImport("user32.dll")] internal static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] internal static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
  [DllImport("user32.dll")] internal static extern IntPtr GetAncestor(IntPtr h,uint flags);
  [DllImport("user32.dll")] internal static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] internal static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] internal static extern void mouse_event(uint flags,uint x,uint y,uint data,UIntPtr extra);
  [DllImport("user32.dll")] internal static extern bool RegisterHotKey(IntPtr h,int id,uint modifiers,uint key);
  [DllImport("user32.dll")] internal static extern bool UnregisterHotKey(IntPtr h,int id);
  [DllImport("user32.dll")] internal static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] internal static extern short GetAsyncKeyState(int key);
  [DllImport("user32.dll",SetLastError=true)] internal static extern bool PostMessage(IntPtr h,uint message,IntPtr w,IntPtr l);
  [StructLayout(LayoutKind.Sequential)] internal struct POINT { public int X,Y; public POINT(int x,int y){X=x;Y=y;} }
 }
 static class Calendar {
  internal static AutomationElement Unique(AutomationElement root,string id) {
   var all=root.FindAll(TreeScope.Descendants,new PropertyCondition(AutomationElement.AutomationIdProperty,id));
   AutomationElement found=null;
   foreach(AutomationElement e in all) if(!e.Current.IsOffscreen) {
    if(found!=null) throw new InvalidOperationException("Multiple visible controls: "+id); found=e;
   }
   if(found==null) throw new InvalidOperationException("Control unavailable: "+id);
   return found;
  }
  internal static IntPtr ActiveMain() {
   IntPtr h=Native.GetForegroundWindow(); uint pid; Native.GetWindowThreadProcessId(h,out pid);
   if(h==IntPtr.Zero || !String.Equals(Process.GetProcessById((int)pid).ProcessName,"OpenDental",StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Select the OD Appointments window first.");
   var process=Process.GetProcessById((int)pid);
   if(process.MainWindowHandle!=h) throw new InvalidOperationException("Close the OD dialog before using this shortcut.");
   IntPtr popup=Native.GetLastActivePopup(h);
   if(popup!=h && Native.IsWindowVisible(popup)) throw new InvalidOperationException("An OD dialog is open.");
   return h;
  }
  static void AssertForeground(IntPtr h) {
   if(Native.GetForegroundWindow()!=h) throw new InvalidOperationException("Focus changed; navigation stopped.");
  }
  internal static AutomationElement CalendarControl(IntPtr main) {
   var root=AutomationElement.FromHandle(main);
   if(!root.Current.IsEnabled) throw new InvalidOperationException("OD is blocked by a dialog.");
   var module=Unique(root,"ControlAppt");
   Unique(module,"butBackMonth");
   return Unique(module,"monthCalendarOD");
  }
  static AutomationElement OpenPicker(IntPtr main) {
   AssertForeground(main);
   var calendar=CalendarControl(main); var r=calendar.Current.BoundingRectangle;
   if(r.Width<100 || r.Height<80) throw new InvalidOperationException("Unexpected calendar dimensions.");
   // OD MonthCalendarOD source places the month/year header at (Width/2,16.5*scale).
   int x=(int)(r.Left+r.Width/2), y=(int)(r.Top+r.Width*16.5/227.0);
   if(Native.GetAncestor(Native.WindowFromPoint(new Native.POINT(x,y)),2)!=main) throw new InvalidOperationException("Calendar header is covered by another window.");
   if(!Native.SetCursorPos(x,y)) throw new InvalidOperationException("Cannot move pointer to calendar header.");
   Thread.Sleep(100); AssertForeground(main);
   Native.mouse_event(2,0,0,0,UIntPtr.Zero); Native.mouse_event(4,0,0,0,UIntPtr.Zero);
   for(int i=0;i<30;i++) {
    Thread.Sleep(100);
    IntPtr h=Native.GetForegroundWindow();
    if(h==main) continue;
    uint pid1,pid2; Native.GetWindowThreadProcessId(main,out pid1); Native.GetWindowThreadProcessId(h,out pid2);
    if(pid1!=pid2) throw new InvalidOperationException("Focus moved to another application.");
    if(Native.GetLastActivePopup(main)!=h) throw new InvalidOperationException("Unexpected OD popup.");
    var popup=AutomationElement.FromHandle(h);
    // WPF exposes its window before Loaded has populated textDate.
    try {
     DateBox(popup); Unique(popup,"butOK");
     if(String.IsNullOrWhiteSpace(ReadDateText(popup))) continue;
    } catch(InvalidOperationException) { continue; }
    var bounds=popup.Current.BoundingRectangle;
    if(bounds.Width<r.Width*0.7 || bounds.Width>r.Width*1.5 || bounds.Height>r.Height*1.5) throw new InvalidOperationException("Unexpected date-picker layout.");
    return popup;
   }
   throw new InvalidOperationException("OD date picker did not open. No date was changed.");
  }
  static AutomationElement DateBox(AutomationElement popup) {
   // TextVDate contains one WPF TextBox. Require its parent ID as well as one Edit.
   var parent=Unique(popup,"textDate");
   var edits=parent.FindAll(TreeScope.Subtree,new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.Edit));
   AutomationElement box=null;
   foreach(AutomationElement e in edits) if(!e.Current.IsOffscreen) {
    if(box!=null) throw new InvalidOperationException("Ambiguous date field."); box=e;
   }
   if(box==null) throw new InvalidOperationException("Date field is not exposed to UI Automation.");
   return box;
  }
  internal static DateTime ParseDate(string value) {
   return DatePolicy.Parse(value,CultureInfo.CurrentCulture);
  }
  static string ReadDateText(AutomationElement popup) {
   return ((ValuePattern)DateBox(popup).GetCurrentPattern(ValuePattern.Pattern)).Current.Value;
  }
  static void Cancel(AutomationElement popup) {
   IntPtr h=(IntPtr)popup.Current.NativeWindowHandle;
   AssertForeground(h);
   object pattern;
   if(popup.TryGetCurrentPattern(WindowPattern.Pattern,out pattern)) { ((WindowPattern)pattern).Close(); return; }
   // Close this identified date-picker window only; never send a generic Escape.
   DateBox(popup); Unique(popup,"butOK");
   if(!Native.PostMessage(h,0x10,IntPtr.Zero,IntPtr.Zero)) throw new InvalidOperationException("Could not close date picker.");
  }
  static void ConfirmPicker(AutomationElement popup) {
   IntPtr h=(IntPtr)popup.Current.NativeWindowHandle;
   AssertForeground(h);
   var button=Unique(popup,"butOK");
   if(!button.Current.IsEnabled) throw new InvalidOperationException("Date picker OK is disabled.");
   object pattern;
   if(button.TryGetCurrentPattern(InvokePattern.Pattern,out pattern)) { ((InvokePattern)pattern).Invoke(); return; }
   // OD's WPF custom Button can expose bounds without an Invoke provider.
   var r=button.Current.BoundingRectangle;
   var p=popup.Current.BoundingRectangle;
   if(r.Width<10 || r.Height<10 || !p.Contains(r)) throw new InvalidOperationException("Invalid OK button bounds.");
   int x=(int)(r.Left+r.Width/2), y=(int)(r.Top+r.Height/2);
   if(Native.GetAncestor(Native.WindowFromPoint(new Native.POINT(x,y)),2)!=h) throw new InvalidOperationException("Date picker OK is covered by another window.");
   if(!Native.SetCursorPos(x,y)) throw new InvalidOperationException("Could not reach date picker OK.");
   AssertForeground(h);
   Native.mouse_event(2,0,0,0,UIntPtr.Zero); Native.mouse_event(4,0,0,0,UIntPtr.Zero);
  }
  internal static string BackSixMonths() {
   IntPtr main=ActiveMain(); AutomationElement popup=null;
   string stage="open date picker"; bool confirmed=false;
   try {
    popup=OpenPicker(main);
    stage="read selected date";
    string originalDateText=ReadDateText(popup);
    DateTime before=ParseDate(originalDateText), target=DatePolicy.BackSixMonths(before);
    AssertForeground((IntPtr)popup.Current.NativeWindowHandle);
    stage="fill target date";
    var value=(ValuePattern)DateBox(popup).GetCurrentPattern(ValuePattern.Pattern);
    if(value.Current.IsReadOnly) throw new InvalidOperationException("Date field is read-only.");
    value.SetValue(DatePolicy.Format(target,originalDateText,CultureInfo.CurrentCulture));
    if(ParseDate(ReadDateText(popup))!=target) throw new InvalidOperationException("Date entry readback failed.");
    AssertForeground((IntPtr)popup.Current.NativeWindowHandle);
    stage="confirm date picker OK";
    ConfirmPicker(popup); confirmed=true;
    popup=null;
    for(int i=0;i<30 && Native.GetForegroundWindow()!=main;i++) Thread.Sleep(100);
    AssertForeground(main);
    stage="wait for calendar";
    CalendarControl(main);
    // Keep navigation to a single picker. The entered date was checked before
    // OK; after submission only confirm that OD returned to Appointments.
    return before.ToString("yyyy-MM-dd")+" -> "+target.ToString("yyyy-MM-dd")+" (submitted; calendar available)";
   } catch(Exception e) {
    throw new InvalidOperationException("Stage="+stage+": "+e.Message+(confirmed?" Calendar may already have moved; inspect before retrying.":""));
   } finally {
    if(popup!=null) { try { Cancel(popup); } catch {} }
   }
  }
  internal static string Inspect() {
   var processes=Process.GetProcessesByName("OpenDental");
   int visible=0, ready=0; var details=new List<string>();
   foreach(var process in processes) {
    try {
     var main=process.MainWindowHandle;
     // Other logon sessions/background processes need not expose a desktop window.
     if(main==IntPtr.Zero || !Native.IsWindowVisible(main)) continue;
     visible++;
     try { CalendarControl(main); ready++; details.Add("PID "+process.Id+": Appointments ready"); }
     catch(Exception e) { details.Add("PID "+process.Id+": "+e.Message); }
    } catch { /* Process may exit during enumeration. */ }
    finally { process.Dispose(); }
   }
   if(ready==0) throw new InvalidOperationException("No ready Appointments window. OD processes="+processes.Length+", visible windows="+visible+". "+String.Join("; ",details));
   return "READY: "+ready+" Appointments window(s); "+String.Join("; ",details)+". No clicks or date changes. Hotkey targets only the foreground OD main window. Date-picker controls still need live verification.";
  }
 }
 sealed class HotkeyWindow : NativeWindow, IDisposable {
  readonly NotifyIcon tray; readonly System.Windows.Forms.Timer timer;
  bool registered; int busy;
  bool conflictShown;
  internal HotkeyWindow() {
   CreateHandle(new CreateParams());
   tray=new NotifyIcon { Icon=SystemIcons.Application,Text="OD calendar: Alt+6",Visible=true };
   tray.ContextMenu=new ContextMenu(new MenuItem[]{new MenuItem("Exit",delegate { Application.ExitThread(); })});
   timer=new System.Windows.Forms.Timer { Interval=500 };
   timer.Tick+=delegate {
    bool active=false;
    try { Calendar.ActiveMain(); active=true; } catch {}
    if(active && !registered) {
     registered=Native.RegisterHotKey(Handle,1,0x4001,0x36);
     if(!registered && !conflictShown) { conflictShown=true; Program.WriteResult("STOP","Cannot register Alt+6. Another application may already use it."); }
    }
    if(!active && registered) { Native.UnregisterHotKey(Handle,1); registered=false; }
   };
   timer.Start();
  }
  protected override void WndProc(ref Message m) {
   if(m.Msg==0x312 && m.WParam.ToInt32()==1 && Interlocked.CompareExchange(ref busy,1,0)==0) {
    Program.WriteResult("RUNNING","Hotkey received; checking OD.");
    ThreadPool.QueueUserWorkItem(delegate {
     string result; bool ok;
     try {
      int waited=0;
      while((Native.GetAsyncKeyState(0x12)<0 || Native.GetAsyncKeyState(0x36)<0) && waited<2000) { Thread.Sleep(50); waited+=50; }
      if(waited>=2000) throw new InvalidOperationException("Release Alt and 6 before navigation.");
      result=Calendar.BackSixMonths(); ok=true;
     } catch(Exception e) { result=e.Message; ok=false; }
     Program.WriteResult(ok?"NAVIGATED":"STOP",result);
     Interlocked.Exchange(ref busy,0);
    });
   }
   base.WndProc(ref m);
  }
  public void Dispose() { timer.Dispose(); Native.UnregisterHotKey(Handle,1); tray.Dispose(); DestroyHandle(); }
 }
 static class Program {
  internal const string Build="2026.11.05.6";
  internal static void WriteResult(string status,string message) {
   try {
    File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"last-result.txt"),
     "Build: "+Build+Environment.NewLine+"UTC: "+DateTime.UtcNow.ToString("o")+Environment.NewLine+status+": "+message);
   } catch {}
  }
  [STAThread] static void Main(string[] args) {
   Native.SetProcessDPIAware();
   if(args.Length==2 && args[0]=="--inspect") {
    try { File.WriteAllText(args[1],Calendar.Inspect()); } catch(Exception e) { File.WriteAllText(args[1],"STOP: "+e.Message); }
    return;
   }
   bool created; using(var mutex=new Mutex(true,"Local\\LukOdCalendarHotkey",out created)) {
    if(!created) return;
    Application.EnableVisualStyles();
    using(var window=new HotkeyWindow()) {
     string log=Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"last-result.txt");
     try { if(File.Exists(log)) File.Copy(log,log+"."+DateTime.UtcNow.Ticks+".bak",false); } catch {}
     WriteResult("WAITING","Select OD Appointments and press Alt+6.");
     Application.Run();
    }
   }
  }
 }
}
