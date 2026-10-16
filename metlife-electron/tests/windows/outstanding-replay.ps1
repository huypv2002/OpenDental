# Anonymized real R5 OCR replay: dot/comma delimiter plus degraded isolated dates.
if(-not $ReplayPath){$ReplayPath=[IO.Path]::Combine($PSScriptRoot,'fixtures/outstanding-read-replay.json')}
function ReplayMap($value){
 if($null -eq $value){return $null}
 if($value -is [Management.Automation.PSCustomObject]){
  $map=@{};foreach($property in $value.psobject.Properties){$map[$property.Name]=ReplayMap $property.Value};return $map
 }
 if($value -is [array]){return ,@($value|ForEach-Object{ReplayMap $_})}
 return $value
}
$replay=ReplayMap ([IO.File]::ReadAllText($ReplayPath)|ConvertFrom-Json)
$script:odOutstandingRead=@{}
$script:replayRows=@(ChargeRowsFromLines $replay.rawLines $replay.geometry.edges)
$script:replayAttempts=$replay.columnAttempts
if($script:replayRows.Count -ne 8){throw 'R5 replay did not parse all eight actual row positions'}
foreach($name in @('TEST, PERSON','test. person','TEST.PERSON')){
 if(-not (ChargePatientEquals $name 'TEST, PERSON')){throw ('Known OD surname delimiter rejected: '+$name)}
}
foreach($name in @('TEST, OTHER','OTHER, PERSON','TESX. PERSON','PERSON','TEST PERSON','TEST..PERSON','TEST, PERSON A')){
 if(ChargePatientEquals $name 'TEST, PERSON'){throw ('Different/incomplete patient accepted: '+$name)}
}
$replayDraft=@{splitPatientName='TEST, PERSON';amount='439.20';splits=@(
 @{code='D0120';date='2026-09-20';providerAbbr='DOC';tooth='';amountCents=8640},
 @{code='D1208';date='2026-09-20';providerAbbr='DOC';tooth='';amountCents=4500},
 @{code='D1110';date='2026-09-20';providerAbbr='DOC';tooth='';amountCents=10800},
 @{code='D0210';date='2026-09-20';providerAbbr='DOC';tooth='';amountCents=19980}
)}
AssertAllocationPlan $replayDraft
$savedRead=${function:ReadChargeRows};$savedCells=${function:ReadChargeCells}
try{
 function ReadChargeRows($grid,$main){$script:odOutstandingRead.parsedRows=$script:replayRows;return $script:replayRows}
 function ReadChargeCells($grid,$main,[bool]$normalize=$false){
  $attempt=$script:replayAttempts[[int]$normalize]
  $script:odOutstandingRead.columnLines=$attempt.columns
  return $attempt.rows
 }
 $resolved=ResolveChargeTargets $null $replayDraft $null
 if(($resolved.targets|ForEach-Object{$_.split.code}) -join ',' -cne 'D1110,D1208,D0120,D0210'){throw 'R5 real OCR selected wrong procedures'}
 # Force fallback: isolated Date OCR recognizes only the first two dates, neither
 # a planned service. Full-grid row positions/dates must survive this degradation.
 foreach($row in $script:replayRows){if($row.code -ceq 'D0120'){$row.provider='BAD'}}
 $resolved=ResolveChargeTargets $null $replayDraft $null
 if($resolved.rows.Count -ne 8 -or $resolved.targets.Count -ne 4){throw 'R5 fallback lost the six rows with degraded isolated Date OCR'}
 $wrong=@{splitPatientName='TEST, OTHER';splits=$replayDraft.splits}
 $caught=$false;try{ResolveChargeTargets $null $wrong $null}catch{$caught=$true}
 if(-not $caught){throw 'R5 replay accepted another patient'}
 'Actual R5 OCR replay passed: name delimiter, all eight row anchors, four exact allocations, wrong patient rejected.'
}finally{
 ${function:ReadChargeRows}=$savedRead;${function:ReadChargeCells}=$savedCells
}
