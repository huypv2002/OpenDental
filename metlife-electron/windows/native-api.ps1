Add-Type -ReferencedAssemblies 'System.Drawing.dll' @'
using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Collections.Generic;
public static class OdNative {
 public delegate bool EnumWindowCallback(IntPtr h, IntPtr p);
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowCallback callback, IntPtr p);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int command);
 public static IntPtr[] TopWindows() {
   var handles=new List<IntPtr>();
   EnumWindowCallback callback=(h,p)=>{handles.Add(h);return true;};
   EnumWindows(callback,IntPtr.Zero);
   return handles.ToArray();
 }

 [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr SendMessageTimeout(IntPtr h,uint m,IntPtr w,string text,uint flags,uint timeout,out UIntPtr result);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] public static extern void mouse_event(uint a,uint b,uint c,uint d,UIntPtr e);
 [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
 public static void NormalizeOcr(Bitmap bitmap) {
  var rect=new Rectangle(0,0,bitmap.Width,bitmap.Height);
  var data=bitmap.LockBits(rect,System.Drawing.Imaging.ImageLockMode.ReadWrite,System.Drawing.Imaging.PixelFormat.Format32bppArgb);
  try {
   var bytes=new byte[Math.Abs(data.Stride)*data.Height];
   Marshal.Copy(data.Scan0,bytes,0,bytes.Length);
   for(int y=0;y<data.Height;y++)for(int x=0;x<bitmap.Width;x++){
    int i=y*Math.Abs(data.Stride)+x*4;
    byte value=(byte)(bytes[i+2]*0.299+bytes[i+1]*0.587+bytes[i]*0.114<120?0:255);
    bytes[i]=value;bytes[i+1]=value;bytes[i+2]=value;bytes[i+3]=255;
   }
   Marshal.Copy(bytes,0,data.Scan0,bytes.Length);
  }finally{bitmap.UnlockBits(data);}
 }
 public static Point Locate(Bitmap screen, Bitmap template) {
   // Conservative colour match. Native capture templates only; unknown themes/layouts stop.
   var found=new List<Point>();
   double best=999; Point point=Point.Empty;
   foreach(double scale in new[]{0.75,1.0,1.25,1.5,2.0}) {
     int w=(int)Math.Round(template.Width*scale),h=(int)Math.Round(template.Height*scale);
     using(var t=new Bitmap(template,new Size(w,h))) {
       for(int y=0;y<=screen.Height-h;y++) for(int x=0;x<=screen.Width-w;x++) {
         double sum=0;int n=0;bool bad=false;
         for(int ty=1;ty<h;ty+=3) {
           for(int tx=1;tx<w;tx+=3) {
             Color a=screen.GetPixel(x+tx,y+ty),b=t.GetPixel(tx,ty);
             sum+=(Math.Abs(a.R-b.R)+Math.Abs(a.G-b.G)+Math.Abs(a.B-b.B))/3.0;n++;
           }
           if(n>30 && sum/n>7){bad=true;break;}
         }
         if(!bad && n>0 && sum/n<5) {
           var p=new Point(x+w/2,y+h/2);
           if(sum/n<best){best=sum/n;point=p;}
           if(!found.Exists(q=>Math.Abs(q.X-p.X)<20 && Math.Abs(q.Y-p.Y)<20))found.Add(p);
         }
       }
     }
   }
   if(found.Count!=1) throw new Exception("Payment button image is missing or ambiguous; no click was made.");
   return point;
 }
}
'@
