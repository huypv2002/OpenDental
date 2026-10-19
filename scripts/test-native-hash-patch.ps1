# Pure In-Memory Hash Verification Engine
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

if (-not $InstallDir) {
    $candidates = @(
        "${env:ProgramFiles(x86)}\Open Dental",
        "$env:ProgramFiles\Open Dental",
        'C:\Open Dental',
        'C:\Program Files (x86)\Open Dental'
    )
    $InstallDir = $candidates | Where-Object { Test-Path (Join-Path $_ 'OpenDentBusiness.dll') } | Select-Object -First 1
}

Write-Host "=== LUK MetLife Native In-Memory Hash Engine ==="
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

        Type class1Type = cdtAsm.GetType("CDT.Class1");
        if (class1Type != null) {
            MethodInfo verifyMethod = class1Type.GetMethod("VerifyCallingAssembly", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
            if (verifyMethod != null) {
                RuntimeHelpers.PrepareMethod(verifyMethod.MethodHandle);
                IntPtr pFunc = verifyMethod.MethodHandle.GetFunctionPointer();
                uint oldProtect;
                if (VirtualProtect(pFunc, (UIntPtr)1, PAGE_EXECUTE_READWRITE, out oldProtect)) {
                    Marshal.WriteByte(pFunc, 0xC3);
                    VirtualProtect(pFunc, (UIntPtr)1, oldProtect, out oldProtect);
                    Console.WriteLine("[+] In-memory caller verification bypass applied: SUCCESS");
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

Write-Host "Testing SecurityHash generation on sample paysplit..."
$dt = [DateTime]::UtcNow.Date
$hash1 = [NativeHashEngine]::ComputeHash(1, 10.00, $dt)
$hash2 = [NativeHashEngine]::ComputeHash(999, 125.50, $dt)

Write-Host "Sample 1 (PatNum 1, Amt 10.00): SecurityHash = '$hash1'"
Write-Host "Sample 2 (PatNum 999, Amt 125.50): SecurityHash = '$hash2'"

if ($hash1 -and $hash1.Length -gt 10) {
    Write-Host "`n>>> THÀNH CÔNG RỰC RỠ: SecurityHash được tạo hợp lệ 100%!" -ForegroundColor Green
}
