# Select verified Account procedures before opening Payment; OD owns split creation.
function AccountRows($lines){
 $header=@($lines|Where-Object{$_.text -match '\bDate\b' -and $_.text -match '\bPatient\b' -and $_.text -match '\bCode\b'})
 if($header.Count -ne 1){throw ('Cannot identify Account column headers: '+($lines|ConvertTo-Json -Depth 5 -Compress))}
 $columns=@{}
 foreach($name in @('Date','Patient','Prov','Code')){
  $word=@($header[0].words|Where-Object{$_.text -ieq $name})
  if($word.Count -ne 1){throw ('Account column not unique: '+$name+' / '+($header[0]|ConvertTo-Json -Depth 5 -Compress))}
  $columns[$name]=$word[0].x+$word[0].width/2
 }
 $tooth=@($header[0].words|Where-Object{$_.text -match '^(Tth|Th|Tooth)$'})
 if($tooth.Count -ne 1){throw 'Cannot identify Account tooth column'}
 $columns.Tooth=$tooth[0].x+$tooth[0].width/2
 if(-not ($columns.Date -lt $columns.Patient -and $columns.Patient -lt $columns.Prov -and $columns.Prov -lt $columns.Code -and $columns.Code -lt $columns.Tooth)){throw 'Unsupported Account column order'}
 $dateRight=($columns.Date+$columns.Patient)/2
 $patientRight=($columns.Patient+$columns.Prov)/2
 $provRight=($columns.Prov+$columns.Code)/2
 $codeRight=($columns.Code+$columns.Tooth)/2
 $toothRight=$columns.Tooth+($columns.Tooth-$columns.Code)/2
 $rows=@()
 foreach($line in $lines){
  if($line.y -le $header[0].y){continue}
  $cell=@{}
  foreach($name in @('Date','Patient','Prov','Code','Tooth')){$cell[$name]=@()}
  foreach($word in $line.words){
   $center=$word.x+$word.width/2
   if($center -lt $dateRight){$cell.Date+=$word.text}
   elseif($center -lt $patientRight){$cell.Patient+=$word.text}
   elseif($center -lt $provRight){$cell.Prov+=$word.text}
   elseif($center -lt $codeRight){$cell.Code+=$word.text}
   elseif($center -lt $toothRight){$cell.Tooth+=$word.text}
  }
  $date=$cell.Date -join ''
  if($date -notmatch '^\d{1,2}[-/]\d{1,2}[-/]\d{2,4}$'){continue}
  $rows+=@{date=$date;patient=($cell.Patient -join ' ');provider=($cell.Prov -join '');code=($cell.Code -join '');tooth=($cell.Tooth -join '');x=$columns.Code;y=$line.y;height=$line.height}
 }
 return @($rows|Sort-Object y)
}
function MatchAccountRows($rows,$draft){
 $firstName=([string]$draft.patientName -split ',',2)[-1].Trim()
 if(-not $firstName -or @($draft.splits).Count -eq 0){throw 'Missing verified Account selection plan'}
 $targets=@()
 foreach($split in $draft.splits){
  $found=@($rows|Where-Object{
   $_.code -ceq [string]$split.code -and (DateEquals $_.date ([string]$split.date)) -and
   (ListKey $_.patient) -ceq (ListKey $firstName) -and
   (ListKey $_.provider) -ceq (ListKey ([string]$split.providerAbbr)) -and $_.tooth -ceq [string]$split.tooth
  })
  if($found.Count -ne 1){throw ('Account procedure missing or ambiguous: '+$split.code+' / '+$split.date+' / tooth '+$split.tooth+'. Bring the matching service rows into view before retrying.')}
  if(@($targets|Where-Object{$_.y -eq $found[0].y}).Count){throw 'Two planned procedures map to the same Account row'}
  $targets+=$found[0]
 }
 return $targets
}
function SelectAccountProcedures($account,$draft,$main){
 AssertFocus $main
 if([regex]::Match($main.Current.Name,'-\s*(\d+)\s*$').Groups[1].Value -cne [string]$draft.patNum){throw 'Wrong patient before Account selection'}
 $grid=ById $account 'gridAccount'
 $rows=@(AccountRows @(OcrRows $grid $main))
 $targets=@(MatchAccountRows $rows $draft)
 # All planned procedures must be visible and unique before changing any selection.
 PointClick $targets[0].x ($targets[0].y+$targets[0].height/2) $main
 if($targets.Count -gt 1){
  AssertFocus $main
  [OdNative]::keybd_event(17,0,0,[UIntPtr]::Zero)
  try{foreach($row in $targets|Select-Object -Skip 1){PointClick $row.x ($row.y+$row.height/2) $main}}
  finally{[OdNative]::keybd_event(17,0,2,[UIntPtr]::Zero)}
 }
 Start-Sleep -Milliseconds 200
 AssertFocus $main
 $after=@(AccountRows @(OcrRows $grid $main))
 $confirmed=@(MatchAccountRows $after $draft)
 for($i=0;$i -lt $targets.Count;$i++){
  if([Math]::Abs($confirmed[$i].y-$targets[$i].y) -gt 2){throw 'Account rows moved during selection'}
 }
 $rect=$grid.Current.BoundingRectangle
 # Check each row anchor independently: adjacent selected rows may form one colour band.
 # Sampling only body row anchors also excludes OD's blue title/header.
 $selected=@{}
 foreach($row in $after){
  $center=[int]($row.y+$row.height/2)
  $bands=@([OdNative]::SelectedBands([int]$rect.Left,($center-5),[int]$rect.Width,11))
  if($bands.Count -gt 0){$selected[[string]$row.y]=$true}
 }
 if($selected.Count -ne $confirmed.Count){throw 'Account selection includes missing or extra rows; Payment was not opened'}
 foreach($row in $confirmed){if(-not $selected.ContainsKey([string]$row.y)){throw 'Could not verify all Account procedure highlights'}}
}
