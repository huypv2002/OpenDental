# Inspect where Open Dental enforces plugin whitelisting
param(
    [string]$InstallDir
)

if (-not $InstallDir) {
    $candidates = @("${env:ProgramFiles(x86)}\Open Dental", "$env:ProgramFiles\Open Dental", 'C:\Open Dental')
    $InstallDir = $candidates | Where-Object { Test-Path (Join-Path $_ 'OpenDental.exe') } | Select-Object -First 1
}

if (-not $InstallDir) {
    Write-Error "Open Dental installation directory not found."
    exit 1
}

Write-Host "Analyzing Open Dental binaries in: $InstallDir"

$dllPath = Join-Path $InstallDir "OpenDental.exe"
$bizPath = Join-Path $InstallDir "OpenDentBusiness.dll"

$assemblies = @($dllPath, $bizPath)

Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Reflection;
using System.Collections.Generic;

public class PluginWhitelistAnalyzer {
    public static void Analyze(string assemblyPath) {
        Console.WriteLine("\n[+] Inspecting: " + Path.GetFileName(assemblyPath));
        Assembly asm = Assembly.LoadFrom(assemblyPath);
        foreach (Type t in asm.GetTypes()) {
            MethodInfo[] methods = t.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Instance | BindingFlags.DeclaredOnly);
            foreach (MethodInfo m in methods) {
                try {
                    MethodBody body = m.GetMethodBody();
                    if (body == null) continue;
                    byte[] il = body.GetILAsByteArray();
                    // Search for ldstr instructions
                    // In IL, ldstr opcode is 0x72 followed by a 4-byte metadata token (0x70XXXXXX)
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
        [PluginWhitelistAnalyzer]::Analyze($path)
    }
}
