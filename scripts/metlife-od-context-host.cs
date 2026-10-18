// Diagnostic executable with its own identity. No DB access or real patient input.
using System;
using System.IO;
using System.Reflection;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.ExceptionServices;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

public static class MetlifeOdContextHost {
 static string install;
 static bool tracing;
 [ThreadStatic] static bool recording;
 static readonly List<string> failures=new List<string>();
 static readonly object traceLock=new object();
 static Assembly Resolve(object sender,ResolveEventArgs args) {
  var requested=new AssemblyName(args.Name);
  if(String.IsNullOrEmpty(requested.Name) || requested.Name.IndexOfAny(new char[]{'/', '\\', ':'})>=0) return null;
  string path=Path.Combine(install,requested.Name+".dll");
  if(!File.Exists(path)) return null;
  var actual=AssemblyName.GetAssemblyName(path);
  if(!String.Equals(actual.FullName,requested.FullName,StringComparison.OrdinalIgnoreCase))
   throw new FileLoadException("Dependency identity mismatch: requested "+requested.FullName+"; found "+actual.FullName,path);
  return Assembly.LoadFrom(path);
 }
 static void Trace(object sender,FirstChanceExceptionEventArgs args) {
  if(!tracing || recording) return;
  recording=true;
  try {
   string detail=args.Exception.GetType().FullName+": "+args.Exception.Message+" Stack: "+args.Exception.StackTrace;
   if(detail.Length>3000) detail=detail.Substring(0,3000);
   lock(traceLock) { if(failures.Count<12 && !failures.Contains(detail)) failures.Add(detail); }
  } finally { recording=false; }
 }
 static Dictionary<string,object> Context() {
  var domain=AppDomain.CurrentDomain;
  var assemblies=new List<object>();
  foreach(var assembly in domain.GetAssemblies()) {
   string location=null;
   try { location=assembly.Location; } catch {}
   assemblies.Add(new {identity=assembly.FullName,location=location});
  }
  return new Dictionary<string,object> {
   {"processBits",IntPtr.Size*8},{"clrVersion",Environment.Version.ToString()},
   {"applicationBase",domain.BaseDirectory},{"configurationFile",domain.SetupInformation.ConfigurationFile},
   {"entryAssembly",Assembly.GetEntryAssembly().FullName},{"currentDirectory",Environment.CurrentDirectory},
   {"assemblies",assemblies}
  };
 }
 public static int Main(string[] args) {
  if(args.Length!=2) { Console.Error.WriteLine("Expected OD installation directory and report path."); return 2; }
  string output=Path.GetFullPath(args[1]);
  var report=new Dictionary<string,object> {
   {"capturedAt",DateTime.UtcNow.ToString("o")},{"databaseAccess",false},{"syntheticInputOnly",true},
   {"hostIdentity","MetlifeOdContextHost"},
   {"limitations","Own executable identity and default .NET configuration; does not run inside OD, impersonate it, or reproduce its complete context."}
  };
  try {
   install=Path.GetFullPath(args[0]);
   Environment.CurrentDirectory=install;
   AppDomain.CurrentDomain.AssemblyResolve+=Resolve;
   AppDomain.CurrentDomain.FirstChanceException+=Trace;
   tracing=true;
   var business=Assembly.LoadFrom(Path.Combine(install,"OpenDentBusiness.dll"));
   Assembly.LoadFrom(Path.Combine(install,"CodeBase.dll"));
   Assembly.LoadFrom(Path.Combine(install,"CDT.dll"));
   var version=business.GetName().Version;
   if(version.Major!=24 || version.Minor!=3) throw new InvalidOperationException("Probe supports OD 24.3 only.");
   Type splitType=business.GetType("OpenDentBusiness.PaySplit",true);
   object split=Activator.CreateInstance(splitType);
   splitType.GetField("PatNum").SetValue(split,(long)1);
   splitType.GetField("SplitAmt").SetValue(split,0.01);
   splitType.GetField("DatePay").SetValue(split,new DateTime(2000,1,1));
   var method=business.GetType("OpenDentBusiness.PaySplits",true).GetMethod("HashFields",new Type[]{splitType});
   if(method==null) throw new MissingMethodException("PaySplits.HashFields");
   string hash=(string)method.Invoke(null,new object[]{split});
   bool valid=!String.IsNullOrWhiteSpace(hash) && hash.Length<=4096 && !Regex.IsMatch(hash,@"Exception$|\s");
   report["hashReturned"]=valid;
   report["resultLength"]=hash==null?0:hash.Length;
   report["resultKind"]=valid?"nonempty hash candidate":
    (hash!=null && Regex.IsMatch(hash,@"^(?:[A-Za-z_][A-Za-z0-9_.]*)?Exception$")?hash:"empty or rejected output");
   // No hash values are written to stdout or the report.
  } catch(Exception ex) {
   var messages=new List<string>();
   for(Exception current=ex;current!=null;current=current.InnerException) messages.Add(current.GetType().FullName+": "+current.Message);
   report["error"]=String.Join(" -> ",messages);
   report["hashReturned"]=false;
  } finally {
   tracing=false;
   AppDomain.CurrentDomain.FirstChanceException-=Trace;
   AppDomain.CurrentDomain.AssemblyResolve-=Resolve;
  }
  report["context"]=Context();
  report["exceptionTrace"]=failures.ToArray();
  File.WriteAllText(output,new JavaScriptSerializer().Serialize(report),new System.Text.UTF8Encoding(false));
  Console.WriteLine("Saved standalone OD context probe: "+output);
  Console.WriteLine("entryAssembly: "+Assembly.GetEntryAssembly().FullName);
  Console.WriteLine("hashReturned: "+report["hashReturned"]);
  foreach(var failure in failures) Console.WriteLine(failure);
  return 0;
 }
}
