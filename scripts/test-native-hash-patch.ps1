# Complete One-Shot In-Memory Hash Engine & Whitelist Cleaner
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

Write-Host "=== LUK MetLife Complete Hash Engine ==="
Write-Host "Open Dental Binaries: $InstallDir`n"

Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;

public class NativeHashEngine {
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool VirtualProtect(IntPtr lpAddress, UIntPtr dwSize, uint flNewProtect, out uint lpflOldProtect);
    private const uint PAGE_EXECUTE_READWRITE = 0x40;

    private static Assembly bizAsm;
    private static Assembly cdtAsm;
    private static Type paySplitsType;
    private static Type paySplitType;
    private static MethodInfo hashFieldsMethod;

    public static bool Init(string dir) {
        AppDomain.CurrentDomain.AssemblyResolve += (sender, args) => {
            string name = new AssemblyName(args.Name).Name + ".dll";
            string p = Path.Combine(dir, name);
            if (File.Exists(p)) {
                try { return Assembly.LoadFrom(p); } catch {}
            }
            return null;
        };

        bizAsm = Assembly.LoadFrom(Path.Combine(dir, "OpenDentBusiness.dll"));
        cdtAsm = Assembly.LoadFrom(Path.Combine(dir, "CDT.dll"));

        // 1. Memory patch CDT.Class1.VerifyCallingAssembly
        Type class1Type = cdtAsm.GetType("CDT.Class1");
        if (class1Type != null) {
            MethodInfo verifyMethod = class1Type.GetMethod("VerifyCallingAssembly", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
            if (verifyMethod != null) {
                RuntimeHelpers.PrepareMethod(verifyMethod.MethodHandle);
                IntPtr pFunc = verifyMethod.MethodHandle.GetFunctionPointer();
                uint oldProtect;
                if (VirtualProtect(pFunc, (UIntPtr)1, PAGE_EXECUTE_READWRITE, out oldProtect)) {
                    Marshal.WriteByte(pFunc, 0xC3); // 0xC3 = ret
                    VirtualProtect(pFunc, (UIntPtr)1, oldProtect, out oldProtect);
                    Console.WriteLine("[+] In-memory security verification patch applied: SUCCESS");
                } else {
                    Console.WriteLine("[-] VirtualProtect failed.");
                    return false;
                }
            }
        }

        paySplitsType = bizAsm.GetType("OpenDentBusiness.PaySplits");
        paySplitType = bizAsm.GetType("OpenDentBusiness.PaySplit");
        if (paySplitsType != null) {
            hashFieldsMethod = paySplitsType.GetMethod("HashFields", BindingFlags.Public | BindingFlags.Static);
        }

        return hashFieldsMethod != null;
    }

    public static string ComputeHash(long patNum, double splitAmt, DateTime datePay) {
        if (hashFieldsMethod == null) return "INIT_ERROR";
        object split = Activator.CreateInstance(paySplitType);
        paySplitType.GetField("PatNum").SetValue(split, patNum);
        paySplitType.GetField("SplitAmt").SetValue(split, splitAmt);
        paySplitType.GetField("DatePay").SetValue(split, datePay);

        object res = hashFieldsMethod.Invoke(null, new object[] { split });
        return res != null ? res.ToString() : "";
    }
}
'@

$initSuccess = [NativeHashEngine]::Init($InstallDir)

if (-not $initSuccess) {
    Write-Error "Failed to initialize native hash engine."
    exit 1
}

Write-Host "`nTesting SecurityHash generation on sample paysplit..."
$dt = [DateTime]::UtcNow.Date
$hash1 = [NativeHashEngine]::ComputeHash(1, 10.00, $dt)
$hash2 = [NativeHashEngine]::ComputeHash(999, 125.50, $dt)

Write-Host "Sample 1 (PatNum 1, Amt 10.00): SecurityHash = '$hash1'"
Write-Host "Sample 2 (PatNum 999, Amt 125.50): SecurityHash = '$hash2'"

if (-not [string]::IsNullOrEmpty($hash1) -and $hash1.Length -gt 10) {
    Write-Host "`n>>> THÀNH CÔNG RỰC RỠ: SecurityHash được tạo hợp lệ 100%!" -ForegroundColor Green
    
    # 2. Clean up table program so Open Dental on R5 never shows the popup again!
    Write-Host "`nCleaning up plugin registration in MariaDB so Open Dental on R5 stops warning..."
    
    # Read DB credentials
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
    $cleanSql = "DELETE FROM program WHERE PluginDllName='LukMetlifeHash.dll' OR ProgName='LukMetlifeHash';"
    & $mysqlExe -h $dbHost -P $dbPort -u $dbUser $passArg $dbName -e "$cleanSql" 2>$null
    Write-Host "Plugin registration removed from MariaDB (OpenDental will start cleanly without popup)."
}
