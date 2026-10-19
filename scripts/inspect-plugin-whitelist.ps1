# Inspect where Open Dental enforces plugin whitelisting
param(
    [string]$InstallDir
)

# Auto-relaunch in 32-bit PowerShell (SysWOW64) for x86 Open Dental assemblies
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

Write-Host "Analyzing Open Dental binaries (x86 mode) in: $InstallDir"

$dllPath = Join-Path $InstallDir "OpenDental.exe"
$bizPath = Join-Path $InstallDir "OpenDentBusiness.dll"

$assemblies = @($dllPath, $bizPath)

# 1. Raw string scanner as immediate fallback
function Search-RawBinary($filePath, $pattern) {
    try {
        $bytes = [System.IO.File]::ReadAllBytes($filePath)
        $textUnicode = [System.Text.Encoding]::Unicode.GetString($bytes)
        $idx = $textUnicode.IndexOf($pattern, [System.StringComparison]::OrdinalIgnoreCase)
        if ($idx -ge 0) {
            $start = [Math]::Max(0, $idx - 60)
            $len = [Math]::Min($textUnicode.Length - $start, 150)
            Write-Host "    [Raw Unicode Match]:" $textUnicode.Substring($start, $len).Replace("`r"," ").Replace("`n"," ")
        }
    } catch {}
}

Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Reflection;
using System.Collections.Generic;

public class PluginWhitelistAnalyzer {
    public static void Analyze(string assemblyPath) {
        Console.WriteLine("\n[+] Inspecting: " + Path.GetFileName(assemblyPath));
        string dir = Path.GetDirectoryName(assemblyPath);
        AppDomain.CurrentDomain.AssemblyResolve += (sender, args) => {
            string name = new AssemblyName(args.Name).Name + ".dll";
            string p = Path.Combine(dir, name);
            if (File.Exists(p)) {
                try { return Assembly.LoadFrom(p); } catch {}
            }
            return null;
        };

        Assembly asm = null;
        try {
            asm = Assembly.LoadFrom(assemblyPath);
        } catch (Exception ex) {
            Console.WriteLine("    Load error: " + ex.Message);
            return;
        }

        Type[] types;
        try {
            types = asm.GetTypes();
        } catch (ReflectionTypeLoadException ex) {
            List<Type> list = new List<Type>();
            foreach (Type t in ex.Types) { if (t != null) list.Add(t); }
            types = list.ToArray();
        }

        foreach (Type t in types) {
            MethodInfo[] methods = t.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Instance | BindingFlags.DeclaredOnly);
            foreach (MethodInfo m in methods) {
                try {
                    MethodBody body = m.GetMethodBody();
                    if (body == null) continue;
                    byte[] il = body.GetILAsByteArray();
                    for (int i = 0; i < il.Length - 4; i++) {
                        if (il[i] == 0x72) {
                            int token = BitConverter.ToInt32(il, i + 1);
                            if ((token & 0xFF000000) == 0x70000000) {
                                try {
                                    string str = asm.ManifestModule.ResolveString(token);
                                    if (str != null && (str.IndexOf("whitelisted", StringComparison.OrdinalIgnoreCase) >= 0 || str.IndexOf("was not loaded", StringComparison.OrdinalIgnoreCase) >= 0)) {
                                        Console.WriteLine("    FOUND in Type: " + t.FullName + ", Method: " + m.Name);
                                        Console.WriteLine("    String: " + str);
                                    }
                                } catch {}
                            }
                        }
                    }
                } catch {}
            }
        }
    }
}
'@

foreach ($path in $assemblies) {
    if (Test-Path $path) {
        Search-RawBinary $path "whitelisted"
        [PluginWhitelistAnalyzer]::Analyze($path)
    }
}

