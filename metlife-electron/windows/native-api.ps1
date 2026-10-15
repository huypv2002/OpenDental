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
 [DllImport("user32.dll")] public static extern void keybd_event(byte key,byte scan,uint flags,UIntPtr extra);
 public static Rectangle[] SelectionBands(Bitmap bitmap) {
  var bands=new List<Rectangle>();int width=bitmap.Width,height=bitmap.Height;
  int start=-1,last=-1;
  for(int y=1;y<height-1;y++){
   int hits=0,count=0;
   for(int x=3;x<width-18;x+=5){
    var c=bitmap.GetPixel(x,y);count++;
    if((c.B-c.R>15&&c.B>120&&c.R<225)||(c.R>=140&&c.R<=215&&Math.Abs(c.R-c.G)<15&&c.B-c.R>=0&&c.B-c.R<35))hits++;
   }
   if(count>0&&(double)hits/count>0.62){if(start<0)start=y;last=y;}
   else if(start>=0&&y-last>4){if(last-start>=3)bands.Add(new Rectangle(0,start,width,last-start+1));start=-1;}
  }
  if(start>=0&&last-start>=3)bands.Add(new Rectangle(0,start,width,last-start+1));
  return bands.ToArray();
 }
 public static Rectangle[] SelectedBands(int left,int top,int width,int height) {
  using(var bitmap=new Bitmap(width,height))using(var graphics=Graphics.FromImage(bitmap)){
   graphics.CopyFromScreen(left,top,0,0,bitmap.Size);
   return SelectionBands(bitmap);
  }
 }
 // Identify actual grey header dividers, excluding black glyphs and blue title bars.
 public static int[] HeaderDividers(Bitmap bitmap) {
  var hits=new List<int>();
  for(int x=2;x<bitmap.Width-2;x++){
   int count=0;
   for(int y=0;y<bitmap.Height;y++){
    var c=bitmap.GetPixel(x,y);
    if(c.R>=95&&c.R<=210&&Math.Abs(c.R-c.G)<18&&Math.Abs(c.G-c.B)<18)count++;
   }
   if((double)count/bitmap.Height>0.75)hits.Add(x);
  }
  var edges=new List<int>{0};int start=-1,last=-1;
  foreach(int x in hits){
   if(start<0){start=last=x;continue;}
   if(x-last<=3){last=x;continue;}
   edges.Add((start+last)/2);start=last=x;
  }
  if(start>=0)edges.Add((start+last)/2);
  edges.Add(bitmap.Width);return edges.ToArray();
 }
 static bool CheckInk(Bitmap b,int x,int y) {
  var c=b.GetPixel(x,y);return Math.Max(c.R,Math.Max(c.G,c.B))<200&&Math.Abs(c.R-c.G)<40&&Math.Abs(c.G-c.B)<40;
 }
 // Returns -1 for unknown/indeterminate; detects the actual square, not its caption.
 public static int PaintedCheckState(Bitmap b) {
  double best=0;int result=-1;
  for(int size=8;size<=Math.Min(40,b.Height-2);size++){
   for(int x=0;x<b.Width-size;x++){
    if(x>10&&x<b.Width-size-11)continue;
    for(int y=0;y<b.Height-size;y++){
     int t=0,d=0,l=0,r=0;
     for(int i=0;i<=size;i++){if(CheckInk(b,x+i,y))t++;if(CheckInk(b,x+i,y+size))d++;if(CheckInk(b,x,y+i))l++;if(CheckInk(b,x+size,y+i))r++;}
     double score=(double)Math.Min(Math.Min(t,d),Math.Min(l,r))/(size+1);
     if(score<0.75||score<=best)continue;
     int inset=Math.Max(2,(int)Math.Round(size*0.22)),count=0,ink=0;
     for(int xx=x+inset;xx<=x+size-inset;xx++)for(int yy=y+inset;yy<=y+size-inset;yy++){count++;if(CheckInk(b,xx,yy))ink++;}
     double fill=(double)ink/count;
     result=fill<=0.03?0:(fill>=0.08&&fill<=0.65?1:-1);best=score;
    }
   }
  }
  return result;
 }
 public static string VisualHash(int left,int top,int width,int height) {
  using(var bitmap=new Bitmap(width,height))using(var graphics=Graphics.FromImage(bitmap)){
   graphics.CopyFromScreen(left,top,0,0,bitmap.Size);
   using(var stream=new System.IO.MemoryStream())using(var hash=System.Security.Cryptography.SHA256.Create()){
    bitmap.Save(stream,System.Drawing.Imaging.ImageFormat.Png);
    return Convert.ToBase64String(hash.ComputeHash(stream.ToArray()));
   }
  }
 }
 public static void NormalizeOcr(Bitmap bitmap) {
  var rect=new Rectangle(0,0,bitmap.Width,bitmap.Height);
  var data=bitmap.LockBits(rect,System.Drawing.Imaging.ImageLockMode.ReadWrite,System.Drawing.Imaging.PixelFormat.Format32bppArgb);
  try {
   var bytes=new byte[Math.Abs(data.Stride)*data.Height];
   Marshal.Copy(data.Scan0,bytes,0,bytes.Length);
   for(int y=0;y<data.Height;y++)for(int x=0;x<bitmap.Width;x++){
    int i=y*Math.Abs(data.Stride)+x*4;
    byte value=(byte)(bytes[i+2]*0.299+bytes[i+1]*0.587+bytes[i]*0.114<175?0:255);
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
