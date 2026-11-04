# Offline tests. Synthetic XML and an in-memory store; no OD DLL or DB required.
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'whitelist-manager-core.ps1')
$script:passed=0
function Assert($condition,[string]$message) { if (-not $condition) { throw $message } }
function Test([string]$name,[scriptblock]$body) { & $body; $script:passed++; Write-Host "PASS $name" }
function MustThrow([scriptblock]$body) { $threw=$false; try { & $body | Out-Null } catch { $threw=$true }; Assert $threw 'Expected failure' }
$original='<NewDataSet><Table><DatabaseIntegrityNum>999</DatabaseIntegrityNum><WarningIntegrityType>PluginOverride</WarningIntegrityType><PluginName>LukMetlifeHash.dll</PluginName><Behavior>PluginAllow</Behavior><Message/><Note/><Extra>original</Extra></Table></NewDataSet>'
$target='LukCalendarNavigation.dll'
Test 'preserves existing row and unknown metadata exactly' {
 $plan=New-PluginWhitelistPlan $original $target
 [xml]$before=$original; [xml]$after=$plan.Xml
 Assert ($before.NewDataSet.Table.OuterXml -ceq $after.NewDataSet.Table[0].OuterXml) 'Old row changed'
 Assert ($after.NewDataSet.Table[0].Extra -eq 'original') 'Metadata lost'
 Assert ($plan.NewCount -eq 2) 'Expected two rows'
 Assert ($after.NewDataSet.Table[1].DatabaseIntegrityNum -eq '1000') 'ID collision'
}
Test 'accepts Unicode BOM and validates through native callback before any write' {
 $plan=New-PluginWhitelistPlan (([string][char]0xFEFF)+$original) $target
 Assert ($plan.NewCount -eq 2) 'BOM normalization failed'
 MustThrow { Invoke-PluginWhitelistChange -PluginName $target -Apply -ReadValue { $original } -Decrypt { param($v) $v } -ValidateNative { throw 'native rejected' } -CompareExchange { throw 'must not write' } }
}
Test 'idempotent and case insensitive name'  {
 $plan=New-PluginWhitelistPlan $original $target
 $again=New-PluginWhitelistPlan $plan.Xml 'lukcalendarnavigation.DLL'
 Assert (-not $again.Changed) 'Duplicate would be inserted'
}
Test 'rejects failed decryption and unknown XML shapes' {
 foreach ($bad in @('','DECRYPT_ERROR: failure','<Unknown/>','<ODDataTable/>','<ODDataTable><Rows/><Rows/></ODDataTable>','<!DOCTYPE x><ODDataTable><Rows/></ODDataTable>')) {
  MustThrow { New-PluginWhitelistPlan $bad $target }
 }
}
Test 'rejects paths and conflicting target rules' {
 MustThrow { New-PluginWhitelistPlan $original '../test.dll' }
 $plan=New-PluginWhitelistPlan $original $target
 MustThrow { New-PluginWhitelistPlan ($plan.Xml.Replace('<Behavior>PluginAllow</Behavior>','<Behavior>PluginBlock</Behavior>')) $target }
}
function Reset-Store {
 $script:store=$original; $script:writes=0; $script:backups=0
 $script:backupFails=$false; $script:casFails=$false; $script:readbackFails=$false
}
function Run-Workflow([switch]$Apply) {
 Invoke-PluginWhitelistChange -PluginName $target -Apply:$Apply `
 -ReadValue { if ($script:readbackFails -and $script:writes) { return 'concurrently replaced' }; return $script:store } `
 -Decrypt { param($value) if ($value.StartsWith('encrypted:')) { return $value.Substring(10) }; return $value } `
 -Encrypt { param($value) return 'encrypted:'+$value } `
 -SaveBackup { param($old,$new)
  if ($script:backupFails) { throw 'disk full' }
  Assert ($old -ceq $script:store) 'Wrong backup'; $script:backups++; return 'fixture-backup.json'
 } `
 -CompareExchange { param($old,$new)
  Assert ($script:backups -eq 1) 'Write before backup'
  if ($script:casFails) { return 0 }
  Assert ($script:store -ceq $old) 'Concurrent overwrite'
  $script:writes++; $script:store=$new; return 1
 }
}
Test 'default preview performs zero encryption, backups, writes' {
 Reset-Store
 $result=Invoke-PluginWhitelistChange -PluginName $target -ReadValue { $original } -Decrypt { param($v) $v } `
  -Encrypt { throw 'must not encrypt' } -SaveBackup { throw 'must not backup' } -CompareExchange { throw 'must not write' }
 Assert ($result.Status -eq 'preview') 'Wrong preview status'
}
Test 'apply backs up before one write then verifies whole XML; repeat does not write' {
 Reset-Store; $result=Run-Workflow -Apply
 Assert ($result.Status -eq 'applied-and-verified' -and $script:writes -eq 1 -and $script:backups -eq 1) 'Apply failed'
 $again=Run-Workflow -Apply
 Assert ($again.Status -eq 'already-allowed' -and $script:writes -eq 1) 'Repeat wrote'
}
Test 'backup failure blocks any write' {
 Reset-Store; $script:backupFails=$true; MustThrow { Run-Workflow -Apply }
 Assert ($script:writes -eq 0 -and $script:store -ceq $original) 'Write despite backup failure'
}
Test 'concurrent update is rejected' {
 Reset-Store; $script:casFails=$true; MustThrow { Run-Workflow -Apply }
 Assert ($script:writes -eq 0) 'Concurrent overwrite'
}
Test 'readback failure cannot report success or silently roll back' {
 Reset-Store; $script:readbackFails=$true; MustThrow { Run-Workflow -Apply }
 Assert ($script:writes -eq 1 -and $script:backups -eq 1) 'Expected preserved backup and single write'
}
Test 'missing preference or encryption mismatch blocks write' {
 MustThrow { Invoke-PluginWhitelistChange -PluginName $target -Apply -ReadValue { $null } }
 MustThrow { Invoke-PluginWhitelistChange -PluginName $target -Apply -ReadValue { $original } -Decrypt { param($v) $v } -Encrypt { 'bad-roundtrip' } -CompareExchange { throw 'must not write' } }
}
Test 'reads official ConnectionSettings config and ignores ServerConnection' {
 $xml='<ConnectionSettings><DatabaseConnection><ComputerName>SERVER</ComputerName><Database>clinic</Database><User>reader</User><Password>test&amp;;value</Password></DatabaseConnection><ServerConnection><ComputerName>wrong</ComputerName><Database>wrong</Database></ServerConnection></ConnectionSettings>'
 $settings=Read-ODDatabaseConfigXml $xml
 Assert ($settings.Host -eq 'SERVER' -and $settings.Name -eq 'clinic' -and $settings.User -eq 'reader') 'Wrong DB selected'
 Assert ($settings.Password -ceq 'test&;value') 'Password XML decoding changed'
}
Test 'reads legacy direct and namespaced config' {
 foreach ($xml in @('<ConnectionData><ComputerName>SERVER</ComputerName><Database>clinic</Database><User>root</User><Password/></ConnectionData>', '<ConnectionSettings xmlns="urn:test"><DatabaseConnection><ComputerName>SERVER</ComputerName><Database>clinic</Database><User>root</User><Password/></DatabaseConnection></ConnectionSettings>')) {
  $settings=Read-ODDatabaseConfigXml $xml
  Assert ($settings.Host -eq 'SERVER' -and $settings.Password -eq '') 'Config read failed'
 }
}
Test 'rejects ambiguous DB configs and remote-only config' {
 MustThrow { Read-ODDatabaseConfigXml '<ConnectionSettings><DatabaseConnection/><DatabaseConnection/></ConnectionSettings>' }
 MustThrow { Read-ODDatabaseConfigXml '<ConnectionSettings><ServerConnection/></ConnectionSettings>' }
 MustThrow { Read-ODDatabaseConfigXml '<ConnectionData><Database>one</Database><Database>two</Database></ConnectionData>' }
}
Test 'unknown config diagnostics show tags without credential values' {
 try { Read-ODDatabaseConfigXml '<Unexpected><Password>secret-fixture</Password></Unexpected>'; throw 'Expected failure' }
 catch {
  Assert ($_.Exception.Message -like '*Root=Unexpected*child tags=Password*') 'No structural diagnostic'
  Assert ($_.Exception.Message -notlike '*secret-fixture*') 'Secret leaked'
 }
}
Test 'secure password input preserves special characters without output other than the return value' {
 $secure=ConvertTo-SecureString 'fixture;&"special' -AsPlainText -Force
 try {
  $values=@(ConvertFrom-LukSecurePassword $secure)
  Assert ($values.Count -eq 1 -and $values[0] -ceq 'fixture;&"special') 'Password conversion changed or printed data'
 } finally { $secure.Dispose() }
 MustThrow { ConvertFrom-LukSecurePassword $null }
}
# Parse the Windows entry point without executing it.
Test 'Windows entry script parses' {
 $tokens=$null; $errors=$null
 [void][Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'whitelist-manager.ps1'),[ref]$tokens,[ref]$errors)
 Assert ($errors.Count -eq 0) ($errors | Out-String)
}
Write-Host "$script:passed tests passed (offline fixtures; not Windows/OD runtime verification)."
