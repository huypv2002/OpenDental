# Whitelist Manager for Open Dental
# Reads, decrypts, lists, and whitelists plugins in DatabaseIntegritiesWhiteList
param(
    [string]$InstallDir,
    [string]$DbHost,
    [string]$DbPort,
    [string]$DbUser,
    [string]$DbPassword,
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

# Add C# helper for CDT.Class1 TryDecrypt / TryEncrypt
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

# 1. Determine DB parameters: First check FreeDentalConfig.xml (handles R5 -> SERVER mapping)
$targetHost = $DbHost
$targetPort = if ($DbPort) { $DbPort } else { "3306" }
$targetName = "opendental"
$targetUser = if ($DbUser) { $DbUser } else { "root" }
$targetPass = $DbPassword

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
        if (-not $targetHost -and $c.ComputerName) { $targetHost = $c.ComputerName }
        if ($c.Database) { $targetName = $c.Database }
        if (-not $DbUser -and $c.User) { $targetUser = $c.User }
        if (-not $targetPass -and $c.Password) { $targetPass = $c.Password }
        Write-Host "Loaded DB configuration from FreeDentalConfig.xml ($cfgFile)"
    } catch {}
}

# 2. If host still empty, check .env
if (-not $targetHost) {
    $envFile = Join-Path $bridgeRoot ".env"
    if (Test-Path $envFile) {
        Get-Content -LiteralPath $envFile | ForEach-Object {
            $line = $_.Trim()
            if ($line -match '^\s*([^#=]+)\s*=\s*(.*)$') {
                $k = $matches[1].Trim()
                $v = $matches[2].Trim()
                if ($k -eq 'DB_HOST' -and -not $targetHost) { $targetHost = $v }
                if ($k -eq 'DB_PORT' -and -not $DbPort) { $targetPort = $v }
                if ($k -eq 'DB_NAME') { $targetName = $v }
                if ($k -eq 'DB_USER' -and -not $DbUser) { $targetUser = $v }
                if ($k -eq 'DB_PASSWORD' -and -not $targetPass) { $targetPass = $v }
            }
        }
    }
}

if (-not $targetHost) { $targetHost = "127.0.0.1" }

Write-Host "Target MariaDB Server: $targetHost:$targetPort (Database: $targetName, User: $targetUser)"
if ($targetHost -ne "127.0.0.1" -and $targetHost -ne "localhost") {
    Write-Host "[NOTE] Connecting from client machine to SERVER MariaDB at $targetHost"
} else {
    Write-Host "[NOTE] Connecting to local MariaDB on SERVER"
}

# Load MySQL Connector
$conn = $null
$loadedConnector = $false
$connectorDll = Join-Path $InstallDir "MySqlConnector.dll"
if (Test-Path $connectorDll) {
    try {
        Add-Type -Path $connectorDll
        $loadedConnector = "MySqlConnector"
    } catch {}
}

if (-not $loadedConnector) {
    $dataDll = Join-Path $InstallDir "MySql.Data.dll"
    if (Test-Path $dataDll) {
        try {
            Add-Type -Path $dataDll
            $loadedConnector = "MySql.Data"
        } catch {}
    }
}

function Connect-MariaDb() {
    if ($loadedConnector -eq "MySqlConnector") {
        $connStr = "Server=$targetHost;Database=$targetName;Uid=$targetUser;Pwd=$targetPass;Port=$targetPort;CharSet=utf8;Connection Timeout=10;"
        $c = New-Object MySqlConnector.MySqlConnection($connStr)
        $c.Open()
        return $c
    } elseif ($loadedConnector -eq "MySql.Data") {
        $connStr = "Server=$targetHost;Database=$targetName;Uid=$targetUser;Pwd=$targetPass;Port=$targetPort;CharSet=utf8;Connection Timeout=10;"
        $c = New-Object MySql.Data.MySqlClient.MySqlConnection($connStr)
        $c.Open()
        return $c
    }
    return $null
}

try {
    $conn = Connect-MariaDb
    Write-Host "Database connected successfully via $loadedConnector!"
} catch {
    Write-Host "Direct connection attempt failed: $($_.Exception.Message)"
    $promptPass = Read-Host "Please enter MariaDB password for user '$targetUser'" -AsSecureString
    $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($promptPass)
    $targetPass = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
    try {
        $conn = Connect-MariaDb
        Write-Host "Database connected successfully!"
    } catch {
        Write-Host "Connection via connector failed. Falling back to mysql.exe CLI..."
    }
}

function Query-PrefVal() {
    if ($conn -and $conn.State -eq 'Open') {
        $cmd = $conn.CreateCommand()
        $cmd.CommandText = "SELECT ValueString FROM preference WHERE PrefName='DatabaseIntegritiesWhiteList';"
        return [string]$cmd.ExecuteScalar()
    } else {
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
        $passArg = if ($targetPass) { "-p$targetPass" } else { "" }
        $res = & $mysqlExe -h $targetHost -P $targetPort -u $targetUser $passArg -s -N -e "SELECT ValueString FROM preference WHERE PrefName='DatabaseIntegritiesWhiteList';" $targetName
        return ($res -join "`n")
    }
}

function Update-PrefVal([string]$cipher) {
    if ($conn -and $conn.State -eq 'Open') {
        $cmd = $conn.CreateCommand()
        $cmd.CommandText = "UPDATE preference SET ValueString=@val WHERE PrefName='DatabaseIntegritiesWhiteList';"
        $p = $cmd.Parameters.AddWithValue("@val", $cipher)
        return $cmd.ExecuteNonQuery()
    } else {
        $tmpFile = [System.IO.Path]::GetTempFileName()
        try {
            $escaped = $cipher.Replace("\", "\\").Replace("'", "\'")
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
            $passArg = if ($targetPass) { "-p$targetPass" } else { "" }
            & $mysqlExe -h $targetHost -P $targetPort -u $targetUser $passArg $targetName -e "source $tmpFile"
            return $LASTEXITCODE -eq 0 ? 1 : 0
        } finally {
            if (Test-Path $tmpFile) { Remove-Item -LiteralPath $tmpFile -Force }
        }
    }
}

# 1. Read current DatabaseIntegritiesWhiteList
Write-Host "`nReading preference [DatabaseIntegritiesWhiteList] from MariaDB..."
$rawCipher = Query-PrefVal

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

$existing = $doc.SelectSingleNode("//Row[PluginName='$PluginToAllow']")
if ($existing) {
    Write-Host "Entry for '$PluginToAllow' exists. Ensuring Behavior is PluginAllow..."
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

Write-Host "Encrypting new whitelist XML (cipher length: $($newCipher.Length))..."
$affected = Update-PrefVal $newCipher
Write-Host "MariaDB preference updated! (Result: $affected)"

# Verify decryption
$verifyCipher = Query-PrefVal
$verifyXml = [ODWhitelistManager]::Decrypt($verifyCipher.Trim())
if ($verifyXml.Contains($PluginToAllow)) {
    Write-Host "`n>>> VERIFICATION SUCCESS: '$PluginToAllow' is confirmed whitelisted in MariaDB!"
} else {
    Write-Host "`n>>> WARNING: Verification did not find '$PluginToAllow' in decrypted preference."
}

if ($conn) {
    try { $conn.Close() } catch {}
}

Write-Host "`n=== Whitelist Configuration Completed ==="
