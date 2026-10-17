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
function PatientSearchHits($lines,[string]$wanted){
 $headers=@($lines|Where-Object{@($_.words|Where-Object{$_.text -ieq 'PatNum'}).Count -eq 1})
 if($headers.Count -ne 1){return @()}
 $header=$headers[0];$idWord=@($header.words|Where-Object{$_.text -ieq 'PatNum'})[0]
 $next=@($header.words|Where-Object{$_.x -gt $idWord.x+$idWord.width}|Sort-Object { [double]$_.x })
 if($next.Count -eq 0){return @()}
 $hits=@()
 foreach($line in $lines){
  if($line.y -le $header.y){continue}
  $ids=@($line.words|Where-Object{$_.text -ceq $wanted -and $_.x+$_.width/2 -ge $idWord.x-8 -and $_.x+$_.width/2 -lt $next[0].x})
  if($ids.Count -eq 1){$hits+=@{x=$ids[0].x+$ids[0].width/2;y=$line.y+$line.height/2}}
 }
 return $hits
}
function EnsureAccount($main,[string]$patNum=''){
 $script:odStage='Mở tab Account'
 AssertFocus $main
 if(@(Modals $main).Count){throw 'Close existing OD dialogs before opening Account'}
 $mr=$main.Current.BoundingRectangle;$desktop=[System.Windows.Forms.SystemInformation]::VirtualScreen
 $rail=[pscustomobject]@{Left=[Math]::Max($mr.Left,$desktop.Left);Top=[Math]::Max($mr.Top,$desktop.Top);Width=[Math]::Min(100,$mr.Width);Height=[Math]::Min(650,$mr.Height)}
 $labels=@(OcrRows $main $main $rail $false|Where-Object{$_.text.Trim() -ieq 'Account'})
 if($labels.Count -eq 1){PointClick ($labels[0].x+$labels[0].width/2) ($labels[0].y+$labels[0].height/2) $main}
 else{
  # Native OD's module rail is owner-drawn. Use the captured Account icon only
  # when its exact label cannot be read; never infer the active module from UIA.
  $bitmap=[Drawing.Bitmap]::new([int]$rail.Width,[int]$rail.Height);$g=[Drawing.Graphics]::FromImage($bitmap);$point=$null
  try{
   $g.CopyFromScreen([int]$rail.Left,[int]$rail.Top,0,0,$bitmap.Size)
   foreach($name in @('account-r5-family-state.png','account-r5-account-state.png')){
    $template=[Drawing.Bitmap]::new((Join-Path $PSScriptRoot $name))
    try{$point=[OdNative]::Locate($bitmap,$template);break}catch{}finally{$template.Dispose()}
   }
  }finally{$g.Dispose();$bitmap.Dispose()}
  if($null -eq $point){throw 'Account navigation image/label not recognized; no click was made'}
  PointClick ($rail.Left+$point.X) ($rail.Top+$point.Y) $main
 }
 for($i=0;$i -lt 30;$i++){
  AssertFocus $main
  if($patNum -and [regex]::Match($main.Current.Name,'-\s*(\d+)\s*$').Groups[1].Value -cne $patNum){throw 'Wrong patient while opening Account'}
  $accounts=@(Elements $main|Where-Object{$_.Current.AutomationId -ceq 'ControlAccount' -and -not $_.Current.IsOffscreen})
  if($accounts.Count -eq 1){
   $bars=@(Elements $accounts[0]|Where-Object{$_.Current.AutomationId -ceq 'ToolBarMain' -and -not $_.Current.IsOffscreen})
   $grids=@(Elements $accounts[0]|Where-Object{$_.Current.AutomationId -ceq 'gridAccount' -and -not $_.Current.IsOffscreen})
   if($bars.Count -eq 1 -and $grids.Count -eq 1 -and $bars[0].Current.BoundingRectangle.Width -gt 20){
    $r=$bars[0].Current.BoundingRectangle
    $crop=[pscustomobject]@{Left=$r.Left;Top=$r.Top;Width=[Math]::Min(160,$r.Width);Height=$r.Height}
    $words=@(OcrRows $bars[0] $main $crop $false|ForEach-Object{$_.words}|Where-Object{$_.text -ieq 'Payment'})
    if($words.Count -eq 1){return $accounts[0]}
   }
  }
  Start-Sleep -Milliseconds 150
 }
 throw 'Account did not become ready with a visible Payment toolbar; no Payment was opened'
}
function PreparePaymentAccount($main,$draft){
 $null=EnsureAccount $main
 EnsurePatient $main $draft
 return EnsureAccount $main ([string]$draft.patNum)
}
function EnsurePatient($main,$draft){
 $script:odStage='Chọn bệnh nhân trong OD'
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
 $search=ById $select 'butSearch'
 for($i=0;$i -lt 20 -and -not $search.Current.IsEnabled;$i++){Start-Sleep -Milliseconds 100;$search=ById $select 'butSearch'}
 Click $search $main
 $grid=ById $select 'gridMain';$hit=$null
 for($i=0;$i -lt 40;$i++){
  $cells=@(Elements $grid|Where-Object{$_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Text -and $_.Current.Name -ceq $wanted -and -not $_.Current.IsOffscreen})
  if($cells.Count -gt 1){throw 'Exact PatNum row is ambiguous in patient search'}
  if($cells.Count -eq 1){$r=$cells[0].Current.BoundingRectangle;$hit=@{x=$r.Left+$r.Width/2;y=$r.Top+$r.Height/2};break}
  $hits=@(PatientSearchHits @(OcrRows $grid $main) $wanted)
  if($hits.Count -gt 1){throw 'Exact PatNum OCR row is ambiguous in patient search'}
  if($hits.Count -eq 1){$hit=$hits[0];break}
  Start-Sleep -Milliseconds 150
 }
 if($null -eq $hit){throw 'Exact PatNum row not uniquely exposed in patient search'}
 PointClick $hit.x $hit.y $main
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
 # OD UI.ListBox is a custom-painted Control: it handles Up/Down, not Home/PageDown.
 # The same viewport can repeat while the selected row is still moving inside it.
 foreach($direction in @('DOWN','UP')){
  $previous=$null;$unchanged=0
  for($attempt=0;$attempt -lt 150;$attempt++){
   AssertFocus $main
   $lines=@(OcrRows $list $main)
   $matches=@($lines|Where-Object{(ListKey $_.text) -ceq (ListKey $wanted)})
   if($matches.Count -gt 1){throw 'List value is ambiguous'}
   if($matches.Count -eq 1){
    $line=$matches[0];PointClick ($line.x+$line.width/2) ($line.y+$line.height/2) $main
    Start-Sleep -Milliseconds 150
    if((ListKey (SelectedText $list $main $wanted)) -cne (ListKey $wanted)){throw 'Selected list text does not match requested value'}
    return
   }
   # A full-list OCR pass may omit the highlighted row. Read its band separately.
   try{if((ListKey (SelectedText $list $main $wanted)) -ceq (ListKey $wanted)){return}}catch{}
   $list.SetFocus();AssertFocus $main
   [System.Windows.Forms.SendKeys]::SendWait('{'+$direction+'}')
   Start-Sleep -Milliseconds 100
   # Include the painted selection in the image fingerprint, even when OCR omits a label.
   $r=$list.Current.BoundingRectangle
   $signature=[OdNative]::VisualHash([int]$r.Left,[int]$r.Top,[int]$r.Width,[int]$r.Height)
   if($signature -ceq $previous){$unchanged++}else{$unchanged=0}
   if($unchanged -ge 2){break}
   $previous=$signature
   if($attempt -eq 149){throw 'List navigation limit reached'}
  }
 }
 throw "List item not found after scanning down and up: $wanted"
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
function AssertPayment($payment,$draft,$main){
 if([regex]::Match($main.Current.Name,'-\s*(\d+)\s*$').Groups[1].Value -cne [string]$draft.patNum){throw 'Patient changed before Save'}
 if([decimal](ReadValue (ById $payment 'textAmount')) -ne [decimal]$draft.amount){throw 'Amount changed before Save'}
 if(-not (DateEquals (ReadValue (ById $payment 'textDate')) ([string]$draft.date))){throw 'Payment date changed before Save'}
 if((ReadValue (ById $payment 'textCheckNum')) -cne [string]$draft.checkNum){throw 'Trace changed before Save'}
 if((ReadValue (ById $payment 'textNote')) -cne [string]$draft.note){throw 'Note changed before Save'}
 if([decimal](ReadValue (ById $payment 'textSplitTotal')) -ne [decimal]$draft.amount){throw 'Split total changed before Save'}
 if((SelectedText (ById $payment 'listPayType') $main ([string]$draft.paymentType)).Trim() -ine ([string]$draft.paymentType).Trim()){throw 'Payment Type readback mismatch before Save'}
}
function NormalizeSplitCodes($lines){
 # Windows OCR reads D as 0 in small OD code cells. Normalize only a complete
 # five-character CDT token inside the uniquely identified Code column.
 $headers=@($lines|Where-Object{$_.text -match '\bProv\b' -and $_.text -match '\bPatient\b' -and $_.text -match '\bCode\b' -and $_.text -match '\bAmount\b'})
 if($headers.Count -ne 1){return $lines}
 $anchors=@{}
 foreach($name in @('Patient','Code','Type')){
  $words=@($headers[0].words|Where-Object{$_.text -ceq $name})
  if($words.Count -ne 1){return $lines}
  $anchors[$name]=$words[0].x+$words[0].width/2
 }
 if($anchors.Patient -ge $anchors.Code -or $anchors.Code -ge $anchors.Type){return $lines}
 $left=($anchors.Patient+$anchors.Code)/2;$right=($anchors.Code+$anchors.Type)/2
 return @($lines|ForEach-Object{
  $line=$_
  if($line.y -gt $headers[0].y){
   $codes=@($line.words|Where-Object{$_.text -cmatch '^0[0-9]{4}$' -and $_.x+$_.width/2 -gt $left -and $_.x+$_.width/2 -lt $right})
   if($codes.Count -eq 1){
    $line=$line.Clone();$word=$codes[0]
    $line.text=(@($line.words|ForEach-Object{if([object]::ReferenceEquals($_,$word)){'D'+$_.text.Substring(1)}else{$_.text}}) -join ' ')
   }
  }
  $line
 })
}
function VerifySplits($payment,$draft,$main){
 $grid=ById $payment 'gridSplits'
 $all=@(NormalizeSplitCodes @(OcrRows $grid $main))
 $rows=@($all|Where-Object{$_.text -match '(?<![A-Z0-9])D\d{4}(?![A-Z0-9])'})
 # No guessed scrolling in the final verification: all planned rows must be visible.
 if(@($all|Where-Object{$_.text -match '\b(Prepayment|Unearned)\b'}).Count -gt 0){throw 'OD generated Prepayment/Unearned. Splits were kept unchanged; review allocation manually.'}
 if($rows.Count -ne @($draft.splits).Count){throw 'OD-generated Splits do not match the PDF plan. Splits were kept unchanged.'}
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
  $unearned=ControlText (ById $edit 'comboUnearnedTypes') $main
  if($unearned -notmatch '^\s*(None|\(none\))\s*$'){throw ('Split Unearned Type changed or unreadable: '+$unearned)}
  CloseWindow $edit
  $payment=WaitOnly $main 'FormPayment'
 }
}
