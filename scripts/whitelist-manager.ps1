# Whitelist Manager for Open Dental
# Reads, decrypts, lists, and whitelists plugins in DatabaseIntegritiesWhiteList
param(
    [string]$InstallDir,
    [string]$PluginToAllow = "LukMetlifeHash.dll",
    [switch]$Apply
)

# Auto-relaunch in 32-bit PowerShell (SysWOW64) for x86 Open Dental assemblies if needed
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

if (-not $InstallDir) {
    Write-Error "Open Dental installation directory not found."
    exit 1
}

Write-Host "Open Dental installation found at: $InstallDir"

# Add C# helper for CDT.Class1 TryDecrypt / TryEncrypt (No external assembly references needed)
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Reflection;
using System.Text;

public class ODWhitelistManager {
    private static Assembly bizAsm;
    private static Assembly cdtAsm;
    private static Type class1Type;
    private static MethodInfo tryDecrypt;
    private static MethodInfo tryEncrypt;

    public static void Init(string dir) {
        AppDomain.CurrentDomain.AssemblyResolve += (sender, args) => {
            string asmName = new AssemblyName(args.Name).Name + ".dll";
            string p = Path.Combine(dir, asmName);
            if (File.Exists(p)) {
                try { return Assembly.LoadFrom(p); } catch {}
            }
            return null;
        };

        bizAsm = Assembly.LoadFrom(Path.Combine(dir, "OpenDentBusiness.dll"));
        cdtAsm = Assembly.LoadFrom(Path.Combine(dir, "CDT.dll"));
        class1Type = cdtAsm.GetType("CDT.Class1");
        tryDecrypt = class1Type.GetMethod("TryDecrypt", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        tryEncrypt = class1Type.GetMethod("TryEncrypt", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
    }

    public static string Decrypt(string cipher) {
        if (string.IsNullOrEmpty(cipher)) return "";
        try {
            object res = tryDecrypt.Invoke(null, new object[] { cipher });
            return res != null ? res.ToString() : "";
        } catch (Exception ex) {
            return "DECRYPT_ERROR: " + (ex.InnerException != null ? ex.InnerException.Message : ex.Message);
        }
    }

    public static string Encrypt(string plain) {
        if (string.IsNullOrEmpty(plain)) return "";
        try {
            object res = tryEncrypt.Invoke(null, new object[] { plain });
            return res != null ? res.ToString() : "";
        } catch (Exception ex) {
            return "ENCRYPT_ERROR: " + (ex.InnerException != null ? ex.InnerException.Message : ex.Message);
        }
    }
}
'@

[ODWhitelistManager]::Init($InstallDir)
Write-Host "CDT.Class1 cryptography engine initialized successfully."

# Parse MariaDB credentials from .env
$dbHost = "127.0.0.1"
$dbPort = "3306"
$dbName = "opendental"
$dbUser = "root"
$dbPass = ""

$envFile = Join-Path $bridgeRoot ".env"
if (Test-Path $envFile) {
    Write-Host "Reading DB credentials from: $envFile"
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

# Also check FreeDentalConfig.xml if password is still empty
if ([string]::IsNullOrEmpty($dbPass)) {
    $cfgCandidates = @(
        (Join-Path $InstallDir "FreeDentalConfig.xml"),
        "C:\OpenDental\FreeDentalConfig.xml",
        "$env:LOCALAPPDATA\Open_Dental_Software\FreeDentalConfig.xml"
    )
    $cfgFile = $cfgCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    if ($cfgFile) {
        try {
            [xml]$cfg = Get-Content -LiteralPath $cfgFile -Raw
            $c = $cfg.ConnectionData
            if ($c.Database) { $dbName = $c.Database }
            if ($c.User) { $dbUser = $c.User }
            if ($c.Password) { $dbPass = $c.Password }
            if ($c.ComputerName) { $dbHost = $c.ComputerName }
        } catch {}
    }
}

Write-Host "Connecting to MariaDB [$dbHost:$dbPort / $dbName as $dbUser]..."

# Try loading MySQL connector from Open Dental directory
$loadedConnector = $false
$connectorDll = Join-Path $InstallDir "MySqlConnector.dll"
if (Test-Path $connectorDll) {
    try {
        Add-Type -Path $connectorDll
        $connStr = "Server=$dbHost;Database=$dbName;Uid=$dbUser;Pwd=$dbPass;Port=$dbPort;CharSet=utf8;"
        $conn = New-Object MySqlConnector.MySqlConnection($connStr)
        $conn.Open()
        $loadedConnector = "MySqlConnector"
    } catch {}
}

if (-not $loadedConnector) {
    $dataDll = Join-Path $InstallDir "MySql.Data.dll"
    if (Test-Path $dataDll) {
        try {
            Add-Type -Path $dataDll
            $connStr = "Server=$dbHost;Database=$dbName;Uid=$dbUser;Pwd=$dbPass;Port=$dbPort;CharSet=utf8;"
            $conn = New-Object MySql.Data.MySqlClient.MySqlConnection($connStr)
            $conn.Open()
            $loadedConnector = "MySql.Data"
        } catch {}
    }
}

function Execute-MariaDbQuery([string]$sqlQuery) {
    if ($loadedConnector) {
        $cmd = $conn.CreateCommand()
        $cmd.CommandText = $sqlQuery
        return [string]$cmd.ExecuteScalar()
    } else {
        # Fallback to mysql.exe CLI
        $mysqlExe = "mysql.exe"
        $cliCandidates = @(
            "C:\Program Files\MariaDB 10.5\bin\mysql.exe",
            "C:\Program Files\MariaDB 10.6\bin\mysql.exe",
            "C:\Program Files\MariaDB 10.11\bin\mysql.exe",
            "C:\Program Files\MySQL\MySQL Server 5.7\bin\mysql.exe"
        )
        foreach ($c in $cliCandidates) {
            if (Test-Path $c) { $mysqlExe = $c; break }
        }
        $passArg = if ($dbPass) { "-p$dbPass" } else { "" }
        $res = & $mysqlExe -h $dbHost -P $dbPort -u $dbUser $passArg -s -N -e "$sqlQuery" $dbName
        return ($res -join "`n")
    }
}

function Execute-MariaDbUpdate([string]$sqlQuery, [string]$paramVal) {
    if ($loadedConnector) {
        $cmd = $conn.CreateCommand()
        $cmd.CommandText = $sqlQuery
        $p = $cmd.Parameters.AddWithValue("@val", $paramVal)
        return $cmd.ExecuteNonQuery()
    } else {
        $tmpFile = [System.IO.Path]::GetTempFileName()
        try {
            # Write SQL file
            $escaped = $paramVal.Replace("\", "\\").Replace("'", "\'")
            $fullSql = "UPDATE preference SET ValueString='$escaped' WHERE PrefName='DatabaseIntegritiesWhiteList';"
            [System.IO.File]::WriteAllText($tmpFile, $fullSql, [System.Text.Encoding]::UTF8)
            $mysqlExe = "mysql.exe"
            $cliCandidates = @(
                "C:\Program Files\MariaDB 10.5\bin\mysql.exe",
                "C:\Program Files\MariaDB 10.6\bin\mysql.exe",
                "C:\Program Files\MariaDB 10.11\bin\mysql.exe",
                "C:\Program Files\MySQL\MySQL Server 5.7\bin\mysql.exe"
            )
            foreach ($c in $cliCandidates) {
                if (Test-Path $c) { $mysqlExe = $c; break }
            }
            $passArg = if ($dbPass) { "-p$dbPass" } else { "" }
            & $mysqlExe -h $dbHost -P $dbPort -u $dbUser $passArg $dbName -e "source $tmpFile"
            return $LASTEXITCODE -eq 0 ? 1 : 0
        } finally {
            if (Test-Path $tmpFile) { Remove-Item -LiteralPath $tmpFile -Force }
        }
    }
}

# 1. Read current DatabaseIntegritiesWhiteList
Write-Host "Reading preference [DatabaseIntegritiesWhiteList]..."
$rawCipher = Execute-MariaDbQuery "SELECT ValueString FROM preference WHERE PrefName='DatabaseIntegritiesWhiteList';"

Write-Host "Encrypted preference length: $($rawCipher.Length)"

$decryptedXml = ""
if (-not [string]::IsNullOrEmpty($rawCipher)) {
    $decryptedXml = [ODWhitelistManager]::Decrypt($rawCipher.Trim())
    Write-Host "`n=== CURRENT DECRYPTED WHITELIST XML ==="
    Write-Host $decryptedXml
    Write-Host "======================================`n"
} else {
    Write-Host "Preference DatabaseIntegritiesWhiteList is empty or not yet set."
}

# 2. Add plugin to whitelist
if ($Apply -or $true) {
    Write-Host "Adding '$PluginToAllow' with Behavior=PluginAllow (11)..."
    
    [xml]$doc = New-Object System.Xml.XmlDocument
    if ([string]::IsNullOrEmpty($decryptedXml) -or -not $decryptedXml.Contains("<ODDataTable")) {
        $decryptedXml = @"
<ODDataTable>
  <Rows>
  </Rows>
</ODDataTable>
"@
    }
    
    $doc.LoadXml($decryptedXml)
    $rowsNode = $doc.SelectSingleNode("//Rows")
    if (-not $rowsNode) {
        $rowsNode = $doc.CreateElement("Rows")
        $doc.DocumentElement.AppendChild($rowsNode) | Out-Null
    }

    # Check if entry already exists
    $existing = $doc.SelectSingleNode("//Row[PluginName='$PluginToAllow']")
    if ($existing) {
        Write-Host "Entry for '$PluginToAllow' exists. Updating Behavior to PluginAllow..."
        $beh = $existing.SelectSingleNode("Behavior")
        if ($beh) { $beh.InnerText = "PluginAllow" } else {
            $newBeh = $doc.CreateElement("Behavior")
            $newBeh.InnerText = "PluginAllow"
            $existing.AppendChild($newBeh) | Out-Null
        }
    } else {
        $newRow = $doc.CreateElement("Row")
        $newRow.InnerXml = @"
  <DatabaseIntegrityNum>999</DatabaseIntegrityNum>
  <WarningIntegrityType>PluginOverride</WarningIntegrityType>
  <PluginName>$PluginToAllow</PluginName>
  <Behavior>PluginAllow</Behavior>
  <Message></Message>
  <Note>LUK MetLife Payment SecurityHash Helper</Note>
"@
        $rowsNode.AppendChild($newRow) | Out-Null
        Write-Host "Added new Row for '$PluginToAllow'."
    }

    $updatedXml = $doc.OuterXml
    $newCipher = [ODWhitelistManager]::Encrypt($updatedXml)
    
    Write-Host "Encrypting new whitelist XML (length: $($newCipher.Length))..."
    $affected = Execute-MariaDbUpdate "UPDATE preference SET ValueString=@val WHERE PrefName='DatabaseIntegritiesWhiteList';" $newCipher
    Write-Host "MariaDB preference updated successfully! (Result: $affected)"

    # Verify decryption
    $verifyCipher = Execute-MariaDbQuery "SELECT ValueString FROM preference WHERE PrefName='DatabaseIntegritiesWhiteList';"
    $verifyXml = [ODWhitelistManager]::Decrypt($verifyCipher.Trim())
    if ($verifyXml.Contains($PluginToAllow)) {
        Write-Host "`n>>> VERIFICATION SUCCESS: '$PluginToAllow' is confirmed whitelisted in MariaDB!"
    } else {
        Write-Host "`n>>> WARNING: Verification did not find '$PluginToAllow' in decrypted preference."
    }
}

if ($conn) {
    try { $conn.Close() } catch {}
}

Write-Host "`n=== Whitelist Configuration Completed ==="
