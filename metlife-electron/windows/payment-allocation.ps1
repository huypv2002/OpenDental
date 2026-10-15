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
function MatchChargeRows($rows,$draft){
 if(-not $draft.splitPatientName -or @($draft.splits).Count -eq 0){throw 'Missing verified Outstanding Charges plan'}
 $targets=@()
 foreach($split in $draft.splits){
  $found=@($rows|Where-Object{
   $_.code -ceq [string]$split.code -and (DateEquals $_.date ([string]$split.date)) -and
   (ListKey $_.patient) -ceq (ListKey ([string]$draft.splitPatientName)) -and
   (ListKey $_.provider) -ceq (ListKey ([string]$split.providerAbbr)) -and $_.tooth -ceq [string]$split.tooth
  })
  if($found.Count -ne 1){throw ('Outstanding procedure missing or ambiguous: '+$split.code+' / '+$split.date+' / tooth '+$split.tooth+'. Bring the service rows into view; no guessed selection was made.')}
  if(@($targets|Where-Object{$_.row.y -eq $found[0].y}).Count){throw 'Two PDF procedures map to one Outstanding row'}
  $targets+=@{row=$found[0];split=$split}
 }
 return @($targets|Sort-Object { [double]$_.row.y })
}
function SelectChargeRows($grid,$draft,$main){
 $rows=@(AccountRows @(OcrRows $grid $main))
 $targets=@(MatchChargeRows $rows $draft)
 PointClick $targets[0].row.x ($targets[0].row.y+$targets[0].row.height/2) $main
 if($targets.Count -gt 1){
  AssertFocus $main;[OdNative]::keybd_event(17,0,0,[UIntPtr]::Zero)
  try{foreach($target in $targets|Select-Object -Skip 1){PointClick $target.row.x ($target.row.y+$target.row.height/2) $main}}
  finally{[OdNative]::keybd_event(17,0,2,[UIntPtr]::Zero)}
 }
 Start-Sleep -Milliseconds 200
 $after=@(AccountRows @(OcrRows $grid $main));$confirmed=@(MatchChargeRows $after $draft)
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
 $grid=ById $payment 'gridCharges'
 $rows=@(AccountRows @(OcrRows $grid $main))
 try{[void](MatchChargeRows $rows $draft)}catch{
  if($_.Exception.Message -notlike 'Outstanding procedure missing or ambiguous:*'){throw}
  # OD's Show All Charges is custom-painted and may expose no TogglePattern.
  # Toggle once only when required procedures are absent, then require an exact row match.
  # This reveals zero-balance procedures without guessing the checkbox's state.
  Click (ById $payment 'checkShowAll') $main
  Start-Sleep -Milliseconds 300
 }
 $script:odStage='Chọn dịch vụ Outstanding Charges'
 $targets=@(SelectChargeRows $grid $draft $main)
 $script:odStage='Add Partials'
 Click (ById $payment 'butCreatePartial') $main
 foreach($target in $targets){
  # OD iterates the selected grid rows in display order. Verify every amount dialog's code.
  $prompt=WaitOnly $main 'FormAmountEdit'
  $label=(ById $prompt 'labelText').Current.Name.Trim()
  if($label -cne [string]$target.split.code){throw ('Add Partials prompt does not match verified row: '+$label)}
  $amount=([decimal]$target.split.amountCents/100).ToString('F2',[Globalization.CultureInfo]::InvariantCulture)
  SetValue $prompt 'textAmount' $amount $main
  Click (ById $prompt 'butOK') $main
  Start-Sleep -Milliseconds 150
  # Any overpaid-charge warning is deliberately left for the user. WaitOnly refuses it.
 }
 $payment=WaitOnly $main 'FormPayment'
 if([decimal](ReadValue (ById $payment 'textSplitTotal')) -ne [decimal]$draft.amount){throw 'Add Partials total does not equal PDF Payment Amount'}
}
