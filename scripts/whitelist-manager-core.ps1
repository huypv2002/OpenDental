# Pure planning and guarded write workflow. No connections are opened here.
function ConvertFrom-LukSecurePassword {
 param([Security.SecureString]$SecurePassword)
 if ($null -eq $SecurePassword) { throw 'Password entry was cancelled; nothing changed.' }
 $pointer=[IntPtr]::Zero
 try {
  $pointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecurePassword)
  return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
 } finally {
  if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
 }
}

function Read-ODDatabaseConfigXml {
 param([string]$Xml)
 $doc=New-Object System.Xml.XmlDocument
 $doc.XmlResolver=$null
 if ($Xml -match '<!DOCTYPE') { throw 'DOCTYPE is not permitted in OD config.' }
 $doc.LoadXml($Xml)
 $root=$doc.DocumentElement
 if ($root.LocalName -notin @('ConnectionSettings','ConnectionData')) {
  $names=@($root.ChildNodes | Where-Object { $_.NodeType -eq [Xml.XmlNodeType]::Element } | ForEach-Object { $_.LocalName })
  throw "Unknown FreeDentalConfig.xml layout. Root=$($root.LocalName); child tags=$($names -join ','). Values omitted."
 }
 $connections=@($root.SelectNodes("*[local-name()='DatabaseConnection']"))
 if ($connections.Count -gt 1) { throw 'Multiple DB connections in config; inspect before choosing a target.' }
 if ($connections.Count -eq 1) { $connection=$connections[0] }
 elseif ($root.LocalName -eq 'ConnectionData') { $connection=$root }
 else { throw 'ConnectionSettings has no DatabaseConnection; no server-connection fallback is used.' }
 $settings=@{}
 foreach ($pair in @(@{Key='Host';Tag='ComputerName'},@{Key='Name';Tag='Database'},@{Key='User';Tag='User'},@{Key='Password';Tag='Password'})) {
  $nodes=@($connection.SelectNodes("*[local-name()='$($pair.Tag)']"))
  if ($nodes.Count -gt 1) { throw "Duplicate $($pair.Tag) config fields; target is ambiguous." }
  if ($nodes.Count -eq 1) { $settings[$pair.Key]=$nodes[0].InnerText }
 }
 $hashes=@($connection.SelectNodes("*[local-name()='MySQLPassHash']"))
 $settings.HasEncryptedPassword=(@($hashes | Where-Object { -not [string]::IsNullOrWhiteSpace($_.InnerText) }).Count -gt 0)
 return $settings
}

function New-PluginWhitelistPlan {
 param([string]$Xml, [string]$PluginName)
 if ($PluginName -notmatch '^[A-Za-z0-9][A-Za-z0-9_.-]*\.dll$') { throw 'Expected a DLL filename, without a directory.' }
 if ([string]::IsNullOrWhiteSpace($Xml)) { throw 'Decryption returned empty XML; no replacement whitelist will be created.' }
 $doc = New-Object System.Xml.XmlDocument
 $doc.PreserveWhitespace = $true
 $doc.XmlResolver = $null
 if ($Xml -match '<!DOCTYPE') { throw 'DOCTYPE is not permitted.' }
 $doc.LoadXml($Xml)
 if ($doc.DocumentElement.Name -ne 'ODDataTable') { throw 'Unknown whitelist XML root. Nothing will be replaced.' }
 $containers = @($doc.SelectNodes('/ODDataTable/Rows'))
 if ($containers.Count -ne 1) { throw 'Expected exactly one Rows container.' }
 $rows = $containers[0]
 $matches = @($rows.SelectNodes('Row') | Where-Object {
  $_.SelectSingleNode('PluginName') -and $_.PluginName -ieq $PluginName
 })
 if ($matches.Count -gt 1) { throw 'Duplicate entries for this DLL; review the existing whitelist.' }
 $count = @($rows.SelectNodes('Row')).Count
 if ($matches.Count -eq 1) {
  $row = $matches[0]
  if ($row.WarningIntegrityType -ne 'PluginOverride' -or $row.Behavior -ne 'PluginAllow') {
   throw 'The DLL already has a conflicting rule. Existing rules were preserved.'
  }
  return [pscustomobject]@{ Changed=$false; Xml=$doc.OuterXml; OriginalCount=$count; NewCount=$count }
 }
 $maxId = [long]0
 foreach ($row in $rows.SelectNodes('Row')) {
  $id = [long]0
  if ([long]::TryParse([string]$row.DatabaseIntegrityNum, [ref]$id) -and $id -gt $maxId) { $maxId = $id }
 }
 if ($maxId -eq [long]::MaxValue) { throw 'Whitelist ID range exhausted.' }
 $newRow = $doc.CreateElement('Row')
 $values = [ordered]@{
  DatabaseIntegrityNum=($maxId+1).ToString([Globalization.CultureInfo]::InvariantCulture)
  WarningIntegrityType='PluginOverride'; PluginName=$PluginName; Behavior='PluginAllow'
  Message=''; Note='Clinic-authorized LUK plugin configuration'
 }
 foreach ($name in $values.Keys) {
  $element = $doc.CreateElement($name); $element.InnerText = $values[$name]
  [void]$newRow.AppendChild($element)
 }
 [void]$rows.AppendChild($newRow)
 return [pscustomobject]@{ Changed=$true; Xml=$doc.OuterXml; OriginalCount=$count; NewCount=($count+1) }
}
function Invoke-PluginWhitelistChange {
 param([string]$PluginName, [switch]$Apply, [scriptblock]$ReadValue,
  [scriptblock]$Decrypt, [scriptblock]$Encrypt, [scriptblock]$SaveBackup, [scriptblock]$CompareExchange)
 $original = & $ReadValue
 if ($null -eq $original -or $original -is [DBNull]) { throw 'Whitelist preference is missing; nothing changed.' }
 $original = [string]$original
 if ($original.Length -eq 0) { $xml = '<ODDataTable><Rows /></ODDataTable>' }
 else { $xml = & $Decrypt $original }
 $plan = New-PluginWhitelistPlan -Xml $xml -PluginName $PluginName
 if (-not $plan.Changed) { return [pscustomobject]@{ Status='already-allowed'; Plan=$plan; BackupPath=$null } }
 if (-not $Apply) { return [pscustomobject]@{ Status='preview'; Plan=$plan; BackupPath=$null } }
 $cipher = & $Encrypt $plan.Xml
 if ([string]::IsNullOrWhiteSpace($cipher) -or $cipher -match '^(ENCRYPT|DECRYPT)_ERROR:') { throw 'Encryption failed; nothing changed.' }
 if ((& $Decrypt $cipher) -cne $plan.Xml) { throw 'Encryption round-trip mismatch; nothing changed.' }
 $backup = & $SaveBackup $original $cipher
 if ([string]::IsNullOrWhiteSpace($backup)) { throw 'Backup was not confirmed; nothing changed.' }
 try {
  $affected = & $CompareExchange $original $cipher
  if ($affected -ne 1) { throw 'Whitelist changed concurrently or update affected an unexpected number of rows.' }
  $actual = & $ReadValue
  if ($actual -cne $cipher) { throw 'Stored encrypted value differs from the intended value.' }
  if ((& $Decrypt $actual) -cne $plan.Xml) { throw 'Stored whitelist XML differs from the complete intended XML.' }
  return [pscustomobject]@{ Status='applied-and-verified'; Plan=$plan; BackupPath=$backup }
 } catch {
  throw "Write/readback did not complete cleanly. Keep backup '$backup' for inspection; no automatic rollback. $($_.Exception.Message)"
 }
}
