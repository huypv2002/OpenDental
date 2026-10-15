function ListKey([string]$value){return ($value -replace '\s*,\s*',',').Trim().ToUpperInvariant()}
function TemplateClick($scope,[string]$name,$main){
 AssertFocus $main;$r=$scope.Current.BoundingRectangle
 $b=[System.Drawing.Bitmap]::new([int]$r.Width,[int]$r.Height);$g=[System.Drawing.Graphics]::FromImage($b);$tpl=$null
 try{
  $g.CopyFromScreen([int]$r.Left,[int]$r.Top,0,0,$b.Size);$tpl=[System.Drawing.Bitmap]::new((Join-Path $PSScriptRoot $name));$point=[OdNative]::Locate($b,$tpl)
  PointClick ($r.Left+$point.X) ($r.Top+$point.Y) $main
 }finally{if($tpl){$tpl.Dispose()};$g.Dispose();$b.Dispose()}
}
function NestedEdit($dialog,[string]$id){
 $parent=ById $dialog $id
 if($parent.Current.ControlType -eq [System.Windows.Automation.ControlType]::Edit){return $parent}
 $children=@(Elements $parent|Where-Object{$_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Edit -and -not $_.Current.IsOffscreen})
 if($children.Count -ne 1){throw "Editable field is not unique: $id"};return $children[0]
}
function WaitOnly($main,[string]$id){
 for($i=0;$i -lt 50;$i++){
  $windows=@(Modals $main);$found=@($windows|Where-Object{$_.Current.AutomationId -ceq $id -and $_.Current.IsEnabled})
  if($found.Count -eq 1){return $found[0]}
  $unexpected=@($windows|Where-Object{$_.Current.IsEnabled -and $_.Current.AutomationId -cne $id})
  if($unexpected.Count -gt 0){throw ('Unexpected dialog: '+$unexpected[0].Current.Name)}
  Start-Sleep -Milliseconds 100
 };throw "Dialog did not become active: $id"
}
function EnsurePatient($main,$draft){
 $wanted=[string]$draft.patNum
 if([regex]::Match($main.Current.Name,'-\s*(\d+)\s*$').Groups[1].Value -ceq $wanted){return}
 if(@(Modals $main).Count -gt 0){throw 'Close existing OD dialogs before selecting patient'}
 $toolbars=@(Elements $main|Where-Object{$_.Current.AutomationId -ceq 'ToolBarMain' -and -not $_.Current.IsOffscreen -and $_.Current.BoundingRectangle.Width -gt $main.Current.BoundingRectangle.Width*0.8})
 if($toolbars.Count -ne 1){throw 'Main patient toolbar is not unique'}
 TemplateClick $toolbars[0] 'select-patient-r5.png' $main
 $select=WaitOnly $main 'FormPatientSelect'
 # Clear residual filters, then search by exact verified PatNum.
 $inputs=@(Elements $select|Where-Object{$_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Edit -and -not $_.Current.IsOffscreen})
 foreach($input in $inputs){$input.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue('')}
 $field=NestedEdit $select 'textPatNum';$field.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue($wanted)
 if((ReadValue $field) -cne $wanted){throw 'Patient ID field readback failed'}
 $grid=ById $select 'gridMain';$hit=$null
 for($i=0;$i -lt 40;$i++){
  $cells=@(Elements $grid|Where-Object{$_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Text -and $_.Current.Name -ceq $wanted -and -not $_.Current.IsOffscreen})
  if($cells.Count -eq 1){$hit=$cells[0];break};Start-Sleep -Milliseconds 150
 }
 if($null -eq $hit){throw 'Exact PatNum row not uniquely exposed in patient search'}
 $r=$hit.Current.BoundingRectangle;PointClick ($r.Left+$r.Width/2) ($r.Top+$r.Height/2) $main
 Click (ById $select 'butOK') $main
 for($i=0;$i -lt 40;$i++){
  if(@(Modals $main).Count -eq 0 -and [regex]::Match($main.Current.Name,'-\s*(\d+)\s*$').Groups[1].Value -ceq $wanted){return}
  Start-Sleep -Milliseconds 150
 };throw 'OD title does not confirm selected PatNum'
}
function SetListExact($list,[string]$wanted,$main){
 AssertFocus $main
 $items=@(Elements $list|Where-Object{(ListKey $_.Current.Name) -ceq (ListKey $wanted) -and $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::ListItem -and -not $_.Current.IsOffscreen})
 if($items.Count -eq 1){
  $pattern=$null
  if($items[0].TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern,[ref]$pattern)){$pattern.Select();if($pattern.Current.IsSelected){return}}
 }
 # Owner-drawn list: scan its visible text while scrolling; verify highlighted text after clicking.
 $seen=@{}
 for($attempt=0;$attempt -lt 35;$attempt++){
  AssertFocus $main;$lines=@(OcrControl $list $main);$matches=@($lines|Where-Object{(ListKey $_.text) -ceq (ListKey $wanted)})
  if($matches.Count -gt 1){throw 'List value is ambiguous'}
  if($matches.Count -eq 1){
   $line=$matches[0];PointClick ($line.x+$line.width/2) ($line.y+$line.height/2) $main
   Start-Sleep -Milliseconds 150
   if((ListKey (SelectedText $list $main)) -cne (ListKey $wanted)){throw 'Selected list text does not match requested value'}
   return
  }
  $signature=($lines|ForEach-Object{$_.text}) -join '|'
  if($seen.ContainsKey($signature)){throw "List item not found: $wanted"};$seen[$signature]=$true
  $list.SetFocus();AssertFocus $main
  if($attempt -eq 0){[System.Windows.Forms.SendKeys]::SendWait('{HOME}')}else{[System.Windows.Forms.SendKeys]::SendWait('{PGDN}')}
  Start-Sleep -Milliseconds 100
 };throw 'List navigation limit reached'
}
function DateEquals([string]$actual,[string]$iso){
 $d=[DateTime]::MinValue
 if(-not [DateTime]::TryParse($actual,[Globalization.CultureInfo]::GetCultureInfo('en-US'),[Globalization.DateTimeStyles]::None,[ref]$d)){return $false}
 return $d.ToString('yyyy-MM-dd') -ceq $iso
}
function FindProcedureRow($picker,$split,$main){
 $grid=ById $picker 'gridMain';$seen=@{}
 $date=[DateTime]::ParseExact([string]$split.date,'yyyy-MM-dd',[Globalization.CultureInfo]::InvariantCulture)
 for($page=0;$page -lt 40;$page++){
  $lines=@(OcrRows $grid $main)
  $headerWords=@($lines|Where-Object{$_.text -match '\bDate\b' -and $_.text -match '\bCode\b'}|ForEach-Object{$_.words})
  $toothHeaders=@($headerWords|Where-Object{$_.text -ceq 'Tooth'})
  $codeHeaders=@($headerWords|Where-Object{$_.text -ceq 'Code'})
  $provHeaders=@($headerWords|Where-Object{$_.text -ceq 'Prov'})
  if($toothHeaders.Count -ne 1 -or $codeHeaders.Count -ne 1 -or $provHeaders.Count -ne 1){throw 'Could not identify Tooth column boundaries'}
  # FormProcSelect reference layout: Prov/Code 55px, Tooth 40px. Infer display scale from header centres.
  $scale=(($codeHeaders[0].x+$codeHeaders[0].width/2)-($provHeaders[0].x+$provHeaders[0].width/2))/55
  if($scale -lt 0.7 -or $scale -gt 2.5){throw 'Unsupported procedure column layout'}
  $toothCenter=$toothHeaders[0].x+$toothHeaders[0].width/2
  $toothLeft=$toothCenter-20*$scale;$toothRight=$toothCenter+20*$scale
  $matches=@($lines|Where-Object{
   $text=$_.text
   $codeOK=$text -match ('(?<![A-Z0-9])'+[regex]::Escape([string]$split.code)+'(?![A-Z0-9])')
   $dates=[regex]::Matches($text,'\b\d{1,2}[-/]\d{1,2}[-/]\d{2,4}\b')
   $dateOK=@($dates|Where-Object{DateEquals $_.Value ([string]$split.date)}).Count -eq 1
   $provOK=$text -match ('(?<![A-Z0-9])'+[regex]::Escape([string]$split.providerAbbr)+'(?![A-Z0-9])')
   $toothText=(@($_.words|Where-Object{($_.x+$_.width/2) -ge $toothLeft -and ($_.x+$_.width/2) -lt $toothRight}|ForEach-Object{$_.text}) -join '').Trim()
   $toothOK=$toothText -ceq [string]$split.tooth
   $codeOK -and $dateOK -and $provOK -and $toothOK
  })
  if($matches.Count -gt 1){throw 'Procedure row has multiple OCR matches'}
  if($matches.Count -eq 1){return $matches[0]}
  $signature=($lines|ForEach-Object{$_.text}) -join '|';if($seen.ContainsKey($signature)){throw "Procedure not visible: $($split.code) $($split.date)"};$seen[$signature]=$true
  $r=$grid.Current.BoundingRectangle
  # Scroll within the grid only; never select an unverified row to advance.
  PointClick ($r.Right-8) ($r.Bottom-22) $main
  Start-Sleep -Milliseconds 100
 };throw 'Procedure search limit reached'
}
function BuildSplits($payment,$draft,$main){
 if(@($draft.splits).Count -eq 0){throw 'No verified allocation plan'}
 foreach($s in $draft.splits){if(-not $s.providerAbbr -or -not $s.description -or -not $s.ProcNum){throw 'Allocation needs procedure/provider metadata from SERVER'}}
 # This is only the newly opened preview, never an existing payment editor.
 Click (ById $payment 'butClear') $main
 Start-Sleep -Milliseconds 200
 if([decimal](ReadValue (ById $payment 'textSplitTotal')) -ne 0){throw 'New draft splits were not cleared'}
 foreach($split in $draft.splits){
  AssertFocus $main
  Click (ById $payment 'butAddManual') $main
  $edit=WaitOnly $main 'FormPaySplitEdit'
  SetListExact (ById $edit 'listPatient') ([string]$draft.splitPatientName) $main
  $payDate=[DateTime]::ParseExact([string]$draft.date,'yyyy-MM-dd',[Globalization.CultureInfo]::InvariantCulture).ToString('MM-dd-yyyy')
  SetValue $edit 'textDatePay' $payDate $main
  SetValue $edit 'textAmount' ([decimal]$split.amountCents/100).ToString('F2',[Globalization.CultureInfo]::InvariantCulture) $main
  Click (ById $edit 'butAttachProc') $main
  $picker=WaitOnly $main 'FormProcSelect'
  $row=FindProcedureRow $picker $split $main
  PointClick ($row.x+$row.width/2) ($row.y+$row.height/2) $main
  Click (ById $picker 'butOK') $main
  $edit=WaitOnly $main 'FormPaySplitEdit'
  if(-not (DateEquals (ReadValue (ById $edit 'textProcDate')) ([string]$split.date))){throw 'Attached procedure date mismatch'}
  if((ReadValue (ById $edit 'textProcDescription')).Trim() -ine ([string]$split.description).Trim()){throw 'Attached procedure description mismatch'}
  if((ReadValue (ById $edit 'textProcTooth')).Trim() -ine ([string]$split.tooth).Trim()){throw 'Attached tooth mismatch'}
  if((ReadValue (ById $edit 'textProcProv')).Trim() -ine ([string]$split.providerAbbr).Trim()){throw 'Attached provider mismatch'}
  # Attaching a completed procedure is expected to remove Prepayment. Verify visible combo text.
  $unearned=@(OcrControl (ById $edit 'comboUnearnedTypes') $main)
  if((($unearned|ForEach-Object{$_.text}) -join ' ') -notmatch '^\s*(None|\(none\))\s*$'){throw 'Attached split still has an unverified Unearned Type'}
  SetValue $edit 'textAmount' ([decimal]$split.amountCents/100).ToString('F2',[Globalization.CultureInfo]::InvariantCulture) $main
  Click (ById $edit 'butSave') $main
  $payment=WaitOnly $main 'FormPayment'
 }
 if([decimal](ReadValue (ById $payment 'textSplitTotal')) -ne [decimal]$draft.amount){throw 'Split total differs from payment amount'}
}
function AssertPayment($payment,$draft,$main){
 if([regex]::Match($main.Current.Name,'-\s*(\d+)\s*$').Groups[1].Value -cne [string]$draft.patNum){throw 'Patient changed before Save'}
 if([decimal](ReadValue (ById $payment 'textAmount')) -ne [decimal]$draft.amount){throw 'Amount changed before Save'}
 if(-not (DateEquals (ReadValue (ById $payment 'textDate')) ([string]$draft.date))){throw 'Payment date changed before Save'}
 if((ReadValue (ById $payment 'textCheckNum')) -cne [string]$draft.checkNum){throw 'Trace changed before Save'}
 if((ReadValue (ById $payment 'textNote')) -cne [string]$draft.note){throw 'Note changed before Save'}
 if([decimal](ReadValue (ById $payment 'textSplitTotal')) -ne [decimal]$draft.amount){throw 'Split total changed before Save'}
 if((SelectedText (ById $payment 'listPayType') $main).Trim() -ine ([string]$draft.paymentType).Trim()){throw 'Payment Type readback mismatch before Save'}
}
function VerifySplits($payment,$draft,$main){
 $grid=ById $payment 'gridSplits'
 $all=@(OcrRows $grid $main)
 $rows=@($all|Where-Object{$_.text -match '(?<![A-Z0-9])D\d{4}(?![A-Z0-9])'})
 # No guessed scrolling in the final verification: all planned rows must be visible.
 if($rows.Count -ne @($draft.splits).Count){throw 'Cannot verify all split rows before Save'}
 foreach($split in $draft.splits){
  $amount=([decimal]$split.amountCents/100).ToString('F2',[Globalization.CultureInfo]::InvariantCulture)
  $matches=@($rows|Where-Object{$_.text -match ('(?<![A-Z0-9])'+[regex]::Escape([string]$split.code)+'(?![A-Z0-9])') -and $_.text -match [regex]::Escape([string]$split.providerAbbr) -and $_.text.Replace(',','') -match ([regex]::Escape($amount)+'\s*$')})
  if($matches.Count -ne 1){throw 'Final split row match is ambiguous'}
  $row=$matches[0];PointClick ($row.x+$row.width/2) ($row.y+$row.height/2) $main 2
  $edit=WaitOnly $main 'FormPaySplitEdit'
  if(-not (DateEquals (ReadValue (ById $edit 'textDatePay')) ([string]$draft.date))){throw 'Split payment date changed'}
  if([decimal](ReadValue (ById $edit 'textAmount')) -ne [decimal]$split.amountCents/100){throw 'Split amount changed'}
  if(-not (DateEquals (ReadValue (ById $edit 'textProcDate')) ([string]$split.date))){throw 'Split procedure date changed'}
  if((ReadValue (ById $edit 'textProcDescription')).Trim() -ine ([string]$split.description).Trim()){throw 'Split procedure changed'}
  if((ReadValue (ById $edit 'textProcTooth')).Trim() -ine ([string]$split.tooth).Trim()){throw 'Split tooth changed'}
  if((ReadValue (ById $edit 'textProcProv')).Trim() -ine ([string]$split.providerAbbr).Trim()){throw 'Split provider changed'}
  if((ListKey (SelectedText (ById $edit 'listPatient') $main)) -cne (ListKey ([string]$draft.splitPatientName))){throw 'Split patient changed'}
  $unearned=@(OcrControl (ById $edit 'comboUnearnedTypes') $main)
  if((($unearned|ForEach-Object{$_.text}) -join ' ') -notmatch '^\s*(None|\(none\))\s*$'){throw 'Split Unearned Type changed'}
  CloseWindow $edit
  $payment=WaitOnly $main 'FormPayment'
 }
}
