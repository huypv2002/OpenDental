# Build only the newly opened Payment draft using Outstanding Charges / Add Partials.
function ControlText($control,$main){
 try{$value=(ReadValue $control).Trim();if($value){return $value}}catch{}
 $raw=@(OcrRows $control $main)
 if($raw.Count -eq 1){return [string]$raw[0].text}
 # Exclude the dropdown arrow for the normalized fallback.
 $r=$control.Current.BoundingRectangle
 $caption=[pscustomobject]@{Left=$r.Left;Top=$r.Top;Width=$r.Width-$r.Height;Height=$r.Height}
 return ((@(OcrRows $control $main $caption)|ForEach-Object{$_.text}) -join ' ').Trim()
}
function ProcessPopup($main,[string]$id){
 $windows=@($AE::RootElement.FindAll($TS::Children,$TC))+@(Modals $main)
 $found=@{};foreach($window in $windows){
  if($window.Current.ProcessId -eq $main.Current.ProcessId -and $window.Current.AutomationId -ceq $id -and -not $window.Current.IsOffscreen){$found[[string]$window.Current.NativeWindowHandle]=$window}
 }
 if($found.Count -gt 1){throw ('Popup is ambiguous: '+$id)}
 if($found.Count -eq 1){return @($found.Values)[0]}
 return $null
}
function SetComboExact($payment,[string]$id,[string]$wanted,$main){
 $script:odStage='Chọn '+$id+' / '+$wanted
 $combo=ById $payment $id
 # Always inspect the expanded options, even if the collapsed caption already matches:
 # two family members may have the same first/preferred name.
 Click $combo $main
 $picker=$null
 for($i=0;$i -lt 30;$i++){$picker=ProcessPopup $main 'FormComboPicker';if($picker){break};Start-Sleep -Milliseconds 100}
 if(-not $picker){throw ('OD combo picker not found: '+$id)}
 Start-Sleep -Milliseconds 150
 $lines=@(OcrRows $picker $main)
 # The picker paints the current caption above the actual options. Exclude that band.
 $r=$combo.Current.BoundingRectangle
 $choices=@($lines|Where-Object{$_.y -ge $r.Bottom -and (ListKey $_.text) -ceq (ListKey $wanted)})
 if($choices.Count -eq 0){
  # Windows OCR may omit a short option such as All in a larger popup.
  # Re-read only the options, normalized and enlarged; never infer an unseen option.
  $pr=$picker.Current.BoundingRectangle
  $options=[pscustomobject]@{Left=$pr.Left;Top=$r.Bottom;Width=$pr.Width;Height=$pr.Bottom-$r.Bottom}
  if($options.Height -gt 2){
   $lines=@(OcrRows $picker $main $options)
   $choices=@($lines|Where-Object{(ListKey $_.text) -ceq (ListKey $wanted)})
  }
 }
 if($choices.Count -ne 1){throw ('Combo option missing or ambiguous: '+$id+' / '+$wanted+' / '+(@{combo=$r.ToString();picker=$picker.Current.BoundingRectangle.ToString();rows=$lines}|ConvertTo-Json -Depth 6 -Compress))}
 PointClick ($choices[0].x+$choices[0].width/2) ($choices[0].y+$choices[0].height/2) $main
 Start-Sleep -Milliseconds 200
 if(ProcessPopup $main 'FormComboPicker'){throw ('OD combo picker did not close: '+$id)}
 $actual=ControlText (ById $payment $id) $main
 if(-not $actual){
  Click (ById $payment $id) $main
  $picker=$null
  for($i=0;$i -lt 30;$i++){$picker=ProcessPopup $main 'FormComboPicker';if($picker){break};Start-Sleep -Milliseconds 100}
  if(-not $picker){throw ('Combo caption picker not found: '+$id)}
  Start-Sleep -Milliseconds 150
  $captionRows=@(OcrRows $picker $main|Where-Object{$_.y -lt $r.Bottom})
  if($captionRows.Count -eq 1){$actual=[string]$captionRows[0].text}
  # Clicking the repeated caption dismisses OD's picker without changing its selection.
  PointClick ($r.Left+$r.Width/2) ($r.Top+$r.Height/2) $main
  Start-Sleep -Milliseconds 150
  if(ProcessPopup $main 'FormComboPicker'){throw ('Combo caption picker did not close: '+$id)}
 }
 if((ListKey $actual) -cne (ListKey $wanted)){throw ('Combo selection readback failed: '+$id+' / expected '+$wanted+' / actual '+$actual)}
}
function ChargeHeader($lines){
 $header=@($lines|Where-Object{$_.text -match '\bDate\b' -and $_.text -match '\bPatient\b' -and $_.text -match '\bCode\b'})
 if($header.Count -ne 1){throw ('Cannot identify Outstanding headers: '+($lines|ConvertTo-Json -Depth 5 -Compress))}
 return $header[0]
}
function ChargeRowsFromBorders($lines,$edges){
 $header=ChargeHeader $lines;$cells=@{}
 foreach($name in @('Date','Patient','Prov','Code','Type')){
  $words=@($header.words|Where-Object{$_.text -ieq $name})
  if($words.Count -ne 1){throw ('Outstanding header not unique: '+$name)}
  $center=$words[0].x+$words[0].width/2;$found=@()
  for($i=0;$i -lt $edges.Count-1;$i++){if($center -gt $edges[$i] -and $center -lt $edges[$i+1]){$found+=$i}}
  if($found.Count -ne 1){throw ('Outstanding column boundaries not unique: '+$name)}
  $cells[$name]=$found[0]
 }
 # The OD layout has exactly one tooth cell between Code and Type. Use its
 # physical borders, even when OCR omits the tiny Th/Tth caption entirely.
 $script:odChargeGeometry=@{header=$header;edges=@($edges);cells=$cells.Clone()}
 if($cells.Patient -ne $cells.Date+1 -or $cells.Prov -ne $cells.Patient+1 -or $cells.Code -ne $cells.Prov+1 -or $cells.Type -ne $cells.Code+2){
  throw ('Unsupported Outstanding column geometry: '+($script:odChargeGeometry|ConvertTo-Json -Depth 6 -Compress))
 }
 $cells.Tooth=$cells.Code+1;$script:odChargeGeometry.cells=$cells.Clone();$rows=@()
 foreach($line in $lines){
  if($line.y -le $header.y){continue}
  $values=@{}
  foreach($name in @('Date','Patient','Prov','Code','Tooth')){
   $index=$cells[$name]
   $values[$name]=(@($line.words|Where-Object{
    $cx=$_.x+$_.width/2;$cx -ge $edges[$index] -and $cx -lt $edges[$index+1]
   }|ForEach-Object{$_.text}) -join $(if($name -ceq 'Patient'){' '}else{''})).Trim()
  }
  if($values.Date -notmatch '^\d{1,2}[-/]\d{1,2}[-/]\d{2,4}$'){continue}
  $code=$values.Code.ToUpperInvariant();if($code -cmatch '^0[0-9]{4}$'){$code='D'+$code.Substring(1)}
  $rows+=@{date=$values.Date;patient=$values.Patient;provider=$values.Prov;code=$code;rawCode=$values.Code;tooth=$values.Tooth;x=($edges[$cells.Code]+$edges[$cells.Code+1])/2;y=$line.y;height=$line.height}
 }
 return @($rows|Sort-Object { [double]$_.y })
}
function ChargeRowsFromHeader($lines){
 $header=ChargeHeader $lines
 $type=@($header.words|Where-Object{$_.text -ieq 'Type'})
 $code=@($header.words|Where-Object{$_.text -ieq 'Code'})
 if($type.Count -ne 1 -or $code.Count -ne 1){throw 'Missing unique Code/Type OCR anchors'}
 # OCR may join the two vertical separators to the narrow Tth caption, e.g.
 # ITthl. Accept only a complete known caption plus at most two border glyphs
 # on either side, wholly inside the verified Code-to-Type header gap.
 $tooth=@($header.words|Where-Object{
  $_.text -match '^[Il|]{0,2}(Tth|Th|Tooth)[Il|]{0,2}$' -and
  $_.x -gt $code[0].x+$code[0].width -and $_.x+$_.width -lt $type[0].x
 })
 if($tooth.Count -ne 1){throw 'Missing unique Code/Tooth/Type OCR anchors'}
 $tc=$tooth[0].x+$tooth[0].width/2;$cc=$code[0].x+$code[0].width/2
 if($cc -ge $tc -or $type[0].x -le $tc+($tc-$cc)/2){throw 'Overlapping Code/Tooth/Type OCR anchors'}
 $normalizedHeader=$header.Clone()
 $normalizedHeader.words=@($header.words|ForEach-Object{
  if([object]::ReferenceEquals($_,$tooth[0])){$word=$_.Clone();$word.text='Tth';$word}else{$_}
 })
 $normalizedHeader.text=($normalizedHeader.words|ForEach-Object{$_.text}) -join ' '
 $normalizedLines=@($lines|ForEach-Object{if([object]::ReferenceEquals($_,$header)){$normalizedHeader}else{$_}})
 $rows=@(AccountRows $normalizedLines)
 $script:odChargeGeometry.method='verified-ocr-headers'
 $script:odChargeGeometry.toothCaption=@{raw=$tooth[0].text;normalized='Tth';x=$tooth[0].x;width=$tooth[0].width}
 return $rows
}
function ChargeRowsFromLines($lines,$edges){
 try{return @(ChargeRowsFromBorders $lines $edges)}catch{
  if($_.Exception.Message -notlike 'Unsupported Outstanding column geometry:*' -and $_.Exception.Message -notlike 'Outstanding column boundaries not unique:*'){throw}
  try{return @(ChargeRowsFromHeader $lines)}catch{
   $script:odChargeGeometry.headerFallbackError=$_.Exception.Message
   throw ('Cannot verify Outstanding columns: '+($script:odChargeGeometry|ConvertTo-Json -Depth 6 -Compress))
  }
 }
}
function ShowAllState($control,$main){
 AssertFocus $main;$pattern=$null
 if($control.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern,[ref]$pattern)){
  if($pattern.Current.ToggleState -eq [System.Windows.Automation.ToggleState]::On){return 1}
  if($pattern.Current.ToggleState -eq [System.Windows.Automation.ToggleState]::Off){return 0}
  return -1
 }
 $r=$control.Current.BoundingRectangle
 $bitmap=[Drawing.Bitmap]::new([int]$r.Width,[int]$r.Height);$g=[Drawing.Graphics]::FromImage($bitmap)
 try{$g.CopyFromScreen([int]$r.Left,[int]$r.Top,0,0,$bitmap.Size);return [OdNative]::PaintedCheckState($bitmap)}finally{$g.Dispose();$bitmap.Dispose()}
}
function EnsureShowAllCharges($payment,$main){
 $script:odStage='Tích Show All Charges'
 $control=ById $payment 'checkShowAll';$state=ShowAllState $control $main
 if($state -lt 0){throw 'Cannot verify Show All Charges checkbox state; no toggle was made'}
 if($state -eq 0){Click $control $main;Start-Sleep -Milliseconds 250}
 if((ShowAllState (ById $payment 'checkShowAll') $main) -ne 1){throw 'Show All Charges did not remain checked'}
}
function ReadChargeRows($grid,$main,$lines=$null){
 if($null -eq $lines){$lines=@(OcrRows $grid $main)}
 $script:odOutstandingRead=@{rawLines=@($lines);gridRect=$grid.Current.BoundingRectangle.ToString()}
 $header=ChargeHeader $lines
 $r=$grid.Current.BoundingRectangle
 $missing=@(@('Date','Patient','Prov','Code','Type')|Where-Object{$name=$_;@($header.words|Where-Object{$_.text -ieq $name}).Count -ne 1})
 if($missing.Count){
  $crop=[pscustomobject]@{Left=$r.Left;Top=[Math]::Max($r.Top,$header.y-2);Width=$r.Width;Height=$header.height+4}
  $attempts=@()
  foreach($normalize in @($false,$true)){
   $headerLines=@(OcrRows $grid $main $crop $normalize);$attempts+=@{normalized=$normalize;lines=$headerLines}
   try{$refined=ChargeHeader $headerLines}catch{continue}
   $missing=@(@('Date','Patient','Prov','Code','Type')|Where-Object{$name=$_;@($refined.words|Where-Object{$_.text -ieq $name}).Count -ne 1})
   if($missing.Count){continue}
   $lines=@($lines|ForEach-Object{if([object]::ReferenceEquals($_,$header)){$refined}else{$_}})
   $header=$refined;break
  }
  $script:odOutstandingRead.headerAttempts=$attempts
 }
 $top=[int][Math]::Ceiling([Math]::Max($r.Top,$header.y))
 # Extra title/body padding previously diluted the divider pixels below the
 # detector threshold on the real 10px R5 header. Sample within the caption band.
 $height=[int][Math]::Max(6,[Math]::Floor($header.y+$header.height)-$top)
 $bitmap=[Drawing.Bitmap]::new([int]$r.Width,$height);$graphics=[Drawing.Graphics]::FromImage($bitmap)
 try{
  AssertFocus $main;$graphics.CopyFromScreen([int]$r.Left,$top,0,0,$bitmap.Size)
  $edges=@([OdNative]::HeaderDividers($bitmap)|ForEach-Object{$r.Left+$_})
 }finally{$graphics.Dispose();$bitmap.Dispose()}
 $rows=@(ChargeRowsFromLines $lines $edges)
 $script:odOutstandingRead.parsedRows=$rows
 $script:odOutstandingRead.geometry=$script:odChargeGeometry
 return $rows
}
function ChargePatientEquals([string]$observed,[string]$expected){
 if((ListKey $observed) -ceq (ListKey $expected)){return $true}
 # R5 OCR renders OD's surname/first-name comma as a dot. Permit only that
 # delimiter at its expected position; every letter and initial must still match.
 $parts=$expected -split ',',2
 if($parts.Count -ne 2 -or -not $parts[0].Trim() -or -not $parts[1].Trim()){return $false}
 $pattern='^'+[regex]::Escape($parts[0].Trim())+'\s*[,.]\s*'+[regex]::Escape($parts[1].Trim())+'$'
 return $observed.Trim() -imatch $pattern
}
function MatchChargeRows($rows,$draft){
 if(-not $draft.splitPatientName -or @($draft.splits).Count -eq 0){throw 'Missing verified Outstanding Charges plan'}
 $targets=@()
 foreach($split in $draft.splits){
  $found=@($rows|Where-Object{
   $_.code -ceq [string]$split.code -and (DateEquals $_.date ([string]$split.date)) -and
   (ChargePatientEquals ([string]$_.patient) ([string]$draft.splitPatientName)) -and
   (ListKey $_.provider) -ceq (ListKey ([string]$split.providerAbbr)) -and $_.tooth -ceq [string]$split.tooth
  })
  if($found.Count -ne 1){
   $expected=@{code=$split.code;date=$split.date;patient=$draft.splitPatientName;provider=$split.providerAbbr;tooth=$split.tooth}
   $comparisons=@($rows|ForEach-Object{@{row=$_;matches=@{
    code=($_.code -ceq [string]$split.code);date=(DateEquals $_.date ([string]$split.date));patient=((ChargePatientEquals ([string]$_.patient) ([string]$draft.splitPatientName)));provider=((ListKey $_.provider) -ceq (ListKey ([string]$split.providerAbbr)));tooth=($_.tooth -ceq [string]$split.tooth)
   }}})
   if($script:odOutstandingRead){$script:odOutstandingRead.expected=$expected;$script:odOutstandingRead.comparisons=$comparisons}
   throw ('Outstanding procedure missing or ambiguous: '+$split.code+' / '+$split.date+' / tooth '+$split.tooth+'. Inspect outstanding-read.json; no guessed selection was made.')
  }
  if(@($targets|Where-Object{$_.row.y -eq $found[0].y}).Count){throw 'Two PDF procedures map to one Outstanding row'}
  $targets+=@{row=$found[0];split=$split}
 }
 return @($targets|Sort-Object { [double]$_.row.y })
}
# Read each identity column separately when whole-grid OCR merges text across cells.
# Only verified physical borders are used; a failed exact match never becomes fuzzy.
function ReadChargeCells($grid,$main,[bool]$normalize=$false){
 $geometry=$script:odChargeGeometry
 if($geometry.method -ceq 'verified-ocr-headers'){throw 'Cannot isolate Outstanding cells without physical column borders'}
 $header=$geometry.header;$r=$grid.Current.BoundingRectangle
 $top=[Math]::Ceiling($header.y+$header.height+1)
 $lines=@();$columns=@{}
 foreach($name in @('Date','Patient','Prov','Code','Tooth')){
  $index=$geometry.cells[$name];$left=$geometry.edges[$index]+2;$right=$geometry.edges[$index+1]-2
  $crop=[pscustomobject]@{Left=$left;Top=$top;Width=$right-$left;Height=$r.Bottom-$top}
  if($crop.Width -lt 5 -or $crop.Height -lt 5){throw ('Invalid verified Outstanding column crop: '+$name)}
  # Raw colour preserves fine remote-display glyphs. Column isolation prevents
  # OCR from joining Date/Patient or Code/Tooth into one word.
  $columns[$name]=@(OcrRows $grid $main $crop $normalize)
  $lines+=$columns[$name]
 }
 $rows=@()
 foreach($date in $columns.Date){
  if($date.text -notmatch '^\d{1,2}[-/]\d{1,2}[-/]\d{2,4}$'){continue}
  $cy=$date.y+$date.height/2;$values=@{Date=$date.text};$valid=$true
  foreach($name in @('Patient','Prov','Code','Tooth')){
   $parts=@($columns[$name]|Where-Object{[Math]::Abs(($_.y+$_.height/2)-$cy) -le [Math]::Max(3,$date.height*0.4)})
   if($parts.Count -gt 1){$valid=$false;break}
   $values[$name]=if($parts.Count){$parts[0].text.Trim()}else{''}
  }
  if(-not $valid){continue}
  $code=$values.Code.ToUpperInvariant();if($code -cmatch '^0[0-9]{4}$'){$code='D'+$code.Substring(1)}
  $rows+=@{date=$values.Date;patient=$values.Patient;provider=$values.Prov;code=$code;rawCode=$values.Code;tooth=$values.Tooth;x=($geometry.edges[$geometry.cells.Code]+$geometry.edges[$geometry.cells.Code+1])/2;y=$date.y;height=$date.height}
 }
 $script:odOutstandingRead.columnLines=$columns
 $script:odOutstandingRead.columnRows=$rows
 return $rows
}
function MatchChargeEvidence($rows,$attempts,$draft){
 $targets=@();$evidence=@()
 foreach($split in $draft.splits){
  $found=@()
  foreach($row in $rows){
   $cy=$row.y+$row.height/2;$values=@{};$verified=$true
   $expected=@{Date=[string]$split.date;Patient=[string]$draft.splitPatientName;Prov=[string]$split.providerAbbr;Code=[string]$split.code;Tooth=[string]$split.tooth}
   foreach($name in @('Date','Patient','Prov','Code','Tooth')){
    $observed=@()
    foreach($attempt in $attempts){
     $parts=@($attempt.columns[$name]|Where-Object{[Math]::Abs(($_.y+$_.height/2)-$cy) -le 3})
     if($parts.Count -eq 0 -and $name -ceq 'Tooth'){$observed+=,''}
     elseif($parts.Count -eq 1){$observed+=[string]$parts[0].text.Trim()}
    }
    $exact=@($observed|Where-Object{
     $value=$_
     if($name -ceq 'Code' -and $value -cmatch '^0[0-9]{4}$'){$value='D'+$value.Substring(1)}
     if($name -ceq 'Date'){DateEquals $value $expected[$name]}
     elseif($name -ceq 'Patient'){ChargePatientEquals $value $expected[$name]}
     else{(ListKey $value) -ceq (ListKey $expected[$name])}
    })
    $values[$name]=$observed
    if($exact.Count -eq 0){$verified=$false}
   }
   $evidence+=@{y=$row.y;expected=$expected;observed=$values;matched=$verified}
   if($verified){
    # Every field must have an exact OCR observation in this same physical cell.
    # No spelling substitution (e.g. ooc -> DOC), cross-row join, or dropped check.
    $confirmed=$row.Clone();$confirmed.patient=$expected.Patient;$confirmed.provider=$expected.Prov;$confirmed.code=$expected.Code;$confirmed.tooth=$expected.Tooth
    $found+=@{row=$confirmed;split=$split}
   }
  }
  if($found.Count -ne 1){$script:odOutstandingRead.cellEvidence=$evidence;throw ('Outstanding procedure missing or ambiguous: '+$split.code+' / '+$split.date+' / tooth '+$split.tooth+'. Exact same-cell OCR verification failed; inspect outstanding-read.json.')}
  if(@($targets|Where-Object{$_.row.y -eq $found[0].row.y}).Count){throw 'Two PDF procedures map to one Outstanding row'}
  $targets+=$found[0]
 }
 $script:odOutstandingRead.cellEvidence=$evidence
 return @($targets|Sort-Object { [double]$_.row.y })
}
function ResolveChargeTargets($grid,$draft,$main){
 $rows=@(ReadChargeRows $grid $main);$initialRows=$rows
 try{$targets=@(MatchChargeRows $rows $draft)}catch{
  if($_.Exception.Message -notlike 'Outstanding procedure missing or ambiguous:*'){throw}
  $attempts=@();$matched=$false;$lastError=$_
  foreach($normalize in @($false,$true)){
   $rows=@(ReadChargeCells $grid $main $normalize)
   $attempts+=@{normalized=$normalize;rows=$rows;columns=$script:odOutstandingRead.columnLines}
   try{$targets=@(MatchChargeRows $rows $draft);$matched=$true;break}catch{$lastError=$_}
  }
  $script:odOutstandingRead.columnAttempts=$attempts
  if(-not $matched){
   # The full-grid read already located the visible rows. Do not discard them
   # because isolated Date OCR degrades (the R5 capture lost six of eight dates).
   $columns=@{}
   foreach($name in @('Date','Patient','Prov','Code','Tooth')){
    $field=@{Date='date';Patient='patient';Prov='provider';Code='code';Tooth='tooth'}[$name]
    $columns[$name]=@($initialRows|ForEach-Object{
     if([string]$_[$field]){@{text=[string]$_[$field];y=$_.y;height=$_.height}}
    })
   }
   $rows=@($initialRows);$attempts+=@{source='verified-full-grid-cells';columns=$columns;rows=$rows}
   $script:odOutstandingRead.columnAttempts=$attempts
   $targets=@(MatchChargeEvidence $rows $attempts $draft)
  }
 }
 return @{rows=$rows;targets=$targets}
}
function SelectChargeRows($grid,$draft,$main){
 $resolved=ResolveChargeTargets $grid $draft $main
 $rows=@($resolved.rows);$targets=@($resolved.targets)
 PointClick $targets[0].row.x ($targets[0].row.y+$targets[0].row.height/2) $main
 if($targets.Count -gt 1){
  AssertFocus $main;[OdNative]::keybd_event(17,0,0,[UIntPtr]::Zero)
  try{foreach($target in $targets|Select-Object -Skip 1){PointClick $target.row.x ($target.row.y+$target.row.height/2) $main}}
  finally{[OdNative]::keybd_event(17,0,2,[UIntPtr]::Zero)}
 }
 Start-Sleep -Milliseconds 200
 $resolved=ResolveChargeTargets $grid $draft $main
 $after=@($resolved.rows);$confirmed=@($resolved.targets)
 $rect=$grid.Current.BoundingRectangle;$selected=@{}
 foreach($row in $after){
  $center=[int]($row.y+$row.height/2)
  if(@([OdNative]::SelectedBands([int]$rect.Left,($center-5),[int]$rect.Width,11)).Count){$selected[[string]$row.y]=$true}
 }
 if($selected.Count -ne $confirmed.Count){throw 'Outstanding selection contains missing or extra rows'}
 for($i=0;$i -lt $targets.Count;$i++){
  if([Math]::Abs($targets[$i].row.y-$confirmed[$i].row.y) -gt 2 -or -not $selected.ContainsKey([string]$confirmed[$i].row.y)){throw 'Outstanding highlight readback failed'}
 }
 return $confirmed
}
function AssertAllocationPlan($draft){
 $total=[decimal]0
 if(@($draft.splits).Count -eq 0){throw 'Empty PDF allocation plan'}
 foreach($split in $draft.splits){
  if([string]$split.amountCents -notmatch '^\d+$' -or [decimal]$split.amountCents -le 0){throw 'Invalid PDF split amount'}
  $total+=[decimal]$split.amountCents
 }
 if($total -ne [decimal]$draft.amount*100){throw 'PDF split amounts do not equal Payment Amount'}
}
function ConfirmOverpaidWarning($warning,$main){
 if($warning.Current.Name -cne 'Overpaid Charge Warning' -or $warning.Current.ProcessId -ne $main.Current.ProcessId){throw 'Unrecognized Overpaid Charge Warning window'}
 $expected='One or more Outstanding Charges will be negative. Continue?'
 $elements=@(Elements $warning)
 $message=@($elements|Where-Object{(($_.Current.Name -replace '\s+',' ').Trim()) -ceq $expected})
 if($message.Count -ne 1){throw 'Unrecognized Overpaid Charge Warning message; popup was left open'}
 $buttons=@($elements|Where-Object{$_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and $_.Current.IsEnabled -and -not $_.Current.IsOffscreen})
 $ok=@($buttons|Where-Object{($_.Current.Name -replace '&','').Trim() -ceq 'OK'})
 $cancel=@($buttons|Where-Object{($_.Current.Name -replace '&','').Trim() -ceq 'Cancel'})
 if($ok.Count -ne 1 -or $cancel.Count -ne 1 -or $buttons.Count -ne 2){throw 'Unrecognized Overpaid Charge Warning buttons; popup was left open'}
 Click $ok[0] $main
}
function WaitAfterPartial($main,[string]$nextId){
 $acceptedHandle=$null
 for($i=0;$i -lt 50;$i++){
  AssertFocus $main
  $active=@(Modals $main|Where-Object{$_.Current.IsEnabled})
  if($active.Count -eq 1){
   $window=$active[0]
   if($window.Current.AutomationId -ceq $nextId){return $window}
   if($window.Current.Name -ceq 'Overpaid Charge Warning'){
    $handle=[string]$window.Current.NativeWindowHandle
    if($null -eq $acceptedHandle){ConfirmOverpaidWarning $window $main;$acceptedHandle=$handle}
    elseif($acceptedHandle -cne $handle){throw 'Repeated Overpaid Charge Warning after one amount; popup was left open'}
    Start-Sleep -Milliseconds 100;continue
   }
  }
  if($active.Count -gt 0){throw ('Unexpected dialog after Add Partials: '+(($active|ForEach-Object{$_.Current.Name}) -join ', '))}
  Start-Sleep -Milliseconds 100
 }
 throw ('Add Partials did not advance to '+$nextId)
}
function AllocatePayment($payment,$draft,$main){
 AssertAllocationPlan $draft
 $firstName=([string]$draft.patientName -split ',',2)[-1].Trim()
 if(-not $firstName){throw 'Missing verified patient name'}
 SetComboExact $payment 'comboPatientOutstandingFilter' $firstName $main
 # Prevent hidden rows in the left grid from surviving Delete All unnoticed.
 SetComboExact $payment 'comboPatientPaySplitsFilter' 'All' $main
 SetComboExact $payment 'comboProviderPaySplitsFilter' 'All' $main
 SetComboExact $payment 'comboGroupBy' 'None' $main
 $script:odStage='Delete All Splits của draft'
 Click (ById $payment 'butClear') $main
 Start-Sleep -Milliseconds 300
 $payment=WaitOnly $main 'FormPayment'
 if([decimal](ReadValue (ById $payment 'textSplitTotal')) -ne 0){throw 'Delete All did not clear current draft splits'}
 $remaining=@(OcrRows (ById $payment 'gridSplits') $main)
 if(@($remaining|Where-Object{$_.text -match '\b(D\d{4}|Prepayment|Unearned)\b'}).Count){throw 'Current Payment Splits is not empty after Delete All'}
 EnsureShowAllCharges $payment $main
 $script:odStage='Đọc cột Outstanding Charges'
 $grid=ById $payment 'gridCharges'
 $script:odStage='Chọn dịch vụ Outstanding Charges'
 $targets=@(SelectChargeRows $grid $draft $main)
 $script:odStage='Add Partials'
 Click (ById $payment 'butCreatePartial') $main
 for($index=0;$index -lt $targets.Count;$index++){
  $target=$targets[$index]
  # OD iterates the selected grid rows in display order. Verify every amount dialog's code.
  $prompt=WaitOnly $main 'FormAmountEdit'
  $label=(ById $prompt 'labelText').Current.Name.Trim()
  if($label -cne [string]$target.split.code){throw ('Add Partials prompt does not match verified row: '+$label)}
  $amount=([decimal]$target.split.amountCents/100).ToString('F2',[Globalization.CultureInfo]::InvariantCulture)
  SetValue $prompt 'textAmount' $amount $main
  Click (ById $prompt 'butOK') $main
  Start-Sleep -Milliseconds 150
  # The user authorized this specific OD overpayment confirmation. Confirm once
  # per submitted amount, including the final row, then verify the expected form.
  $nextId=if($index+1 -lt $targets.Count){'FormAmountEdit'}else{'FormPayment'}
  $null=WaitAfterPartial $main $nextId
 }
 $payment=WaitOnly $main 'FormPayment'
 if([decimal](ReadValue (ById $payment 'textSplitTotal')) -ne [decimal]$draft.amount){throw 'Add Partials total does not equal PDF Payment Amount'}
}
