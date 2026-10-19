# Whitelist Manager for Open Dental
# Reads, decrypts, lists, and whitelists plugins in DatabaseIntegritiesWhiteList
param(
    [string]$InstallDir,
    [string]$PluginToAllow = "LukMetlifeHash.dll",
    [switch]$Apply
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

if (-not $InstallDir) {
    Write-Error "Open Dental installation directory not found."
    exit 1
}

Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Reflection;
using System.Xml;
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
        object res = tryDecrypt.Invoke(null, new object[] { cipher });
        return res != null ? res.ToString() : "";
    }

    public static string Encrypt(string plain) {
        if (string.IsNullOrEmpty(plain)) return "";
        object res = tryEncrypt.Invoke(null, new object[] { plain });
        return res != null ? res.ToString() : "";
    }
}
'@

[ODWhitelistManager]::Init($InstallDir)

# Connect to MariaDB using OpenDental's built-in MySql.Data
$mysqlDll = Join-Path $InstallDir "MySql.Data.dll"
if (Test-Path $mysqlDll) {
    Add-Type -Path $mysqlDll
}

# Find DB config in FreeDentalConfig.xml
$configCandidates = @(
    (Join-Path $InstallDir "FreeDentalConfig.xml"),
    "$env:LOCALAPPDATA\Open_Dental_Software\FreeDentalConfig.xml",
    "C:\OpenDental\FreeDentalConfig.xml"
)
$configFile = $configCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1

$dbServer = "127.0.0.1"
$dbName = "opendental"
$dbUser = "root"
$dbPass = ""

if ($configFile) {
    try {
        [xml]$cfg = Get-Content -LiteralPath $configFile -Raw
        $conn = $cfg.ConnectionData
        if ($conn.ComputerName) { $dbServer = $conn.ComputerName }
        if ($conn.Database) { $dbName = $conn.Database }
        if ($conn.User) { $dbUser = $conn.User }
        if ($conn.Password) { $dbPass = $conn.Password }
    } catch {}
}

Write-Host "Connecting to MariaDB [$dbServer / $dbName as $dbUser]..."

$connStr = "Server=$dbServer;Database=$dbName;Uid=$dbUser;Pwd=$dbPass;Port=3306;CharSet=utf8;"
$dbConn = New-Object MySql.Data.MySqlClient.MySqlConnection($connStr)

try {
    $dbConn.Open()
} catch {
    Write-Host "Direct connection without prompt failed: $($_.Exception.Message)"
    $promptPass = Read-Host "Enter MariaDB root password" -AsSecureString
    $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($promptPass)
    $dbPass = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
    $connStr = "Server=$dbServer;Database=$dbName;Uid=$dbUser;Pwd=$dbPass;Port=3306;CharSet=utf8;"
    $dbConn = New-Object MySql.Data.MySqlClient.MySqlConnection($connStr)
    $dbConn.Open()
}

Write-Host "Database connected successfully!`n"

# 1. Read current DatabaseIntegritiesWhiteList
$cmd = $dbConn.CreateCommand()
$cmd.CommandText = "SELECT ValueString FROM preference WHERE PrefName='DatabaseIntegritiesWhiteList';"
$rawCipher = [string]$cmd.ExecuteScalar()

Write-Host "Preference [DatabaseIntegritiesWhiteList] raw length: $($rawCipher.Length)"

if (-not [string]::IsNullOrEmpty($rawCipher)) {
    $decryptedXml = [ODWhitelistManager]::Decrypt($rawCipher)
    Write-Host "`n=== CURRENT DECRYPTED WHITELIST XML ==="
    Write-Host $decryptedXml
    Write-Host "======================================`n"
} else {
    Write-Host "Preference DatabaseIntegritiesWhiteList is empty or not set."
    $decryptedXml = ""
}

# 2. Add plugin to whitelist if requested
if ($Apply -and $PluginToAllow) {
    Write-Host "Adding '$PluginToAllow' to whitelist with Behavior=PluginAllow (11)..."
    
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
        Write-Host "Entry for '$PluginToAllow' already exists. Updating Behavior to PluginAllow..."
        $beh = $existing.SelectSingleNode("Behavior")
        if ($beh) { $beh.InnerText = "PluginAllow" }
    } else {
        $newRow = $doc.CreateElement("Row")
        $newRow.InnerXml = @"
  <DatabaseIntegrityNum>999</DatabaseIntegrityNum>
  <WarningIntegrityType>PluginOverride</WarningIntegrityType>
  <PluginName>$PluginToAllow</PluginName>
  <Behavior>PluginAllow</Behavior>
  <Message></Message>
  <Note>LUK MetLife SecurityHash Plugin</Note>
"@
        $rowsNode.AppendChild($newRow) | Out-Null
        Write-Host "Added new Row for '$PluginToAllow'."
    }

    $updatedXml = $doc.OuterXml
    $newCipher = [ODWhitelistManager]::Encrypt($updatedXml)
    
    $updateCmd = $dbConn.CreateCommand()
    $updateCmd.CommandText = "UPDATE preference SET ValueString=@val WHERE PrefName='DatabaseIntegritiesWhiteList';"
    $p = $updateCmd.Parameters.Add("@val", [MySql.Data.MySqlClient.MySqlDbType]::LongText)
    $p.Value = $newCipher
    $affected = $updateCmd.ExecuteNonQuery()
    
    Write-Host "`n>>> Successfully updated preference DatabaseIntegritiesWhiteList! Rows affected: $affected"
    Write-Host ">>> Verified encrypted length: $($newCipher.Length)"
}

$dbConn.Close()
Write-Host "`nDone."
