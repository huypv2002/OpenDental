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

Write-Host "=== Open Dental Plugin Whitelist & Integrity Deep Inspector ==="
Write-Host "Target Directory: $InstallDir`n"

Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Reflection;
using System.Text;
using System.Collections;
using System.Collections.Generic;

public class ODWhitelistDeepInspector {
    public static void DeepInspect(string dir) {
        AppDomain.CurrentDomain.AssemblyResolve += (sender, args) => {
            string asmName = new AssemblyName(args.Name).Name + ".dll";
            string p = Path.Combine(dir, asmName);
            if (File.Exists(p)) {
                try { return Assembly.LoadFrom(p); } catch {}
            }
            return null;
        };

        string[] dllsToInspect = new string[] {
            Path.Combine(dir, "WpfControlsOD.dll"),
            Path.Combine(dir, "OpenDentBusiness.dll"),
            Path.Combine(dir, "OpenDental.exe")
        };

        foreach (string dll in dllsToInspect) {
            if (!File.Exists(dll)) continue;
            Console.WriteLine("\n========================================================");
            Console.WriteLine(">>> ASSEMBLY: " + Path.GetFileName(dll));
            Console.WriteLine("========================================================");

            Assembly asm = null;
            try {
                asm = Assembly.LoadFrom(dll);
            } catch (Exception ex) {
                Console.WriteLine("  Error loading: " + ex.Message);
                continue;
            }

            Type[] types = null;
            try {
                types = asm.GetTypes();
            } catch (ReflectionTypeLoadException ex) {
                List<Type> list = new List<Type>();
                foreach (Type t in ex.Types) { if (t != null) list.Add(t); }
                types = list.ToArray();
            }

            foreach (Type t in types) {
                string name = t.Name;
                bool isTarget = (
                    name.IndexOf("Integrity", StringComparison.OrdinalIgnoreCase) >= 0 ||
                    name.IndexOf("WhiteList", StringComparison.OrdinalIgnoreCase) >= 0 ||
                    name.IndexOf("HqProgram", StringComparison.OrdinalIgnoreCase) >= 0 ||
                    name.IndexOf("Plugin", StringComparison.OrdinalIgnoreCase) >= 0 ||
                    name == "Programs"
                );

                if (!isTarget) continue;

                Console.WriteLine("\n[CLASS] " + t.FullName);

                // Print static fields & their values
                foreach (FieldInfo f in t.GetFields(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static)) {
                    try {
                        object val = f.GetValue(null);
                        Console.WriteLine("  Static Field: " + f.FieldType.Name + " " + f.Name + " = " + DumpValue(val));
                    } catch {}
                }

                // Print static properties & their values
                foreach (PropertyInfo p in t.GetProperties(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static)) {
                    if (p.CanRead && p.GetIndexParameters().Length == 0) {
                        try {
                            object val = p.GetValue(null, null);
                            Console.WriteLine("  Static Prop: " + p.PropertyType.Name + " " + p.Name + " = " + DumpValue(val));
                        } catch {}
                    }
                }

                // Inspect methods
                MethodInfo[] methods = t.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Instance | BindingFlags.DeclaredOnly);
                foreach (MethodInfo m in methods) {
                    string mName = m.Name;
                    bool dumpMethod = (
                        mName.IndexOf("Load", StringComparison.OrdinalIgnoreCase) >= 0 ||
                        mName.IndexOf("Plugin", StringComparison.OrdinalIgnoreCase) >= 0 ||
                        mName.IndexOf("Whitelist", StringComparison.OrdinalIgnoreCase) >= 0 ||
                        mName.IndexOf("Hq", StringComparison.OrdinalIgnoreCase) >= 0 ||
                        mName.IndexOf("Integrity", StringComparison.OrdinalIgnoreCase) >= 0 ||
                        mName.IndexOf("Check", StringComparison.OrdinalIgnoreCase) >= 0 ||
                        mName.IndexOf("Valid", StringComparison.OrdinalIgnoreCase) >= 0 ||
                        mName.IndexOf("Enable", StringComparison.OrdinalIgnoreCase) >= 0 ||
                        mName.IndexOf("Disable", StringComparison.OrdinalIgnoreCase) >= 0 ||
                        mName.IndexOf("Init", StringComparison.OrdinalIgnoreCase) >= 0
                    );

                    if (dumpMethod) {
                        Console.WriteLine("  Method: " + m.ReturnType.Name + " " + m.Name + "(" + FormatParams(m) + ")");
                        DisassembleMethod(asm, m);
                    }
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

    private static void DisassembleMethod(Assembly asm, MethodInfo m) {
        try {
            MethodBody body = m.GetMethodBody();
            if (body == null) return;
            byte[] il = body.GetILAsByteArray();
            for (int i = 0; i < il.Length - 4; i++) {
                byte op = il[i];
                // ldstr (0x72)
                if (op == 0x72) {
                    int token = BitConverter.ToInt32(il, i + 1);
                    if ((token & 0xFF000000) == 0x70000000) {
                        try {
                            string s = asm.ManifestModule.ResolveString(token);
                            if (!string.IsNullOrEmpty(s)) {
                                Console.WriteLine("      [String]: " + s.Replace("\r", " ").Replace("\n", " "));
                            }
                        } catch {}
                    }
                }
                // call (0x28) or callvirt (0x6F)
                else if (op == 0x28 || op == 0x6F) {
                    int token = BitConverter.ToInt32(il, i + 1);
                    try {
                        MethodBase called = asm.ManifestModule.ResolveMethod(token);
                        if (called != null) {
                            string cName = called.DeclaringType != null ? called.DeclaringType.Name : "";
                            if (cName.IndexOf("Plugin", StringComparison.OrdinalIgnoreCase) >= 0 ||
                                cName.IndexOf("Integrity", StringComparison.OrdinalIgnoreCase) >= 0 ||
                                cName.IndexOf("Program", StringComparison.OrdinalIgnoreCase) >= 0 ||
                                cName.IndexOf("Hq", StringComparison.OrdinalIgnoreCase) >= 0 ||
                                cName.IndexOf("MsgBox", StringComparison.OrdinalIgnoreCase) >= 0 ||
                                cName.IndexOf("Database", StringComparison.OrdinalIgnoreCase) >= 0 ||
                                cName.IndexOf("Form", StringComparison.OrdinalIgnoreCase) >= 0 ||
                                cName.IndexOf("Web", StringComparison.OrdinalIgnoreCase) >= 0) {
                                Console.WriteLine("      [Call]: " + cName + "." + called.Name);
                            }
                        }
                    } catch {}
                }
            }
        } catch {}
    }
}
'@

[ODWhitelistDeepInspector]::DeepInspect($InstallDir)

Write-Host "`n=== Inspection Complete ==="
