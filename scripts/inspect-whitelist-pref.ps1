# Inspect and decrypt DatabaseIntegritiesWhiteList preference from MariaDB
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
        Console.WriteLine("CDT.Class1.TryDecrypt initialized: " + (tryDecrypt != null ? "OK" : "FAILED"));
    }

    public static string Decrypt(string dir, string cipherText) {
        Assembly cdtAsm = Assembly.LoadFrom(Path.Combine(dir, "CDT.dll"));
        Type class1Type = cdtAsm.GetType("CDT.Class1");
        MethodInfo tryDecrypt = class1Type.GetMethod("TryDecrypt", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        object res = tryDecrypt.Invoke(null, new object[] { cipherText });
        return res != null ? res.ToString() : null;
    }
}
'@

[WhitelistDecrypter]::Inspect($InstallDir)

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

# Also check FreeDentalConfig.xml
$cfgCandidates = @(
    (Join-Path $InstallDir "FreeDentalConfig.xml"),
    "C:\OpenDental\FreeDentalConfig.xml",
    "C:\open-dental-bridge\FreeDentalConfig.xml",
    "$env:LOCALAPPDATA\Open_Dental_Software\FreeDentalConfig.xml"
)
$cfgFile = $cfgCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($cfgFile) {
    try {
        [xml]$cfg = Get-Content -LiteralPath $cfgFile -Raw
        $c = $cfg.ConnectionData
        if ($c.Database) { $dbName = $c.Database }
        if ($c.User -and -not $dbUser) { $dbUser = $c.User }
        if ($c.Password -and -not $dbPass) { $dbPass = $c.Password }
        if ($c.ComputerName) { $dbHost = $c.ComputerName }
    } catch {}
}

Write-Host "`nQuerying MariaDB [$($dbHost):$dbPort / $dbName as $dbUser] for preference DatabaseIntegritiesWhiteList..."
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

if (-not $rawPref) {
    Write-Host "Direct query failed. Prompting for password..."
    $rawPref = & $mysqlExe -h $dbHost -P $dbPort -u $dbUser -p -s -N -e "$query" $dbName
}

if ($rawPref) {
    Write-Host "Raw Encrypted Pref Length: $($rawPref.Length)"
    $decrypted = [WhitelistDecrypter]::Decrypt($InstallDir, $rawPref.Trim())
    Write-Host "`n================ DECRYPTED WHITELIST XML ================"
    Write-Host $decrypted
    Write-Host "========================================================`n"
} else {
    Write-Host "Could not retrieve preference DatabaseIntegritiesWhiteList."
}
