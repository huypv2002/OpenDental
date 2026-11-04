# Offline tests. Synthetic XML and an in-memory store; no OD DLL or DB required.
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'whitelist-manager-core.ps1')
$script:passed=0
function Assert($condition,[string]$message) { if (-not $condition) { throw $message } }
function Test([string]$name,[scriptblock]$body) { & $body; $script:passed++; Write-Host "PASS $name" }
function MustThrow([scriptblock]$body) { $threw=$false; try { & $body | Out-Null } catch { $threw=$true }; Assert $threw 'Expected failure' }
$original='<ODDataTable><Meta>preserve me</Meta><Rows><Row><DatabaseIntegrityNum>999</DatabaseIntegrityNum><WarningIntegrityType>PluginOverride</WarningIntegrityType><PluginName>LukMetlifeHash.dll</PluginName><Behavior>PluginAllow</Behavior><Extra>original</Extra></Row></Rows></ODDataTable>'
$target='LukCalendarNavigation.dll'
Test 'preserves existing row and unknown metadata exactly' {
 $plan=New-PluginWhitelistPlan $original $target
 [xml]$before=$original; [xml]$after=$plan.Xml
 Assert ($before.ODDataTable.Rows.Row.OuterXml -ceq $after.ODDataTable.Rows.Row[0].OuterXml) 'Old row changed'
 Assert ($after.ODDataTable.Meta -eq 'preserve me') 'Metadata lost'
 Assert ($plan.NewCount -eq 2) 'Expected two rows'
 Assert ($after.ODDataTable.Rows.Row[1].DatabaseIntegrityNum -eq '1000') 'ID collision'
}
Test 'idempotent and case insensitive name' {
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
# Parse the Windows entry point without executing it.
Test 'Windows entry script parses' {
 $tokens=$null; $errors=$null
 [void][Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'whitelist-manager.ps1'),[ref]$tokens,[ref]$errors)
 Assert ($errors.Count -eq 0) ($errors | Out-String)
}
Write-Host "$script:passed tests passed (offline fixtures; not Windows/OD runtime verification)."
