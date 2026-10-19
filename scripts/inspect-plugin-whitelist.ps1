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

Write-Host "=== Open Dental Plugin Whitelist Deep Decoder ==="
Write-Host "Target Directory: $InstallDir`n"

Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Reflection;
using System.Reflection.Emit;
using System.Text;
using System.Collections;
using System.Collections.Generic;

public class ODILDecoder {
    private static Dictionary<short, OpCode> opCodes = new Dictionary<short, OpCode>();

    static ODILDecoder() {
        foreach (FieldInfo f in typeof(OpCodes).GetFields(BindingFlags.Public | BindingFlags.Static)) {
            if (f.FieldType == typeof(OpCode)) {
                OpCode op = (OpCode)f.GetValue(null);
                opCodes[op.Value] = op;
            }
        }
    }

    public static void Run(string dir) {
        AppDomain.CurrentDomain.AssemblyResolve += (sender, args) => {
            string asmName = new AssemblyName(args.Name).Name + ".dll";
            string p = Path.Combine(dir, asmName);
            if (File.Exists(p)) {
                try { return Assembly.LoadFrom(p); } catch {}
            }
            return null;
        };

        Assembly bizAsm = Assembly.LoadFrom(Path.Combine(dir, "OpenDentBusiness.dll"));
        Assembly wpfAsm = Assembly.LoadFrom(Path.Combine(dir, "WpfControlsOD.dll"));

        // 1. Inspect PrefName enum
        Console.WriteLine("--- Matching PrefName enums in OpenDentBusiness ---");
        Type prefNameType = bizAsm.GetType("OpenDentBusiness.PrefName");
        if (prefNameType != null) {
            foreach (string name in Enum.GetNames(prefNameType)) {
                if (name.IndexOf("Integrity", StringComparison.OrdinalIgnoreCase) >= 0 ||
                    name.IndexOf("Plugin", StringComparison.OrdinalIgnoreCase) >= 0 ||
                    name.IndexOf("White", StringComparison.OrdinalIgnoreCase) >= 0) {
                    Console.WriteLine("  PrefName: " + name + " (Int = " + (int)Enum.Parse(prefNameType, name) + ")");
                }
            }
        }

        // 2. Decode PluginLoader.LoadAllPlugins start
        Type pLoader = wpfAsm.GetType("OpenDental.PluginLoader");
        if (pLoader != null) {
            MethodInfo m = pLoader.GetMethod("LoadAllPlugins", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Instance);
            if (m != null) {
                Console.WriteLine("\n========================================================");
                Console.WriteLine(">>> DECODING: PluginLoader.LoadAllPlugins");
                Console.WriteLine("========================================================");
                DecodeIL(wpfAsm, m, 80);
            }
        }

        // 3. Decode DatabaseIntegrities.IsPluginAllowed
        Type dbInteg = wpfAsm.GetType("OpenDental.DatabaseIntegrities");
        if (dbInteg != null) {
            MethodInfo m = dbInteg.GetMethod("IsPluginAllowed", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Instance);
            if (m != null) {
                Console.WriteLine("\n========================================================");
                Console.WriteLine(">>> DECODING: DatabaseIntegrities.IsPluginAllowed");
                Console.WriteLine("========================================================");
                DecodeIL(wpfAsm, m, 60);
            }

            MethodInfo mRef = dbInteg.GetMethod("RefreshCacheFromPref", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Instance);
            if (mRef != null) {
                Console.WriteLine("\n========================================================");
                Console.WriteLine(">>> DECODING: DatabaseIntegrities.RefreshCacheFromPref");
                Console.WriteLine("========================================================");
                DecodeIL(wpfAsm, mRef, 40);
            }
        }
    }

    private static void DecodeIL(Assembly asm, MethodInfo m, int maxOps) {
        MethodBody body = m.GetMethodBody();
        if (body == null) return;
        byte[] il = body.GetILAsByteArray();
        int offset = 0;
        int count = 0;

        while (offset < il.Length && count < maxOps) {
            int curOffset = offset;
            short opVal = il[offset++];
            if (opVal == 0xFE) {
                opVal = (short)(0xFE00 | il[offset++]);
            }

            OpCode op;
            if (!opCodes.TryGetValue(opVal, out op)) {
                Console.WriteLine("  IL_{0:X4}: Unknown opcode 0x{1:X}", curOffset, opVal);
                continue;
            }

            string operandStr = "";
            switch (op.OperandType) {
                case OperandType.InlineString:
                    int strToken = BitConverter.ToInt32(il, offset);
                    offset += 4;
                    try {
                        operandStr = "\"" + asm.ManifestModule.ResolveString(strToken).Replace("\r"," ").Replace("\n"," ") + "\"";
                    } catch { operandStr = "token 0x" + strToken.ToString("X"); }
                    break;

                case OperandType.InlineMethod:
                case OperandType.InlineField:
                case OperandType.InlineType:
                case OperandType.InlineTok:
                    int tok = BitConverter.ToInt32(il, offset);
                    offset += 4;
                    try {
                        MemberInfo member = asm.ManifestModule.ResolveMember(tok);
                        operandStr = member.DeclaringType.Name + "." + member.Name;
                    } catch { operandStr = "token 0x" + tok.ToString("X"); }
                    break;

                case OperandType.InlineI:
                    int valI = BitConverter.ToInt32(il, offset);
                    offset += 4;
                    operandStr = valI.ToString();
                    break;

                case OperandType.ShortInlineI:
                    sbyte valSi = (sbyte)il[offset++];
                    operandStr = valSi.ToString();
                    break;

                case OperandType.InlineBrTarget:
                    int target = BitConverter.ToInt32(il, offset) + offset + 4;
                    offset += 4;
                    operandStr = "-> IL_" + target.ToString("X4");
                    break;

                case OperandType.ShortInlineBrTarget:
                    int starget = (sbyte)il[offset++] + offset;
                    operandStr = "-> IL_" + starget.ToString("X4");
                    break;

                case OperandType.InlineVar:
                    short varI = BitConverter.ToInt16(il, offset);
                    offset += 2;
                    operandStr = "V_" + varI;
                    break;

                case OperandType.ShortInlineVar:
                    byte svarI = il[offset++];
                    operandStr = "V_" + svarI;
                    break;

                default:
                    break;
            }

            Console.WriteLine("  IL_{0:X4}: {1,-12} {2}", curOffset, op.Name, operandStr);
            count++;
        }
    }
}
'@

[ODILDecoder]::Run($InstallDir)

Write-Host "`n=== Complete ==="
