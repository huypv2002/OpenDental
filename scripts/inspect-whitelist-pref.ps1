# Inspect and decrypt DatabaseIntegritiesWhiteList preference from MariaDB
param(
    [string]$InstallDir,
    [string]$DbUser = "root",
    [string]$DbPassword = ""
)

if ([IntPtr]::Size -eq 8) {
    $ps32 = Join-Path $env:SystemRoot "SysWOW64\WindowsPowerShell\v1.0\powershell.exe"
    if (Test-Path $ps32) {
        & $ps32 -NoProfile -ExecutionPolicy Bypass -File $MyInvocation.MyCommand.Path @args
        exit $LASTEXITCODE
    }
}

if (-not $InstallDir) {
    $candidates = @("${env:ProgramFiles(x86)}\Open Dental", "$env:ProgramFiles\Open Dental", 'C:\Open Dental')
    $InstallDir = $candidates | Where-Object { Test-Path (Join-Path $_ 'OpenDental.exe') } | Select-Object -First 1
}

Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Reflection;

public class WhitelistDecrypter {
    public static void Inspect(string dir) {
        AppDomain.CurrentDomain.AssemblyResolve += (sender, args) => {
            string asmName = new AssemblyName(args.Name).Name + ".dll";
            string p = Path.Combine(dir, asmName);
            if (File.Exists(p)) {
                try { return Assembly.LoadFrom(p); } catch {}
            }
            return null;
        };

        Assembly bizAsm = Assembly.LoadFrom(Path.Combine(dir, "OpenDentBusiness.dll"));
        Assembly cdtAsm = Assembly.LoadFrom(Path.Combine(dir, "CDT.dll"));
        Type class1Type = cdtAsm.GetType("CDT.Class1");

        MethodInfo tryDecrypt = class1Type.GetMethod("TryDecrypt", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        MethodInfo tryEncrypt = class1Type.GetMethod("TryEncrypt", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);

        Console.WriteLine("CDT.Class1.TryDecrypt: " + (tryDecrypt != null ? "Found" : "Missing"));
        Console.WriteLine("CDT.Class1.TryEncrypt: " + (tryEncrypt != null ? "Found" : "Missing"));
    }

    public static string Decrypt(string dir, string cipherText) {
        Assembly cdtAsm = Assembly.LoadFrom(Path.Combine(dir, "CDT.dll"));
        Type class1Type = cdtAsm.GetType("CDT.Class1");
        MethodInfo tryDecrypt = class1Type.GetMethod("TryDecrypt", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        object res = tryDecrypt.Invoke(null, new object[] { cipherText });
        return res != null ? res.ToString() : null;
    }

    public static string Encrypt(string dir, string plainText) {
        Assembly cdtAsm = Assembly.LoadFrom(Path.Combine(dir, "CDT.dll"));
        Type class1Type = cdtAsm.GetType("CDT.Class1");
        MethodInfo tryEncrypt = class1Type.GetMethod("TryEncrypt", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        object res = tryEncrypt.Invoke(null, new object[] { plainText });
        return res != null ? res.ToString() : null;
    }
}
'@

[WhitelistDecrypter]::Inspect($InstallDir)

# Check mysql / mariadb for preference
Write-Host "`nQuerying MariaDB preference DatabaseIntegritiesWhiteList..."
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

$query = "SELECT ValueString FROM preference WHERE PrefName='DatabaseIntegritiesWhiteList';"
$rawPref = & $mysqlExe -h 127.0.0.1 -P 3306 -u root -s -N -e "$query" opendental 2>$null

if ($LASTEXITCODE -ne 0 -or -not $rawPref) {
    Write-Host "Please provide MariaDB root password if prompted, or verify connection."
} else {
    Write-Host "Raw Encrypted Pref Length: $($rawPref.Length)"
    $decrypted = [WhitelistDecrypter]::Decrypt($InstallDir, $rawPref.Trim())
    Write-Host "`nDecrypted XML Content:"
    Write-Host $decrypted
}
