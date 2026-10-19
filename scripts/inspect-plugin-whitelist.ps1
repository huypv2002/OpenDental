# Inspect where Open Dental enforces plugin whitelisting
param(
    [string]$InstallDir
)

# Auto-relaunch in 32-bit PowerShell (SysWOW64) for x86 Open Dental assemblies if needed
if ([IntPtr]::Size -eq 8) {
    $ps32 = Join-Path $env:SystemRoot "SysWOW64\WindowsPowerShell\v1.0\powershell.exe"
    if (Test-Path $ps32) {
        Write-Host "Switching to 32-bit PowerShell (SysWOW64) to inspect x86 Open Dental assemblies..."
        & $ps32 -NoProfile -ExecutionPolicy Bypass -File $MyInvocation.MyCommand.Path @args
        exit $LASTEXITCODE
    }
}

if (-not $InstallDir) {
    $candidates = @("${env:ProgramFiles(x86)}\Open Dental", "$env:ProgramFiles\Open Dental", 'C:\Open Dental')
    $InstallDir = $candidates | Where-Object { Test-Path (Join-Path $_ 'OpenDental.exe') } | Select-Object -First 1
}

if (-not $InstallDir) {
    Write-Error "Open Dental installation directory not found."
    exit 1
}

Write-Host "=== Open Dental Plugin Whitelist & Integrity Deep Disassembler ==="
Write-Host "Target Directory: $InstallDir`n"

Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Reflection;
using System.Text;
using System.Collections;
using System.Collections.Generic;

public class ODPluginDisassembler {
    public static void Run(string dir) {
        AppDomain.CurrentDomain.AssemblyResolve += (sender, args) => {
            string asmName = new AssemblyName(args.Name).Name + ".dll";
            string p = Path.Combine(dir, asmName);
            if (File.Exists(p)) {
                try { return Assembly.LoadFrom(p); } catch {}
            }
            return null;
        };

        // 1. Find DatabaseIntegrities across all assemblies in directory
        string[] files = Directory.GetFiles(dir, "*.dll");
        Type dbIntegritiesType = null;
        Assembly dbIntegritiesAsm = null;

        foreach (string f in files) {
            try {
                Assembly a = Assembly.LoadFrom(f);
                Type[] types = null;
                try { types = a.GetTypes(); } catch (ReflectionTypeLoadException ex) {
                    List<Type> list = new List<Type>();
                    foreach (Type t in ex.Types) { if (t != null) list.Add(t); }
                    types = list.ToArray();
                }
                foreach (Type t in types) {
                    if (t.Name == "DatabaseIntegrities" || t.FullName == "OpenDental.DatabaseIntegrities" || t.FullName == "OpenDentBusiness.DatabaseIntegrities") {
                        dbIntegritiesType = t;
                        dbIntegritiesAsm = a;
                        Console.WriteLine("FOUND DatabaseIntegrities in: " + Path.GetFileName(f) + " -> " + t.FullName);
                        break;
                    }
                }
                if (dbIntegritiesType != null) break;
            } catch {}
        }

        // Also check OpenDental.exe
        if (dbIntegritiesType == null) {
            try {
                Assembly a = Assembly.LoadFrom(Path.Combine(dir, "OpenDental.exe"));
                foreach (Type t in a.GetTypes()) {
                    if (t.Name == "DatabaseIntegrities") {
                        dbIntegritiesType = t;
                        dbIntegritiesAsm = a;
                        Console.WriteLine("FOUND DatabaseIntegrities in OpenDental.exe -> " + t.FullName);
                        break;
                    }
                }
            } catch {}
        }

        // 2. Dump all members and methods of DatabaseIntegrities
        if (dbIntegritiesType != null) {
            Console.WriteLine("\n========================================================");
            Console.WriteLine(">>> DISSECTING DatabaseIntegrities");
            Console.WriteLine("========================================================");

            foreach (FieldInfo f in dbIntegritiesType.GetFields(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Instance)) {
                Console.WriteLine("  Field: " + f.FieldType.Name + " " + f.Name);
                if (f.IsStatic) {
                    try {
                        object val = f.GetValue(null);
                        Console.WriteLine("    Value = " + DumpValue(val));
                    } catch (Exception ex) { Console.WriteLine("    Value error: " + ex.Message); }
                }
            }

            foreach (PropertyInfo p in dbIntegritiesType.GetProperties(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Instance)) {
                Console.WriteLine("  Prop: " + p.PropertyType.Name + " " + p.Name);
                if (p.CanRead && p.GetGetMethod(true).IsStatic && p.GetIndexParameters().Length == 0) {
                    try {
                        object val = p.GetValue(null, null);
                        Console.WriteLine("    Value = " + DumpValue(val));
                    } catch (Exception ex) { Console.WriteLine("    Value error: " + ex.Message); }
                }
            }

            foreach (MethodInfo m in dbIntegritiesType.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Instance | BindingFlags.DeclaredOnly)) {
                Console.WriteLine("\n  Method: " + m.ReturnType.Name + " " + m.Name + "(" + FormatParams(m) + ")");
                DisassembleFullMethod(dbIntegritiesAsm, m);
            }

            // Test IsPluginAllowed directly with test strings
            MethodInfo isPluginAllowed = dbIntegritiesType.GetMethod("IsPluginAllowed", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
            if (isPluginAllowed != null) {
                Console.WriteLine("\n--- Testing IsPluginAllowed method invocations ---");
                string[] testDlls = new string[] {
                    "LukMetlifeHash.dll",
                    "someplugin.dll",
                    "DentalIntel.dll",
                    "Podium.dll",
                    "Weave.dll",
                    "CareCredit.dll",
                    "Plugin.dll"
                };
                foreach (string d in testDlls) {
                    try {
                        object res = isPluginAllowed.Invoke(null, new object[] { d });
                        Console.WriteLine("    IsPluginAllowed(\"" + d + "\") => " + res);
                    } catch (Exception ex) {
                        Console.WriteLine("    IsPluginAllowed(\"" + d + "\") ERROR: " + ex.InnerException != null ? ex.InnerException.Message : ex.Message);
                    }
                }
            }
        }

        // 3. Dissect PluginLoader.LoadAllPlugins in WpfControlsOD.dll
        string wpfPath = Path.Combine(dir, "WpfControlsOD.dll");
        if (File.Exists(wpfPath)) {
            Assembly wpfAsm = Assembly.LoadFrom(wpfPath);
            Type pLoader = wpfAsm.GetType("OpenDental.PluginLoader");
            if (pLoader != null) {
                Console.WriteLine("\n========================================================");
                Console.WriteLine(">>> FULL DISASSEMBLY: OpenDental.PluginLoader.LoadAllPlugins");
                Console.WriteLine("========================================================");
                MethodInfo loadAll = pLoader.GetMethod("LoadAllPlugins", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Instance);
                if (loadAll != null) {
                    DisassembleFullMethod(wpfAsm, loadAll);
                }
            }
        }
    }

