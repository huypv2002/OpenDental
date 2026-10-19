# Disassemble CDT.Class1.VerifyCallingAssembly
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

Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Reflection;
using System.Collections.Generic;

public class VerifyDisassembler {
    public static void Inspect(string dir) {
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
        MethodInfo verifyMethod = class1Type.GetMethod("VerifyCallingAssembly", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);

        if (verifyMethod == null) {
            Console.WriteLine("VerifyCallingAssembly not found.");
            return;
        }

        Console.WriteLine("\n>>> DISASSEMBLING: CDT.Class1.VerifyCallingAssembly");
        MethodBody body = verifyMethod.GetMethodBody();
        byte[] il = body.GetILAsByteArray();
        for (int i = 0; i < il.Length - 4; i++) {
            byte op = il[i];
            if (op == 0x72) {
                int tok = BitConverter.ToInt32(il, i + 1);
                try {
                    string s = cdtAsm.ManifestModule.ResolveString(tok);
                    Console.WriteLine("    [String]: " + s);
                } catch {}
            } else if (op == 0x28 || op == 0x6F) {
                int tok = BitConverter.ToInt32(il, i + 1);
                try {
                    MethodBase mb = cdtAsm.ManifestModule.ResolveMethod(tok);
                    Console.WriteLine("    [Call]: " + (mb.DeclaringType != null ? mb.DeclaringType.Name : "") + "." + mb.Name);
                } catch {}
            }
        }
    }
}
'@

[VerifyDisassembler]::Inspect($InstallDir)
