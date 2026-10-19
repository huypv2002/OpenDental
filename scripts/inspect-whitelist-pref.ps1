# Inspect all methods of CDT.Class1 and test decryption
param(
    [string]$InstallDir
)

if ([IntPtr]::Size -eq 8) {
    $ps32 = Join-Path $env:SystemRoot "SysWOW64\WindowsPowerShell\v1.0\powershell.exe"
    if (Test-Path $ps32) {
        & $ps32 -NoProfile -ExecutionPolicy Bypass -File $MyInvocation.MyCommand.Path @args
        exit $LASTEXITCODE
    }
}

$bridgeRoot = Split-Path $PSScriptRoot -Parent
if (-not $InstallDir) {
    $candidates = @(
        "${env:ProgramFiles(x86)}\Open Dental",
        "$env:ProgramFiles\Open Dental",
        'C:\Open Dental',
        'C:\Program Files (x86)\Open Dental'
    )
    $InstallDir = $candidates | Where-Object { Test-Path (Join-Path $_ 'OpenDentBusiness.dll') } | Select-Object -First 1
}

Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Reflection;
using System.Collections.Generic;

public class CDTExplorer {
    public static void Explore(string dir) {
        AppDomain.CurrentDomain.AssemblyResolve += (sender, args) => {
            string asmName = new AssemblyName(args.Name).Name + ".dll";
            string p = Path.Combine(dir, asmName);
            if (File.Exists(p)) {
                try { return Assembly.LoadFrom(p); } catch {}
            }
            return null;
        };

        Assembly cdtAsm = Assembly.LoadFrom(Path.Combine(dir, "CDT.dll"));
        Type class1Type = cdtAsm.GetType("CDT.Class1");

        Console.WriteLine("\n--- Methods in CDT.Class1 ---");
        foreach (MethodInfo m in class1Type.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Instance)) {
            List<string> pms = new List<string>();
            foreach (var p in m.GetParameters()) {
                pms.Add((p.IsOut ? "out " : "") + p.ParameterType.Name + " " + p.Name);
            }
            Console.WriteLine("  " + m.ReturnType.Name + " " + m.Name + "(" + string.Join(", ", pms.ToArray()) + ")");
        }
    }

    public static string TryDecryptAny(string dir, string cipher) {
        Assembly cdtAsm = Assembly.LoadFrom(Path.Combine(dir, "CDT.dll"));
        Type class1Type = cdtAsm.GetType("CDT.Class1");

        foreach (MethodInfo m in class1Type.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static)) {
            if (m.Name.IndexOf("Decrypt", StringComparison.OrdinalIgnoreCase) >= 0) {
                var pars = m.GetParameters();
                Console.WriteLine("\nAttempting: " + m.Name + " with " + pars.Length + " params...");
                try {
                    if (pars.Length == 1 && pars[0].ParameterType == typeof(string)) {
                        object res = m.Invoke(null, new object[] { cipher });
                        Console.WriteLine("  Returned: " + (res != null ? res.ToString().Substring(0, Math.Min(80, res.ToString().Length)) : "null"));
                        if (res != null && res.ToString().Contains("<")) return res.ToString();
                    } else if (pars.Length == 2 && pars[0].ParameterType == typeof(string)) {
                        object[] args = new object[] { cipher, null };
                        object res = m.Invoke(null, args);
                        Console.WriteLine("  Returned bool: " + res + ", out val: " + (args[1] != null ? args[1].ToString().Substring(0, Math.Min(80, args[1].ToString().Length)) : "null"));
                        if (args[1] != null && args[1].ToString().Contains("<")) return args[1].ToString();
                    }
                } catch (Exception ex) {
                    Console.WriteLine("  Error: " + (ex.InnerException != null ? ex.InnerException.Message : ex.Message));
                }
            }
        }
        return null;
    }
}
'@

[CDTExplorer]::Explore($InstallDir)

# Read credentials from .env
$dbHost = "127.0.0.1"
$dbPort = "3306"
$dbName = "opendental"
$dbUser = "root"
$dbPass = ""

$envFile = Join-Path $bridgeRoot ".env"
if (Test-Path $envFile) {
    Get-Content -LiteralPath $envFile | ForEach-Object {
        $line = $_.Trim()
        if ($line -match '^\s*([^#=]+)\s*=\s*(.*)$') {
            $k = $matches[1].Trim()
            $v = $matches[2].Trim()
            if ($k -eq 'DB_HOST') { $dbHost = $v }
            if ($k -eq 'DB_PORT') { $dbPort = $v }
            if ($k -eq 'DB_NAME') { $dbName = $v }
            if ($k -eq 'DB_USER') { $dbUser = $v }
            if ($k -eq 'DB_PASSWORD') { $dbPass = $v }
        }
    }
}

$mysqlExe = "mysql.exe"
$candidatesSql = @(
    "C:\Program Files\MariaDB 10.5\bin\mysql.exe",
    "C:\Program Files\MariaDB 10.6\bin\mysql.exe",
    "C:\Program Files\MariaDB 10.11\bin\mysql.exe",
    "C:\Program Files\MySQL\MySQL Server 5.7\bin\mysql.exe",
    "C:\Program Files (x86)\MariaDB 10.5\bin\mysql.exe"
)
foreach ($c in $candidatesSql) {
    if (Test-Path $c) { $mysqlExe = $c; break }
}

$passArg = if ($dbPass) { "-p$dbPass" } else { "" }
$query = "SELECT ValueString FROM preference WHERE PrefName='DatabaseIntegritiesWhiteList';"
$rawPref = & $mysqlExe -h $dbHost -P $dbPort -u $dbUser $passArg -s -N -e "$query" $dbName 2>$null

if ($rawPref) {
    Write-Host "`nTesting decryption on preference length $($rawPref.Length)..."
    $xml = [CDTExplorer]::TryDecryptAny($InstallDir, $rawPref.Trim())
    if ($xml) {
        Write-Host "`n================ XML CONTENT DECRYPTED ================"
        Write-Host $xml
        Write-Host "======================================================="
    }
}
