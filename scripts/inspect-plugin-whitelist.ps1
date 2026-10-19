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

Write-Host "=== Open Dental Plugin Whitelist Deep Inspector ==="
Write-Host "Target Directory: $InstallDir`n"

Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Reflection;
using System.Text;
using System.Collections.Generic;

public class ODWhitelistDeepInspector {
    public static void ScanDirectoryRawStrings(string dir) {
        Console.WriteLine("[STEP 1] Scanning ALL binaries (.dll, .exe) in " + dir + " for whitelist keywords...");
        string[] files = Directory.GetFiles(dir, "*.*");
        int matchCount = 0;

        string[] targets = new string[] {
            "whitelisted",
            "plugins must be whitelisted",
            "was not loaded",
            "plugins.html",
            "isdisabledbyhq",
            "whitelist"
        };

        foreach (string file in files) {
            string ext = Path.GetExtension(file).ToLowerInvariant();
            if (ext != ".dll" && ext != ".exe") continue;

            try {
                byte[] raw = File.ReadAllBytes(file);
                string u16 = Encoding.Unicode.GetString(raw);
                string u8 = Encoding.UTF8.GetString(raw);

                foreach (string term in targets) {
                    bool matchU16 = u16.IndexOf(term, StringComparison.OrdinalIgnoreCase) >= 0;
                    bool matchU8 = u8.IndexOf(term, StringComparison.OrdinalIgnoreCase) >= 0;

                    if (matchU16 || matchU8) {
                        matchCount++;
                        Console.WriteLine("\n[MATCH] File: " + Path.GetFileName(file) + " contains keyword: '" + term + "'");
                        if (matchU16) PrintSnippets(u16, "Unicode", term);
                        if (matchU8) PrintSnippets(u8, "UTF-8", term);
                    }
                }
            } catch {
                // Skip unreadable files
            }
        }

        Console.WriteLine("\nRaw scan completed. Total matches found: " + matchCount);
    }

    private static void PrintSnippets(string text, string encodingName, string term) {
        int idx = 0;
        int count = 0;
        while ((idx = text.IndexOf(term, idx, StringComparison.OrdinalIgnoreCase)) >= 0 && count < 5) {
            int start = Math.Max(0, idx - 60);
            int len = Math.Min(text.Length - start, 180);
            string snippet = text.Substring(start, len).Replace("\r", " ").Replace("\n", " ");
            Console.WriteLine("    [" + encodingName + " context]: " + snippet);
            idx += term.Length;
            count++;
        }
    }

    public static void InspectPluginClasses(string dir) {
        Console.WriteLine("\n[STEP 2] Inspecting Plugin reflection classes in OpenDental.exe & OpenDentBusiness.dll...");
        string[] targets = new string[] {
            Path.Combine(dir, "OpenDental.exe"),
            Path.Combine(dir, "OpenDentBusiness.dll"),
            Path.Combine(dir, "CodeBase.dll")
        };

        AppDomain.CurrentDomain.AssemblyResolve += (sender, args) => {
            string asmName = new AssemblyName(args.Name).Name + ".dll";
            string p = Path.Combine(dir, asmName);
            if (File.Exists(p)) {
                try { return Assembly.LoadFrom(p); } catch {}
            }
            return null;
        };

        foreach (string path in targets) {
            if (!File.Exists(path)) continue;
            Console.WriteLine("\n--- Assembly: " + Path.GetFileName(path) + " ---");
            Assembly asm = null;
            try {
                asm = Assembly.LoadFrom(path);
            } catch (Exception ex) {
                Console.WriteLine("    Load error: " + ex.Message);
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
                string fullName = t.FullName;
                if (name.IndexOf("Plugin", StringComparison.OrdinalIgnoreCase) >= 0 ||
                    name.IndexOf("Program", StringComparison.OrdinalIgnoreCase) >= 0 ||
                    name.IndexOf("Whitelist", StringComparison.OrdinalIgnoreCase) >= 0) {
                    
                    Console.WriteLine("  Class: " + fullName);
                    MethodInfo[] methods = t.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Instance | BindingFlags.DeclaredOnly);
                    foreach (MethodInfo m in methods) {
                        string mName = m.Name;
                        if (mName.IndexOf("Load", StringComparison.OrdinalIgnoreCase) >= 0 ||
                            mName.IndexOf("Plugin", StringComparison.OrdinalIgnoreCase) >= 0 ||
                            mName.IndexOf("Whitelist", StringComparison.OrdinalIgnoreCase) >= 0 ||
                            mName.IndexOf("Check", StringComparison.OrdinalIgnoreCase) >= 0 ||
                            mName.IndexOf("Valid", StringComparison.OrdinalIgnoreCase) >= 0) {
                            
                            Console.WriteLine("    Method: " + mName);
                            // Inspect string tokens in method IL
                            InspectMethodStrings(asm, m);
                        }
                    }
                }
            }
        }
    }

    private static void InspectMethodStrings(Assembly asm, MethodInfo m) {
        try {
            MethodBody body = m.GetMethodBody();
            if (body == null) return;
            byte[] il = body.GetILAsByteArray();
            for (int i = 0; i < il.Length - 4; i++) {
                if (il[i] == 0x72) { // ldstr opcode
                    int token = BitConverter.ToInt32(il, i + 1);
                    if ((token & 0xFF000000) == 0x70000000) {
                        try {
                            string s = asm.ManifestModule.ResolveString(token);
                            if (!string.IsNullOrEmpty(s) && (
                                s.IndexOf("plugin", StringComparison.OrdinalIgnoreCase) >= 0 ||
                                s.IndexOf("whitelist", StringComparison.OrdinalIgnoreCase) >= 0 ||
                                s.IndexOf("load", StringComparison.OrdinalIgnoreCase) >= 0 ||
                                s.IndexOf("disabled", StringComparison.OrdinalIgnoreCase) >= 0 ||
                                s.IndexOf("http", StringComparison.OrdinalIgnoreCase) >= 0)) {
                                Console.WriteLine("      [IL String]: " + s);
                            }
                        } catch {}
                    }
                }
            }
        } catch {}
    }
}
'@

[ODWhitelistDeepInspector]::ScanDirectoryRawStrings($InstallDir)
[ODWhitelistDeepInspector]::InspectPluginClasses($InstallDir)

Write-Host "`n=== Inspection Complete ==="