    private static string FormatParams(MethodInfo m) {
        ParameterInfo[] ps = m.GetParameters();
        List<string> pstrs = new List<string>();
        foreach (var p in ps) pstrs.Add(p.ParameterType.Name + " " + p.Name);
        return string.Join(", ", pstrs.ToArray());
    }

    private static string DumpValue(object val) {
        if (val == null) return "null";
        if (val is string || val.GetType().IsPrimitive) return "\"" + val + "\"";
        if (val is IEnumerable) {
            List<string> items = new List<string>();
            foreach (object o in (IEnumerable)val) {
                if (o != null) items.Add(o.ToString());
            }
            return "[" + string.Join(", ", items.ToArray()) + "]";
        }
        return val.ToString();
    }

    private static void DisassembleFullMethod(Assembly asm, MethodInfo m) {
        try {
            MethodBody body = m.GetMethodBody();
            if (body == null) return;
            byte[] il = body.GetILAsByteArray();
            for (int i = 0; i < il.Length - 4; i++) {
                byte op = il[i];
                if (op == 0x72) { // ldstr
                    int token = BitConverter.ToInt32(il, i + 1);
                    if ((token & 0xFF000000) == 0x70000000) {
                        try {
                            string s = asm.ManifestModule.ResolveString(token);
                            if (!string.IsNullOrEmpty(s)) {
                                Console.WriteLine("      [IL String]: " + s.Replace("\r", " ").Replace("\n", " "));
                            }
                        } catch {}
                    }
                } else if (op == 0x28 || op == 0x6F) { // call, callvirt
                    int token = BitConverter.ToInt32(il, i + 1);
                    try {
                        MethodBase called = asm.ManifestModule.ResolveMethod(token);
                        if (called != null) {
                            string cName = called.DeclaringType != null ? called.DeclaringType.Name : "";
                            Console.WriteLine("      [IL Call]: " + cName + "." + called.Name);
                        }
                    } catch {}
                } else if (op == 0x7B || op == 0x7E) { // ldfld, ldsfld
                    int token = BitConverter.ToInt32(il, i + 1);
                    try {
                        FieldInfo f = asm.ManifestModule.ResolveField(token) as FieldInfo;
                        if (f != null) {
                            string cName = f.DeclaringType != null ? f.DeclaringType.Name : "";
                            Console.WriteLine("      [IL Field]: " + cName + "." + f.Name);
                        }
                    } catch {}
                }
            }
        } catch {}
    }
}
'@

[ODPluginDisassembler]::Run($InstallDir)

Write-Host "`n=== Complete ==="
