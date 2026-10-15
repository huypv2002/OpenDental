# Windows built-in OCR; captures only the supplied OD control, never the full desktop.
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null=[Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]
$null=[Windows.Storage.Streams.IRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime]
$null=[Windows.Storage.FileAccessMode,Windows.Storage,ContentType=WindowsRuntime]
$null=[Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
$null=[Windows.Graphics.Imaging.SoftwareBitmap,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
$null=[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
$null=[Windows.Media.Ocr.OcrResult,Windows.Foundation,ContentType=WindowsRuntime]
$null=[Windows.Globalization.Language,Windows.Globalization,ContentType=WindowsRuntime]
$script:AwaitMethod=[System.WindowsRuntimeSystemExtensions].GetMethods()|Where-Object{$_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetGenericArguments().Count -eq 1 -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'}|Select-Object -First 1
function AwaitWinRT($operation,[Type]$resultType){
 $task=$script:AwaitMethod.MakeGenericMethod($resultType).Invoke($null,@($operation))
 if(-not $task.Wait(10000)){throw 'Windows OCR timed out'}
 return $task.GetAwaiter().GetResult()
}
function OcrControl($element,$main,$cropRect=$null){
 AssertFocus $main
 $r=if($cropRect){$cropRect}else{$element.Current.BoundingRectangle}
 if($r.Width -le 2 -or $r.Height -le 2 -or $element.Current.IsOffscreen){throw 'OCR target not visible'}
 $file=Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString()+'.png')
 $bitmap=[System.Drawing.Bitmap]::new([int]$r.Width,[int]$r.Height);$g=[System.Drawing.Graphics]::FromImage($bitmap)
 $scaleLimit=if($cropRect -and $r.Height -lt 150){6}else{3}
 $scale=[Math]::Max(1,[Math]::Min($scaleLimit,[Math]::Floor(4000/[Math]::Max($r.Width,$r.Height))))
 $prepared=$null;$pg=$null
 try{
  $g.CopyFromScreen([int]$r.Left,[int]$r.Top,0,0,$bitmap.Size)
  # OD's grey/blue selection can make Windows OCR omit the selected label entirely.
  # Normalize light backgrounds while preserving dark glyphs, then enlarge small text.
  if($cropRect){[OdNative]::NormalizeOcr($bitmap)}
  $prepared=[Drawing.Bitmap]::new([int]($bitmap.Width*$scale),[int]($bitmap.Height*$scale))
  $pg=[Drawing.Graphics]::FromImage($prepared)
  $pg.InterpolationMode=[Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $pg.PixelOffsetMode=[Drawing.Drawing2D.PixelOffsetMode]::Half
  $pg.DrawImage($bitmap,0,0,$prepared.Width,$prepared.Height)
  $prepared.Save($file,[Drawing.Imaging.ImageFormat]::Png)
 }finally{if($pg){$pg.Dispose()};if($prepared){$prepared.Dispose()};$g.Dispose();$bitmap.Dispose()}
 $stream=$null;$software=$null
 try{
  $storage=AwaitWinRT ([Windows.Storage.StorageFile]::GetFileFromPathAsync($file)) ([Windows.Storage.StorageFile])
  $stream=AwaitWinRT ($storage.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder=AwaitWinRT ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $software=AwaitWinRT ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $language=[Windows.Globalization.Language]::new('en-US')
  $engine=[Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
  if($null -eq $engine){throw 'Install English OCR language on Windows before automating owner-drawn controls.'}
  $result=AwaitWinRT ($engine.RecognizeAsync($software)) ([Windows.Media.Ocr.OcrResult])
  $lines=@()
  foreach($line in $result.Lines){
   $words=@($line.Words);if($words.Count -eq 0){continue}
   $left=($words|ForEach-Object{$_.BoundingRect.X}|Measure-Object -Minimum).Minimum
   $top=($words|ForEach-Object{$_.BoundingRect.Y}|Measure-Object -Minimum).Minimum
   $right=($words|ForEach-Object{$_.BoundingRect.X+$_.BoundingRect.Width}|Measure-Object -Maximum).Maximum
   $bottom=($words|ForEach-Object{$_.BoundingRect.Y+$_.BoundingRect.Height}|Measure-Object -Maximum).Maximum
   $wordBoxes=@($words|ForEach-Object{@{text=$_.Text;x=$r.Left+$_.BoundingRect.X/$scale;y=$r.Top+$_.BoundingRect.Y/$scale;width=$_.BoundingRect.Width/$scale;height=$_.BoundingRect.Height/$scale}})
   $lines+=@{text=$line.Text;x=$r.Left+$left/$scale;y=$r.Top+$top/$scale;width=($right-$left)/$scale;height=($bottom-$top)/$scale;words=$wordBoxes}
  }
  return $lines
 }finally{if($software){$software.Dispose()};if($stream){$stream.Dispose()};Remove-Item -LiteralPath $file -ErrorAction SilentlyContinue}
}
function PointClick([double]$x,[double]$y,$main,[int]$count=1){
 AssertFocus $main
 [void][OdNative]::SetCursorPos([int]$x,[int]$y)
 for($k=0;$k -lt $count;$k++){[OdNative]::mouse_event(2,0,0,0,[UIntPtr]::Zero);[OdNative]::mouse_event(4,0,0,0,[UIntPtr]::Zero);if($count -gt 1){Start-Sleep -Milliseconds 80}}
}
function SelectedText($control,$main){
 $selection=$null
 if($control.TryGetCurrentPattern([System.Windows.Automation.SelectionPattern]::Pattern,[ref]$selection)){
  $selectedItems=@($selection.Current.GetSelection())
  if($selectedItems.Count -eq 1){return [string]$selectedItems[0].Current.Name}
 }

 # Selected native/custom list rows have a solid blue or grey highlight. Read only that band.
 $r=$control.Current.BoundingRectangle;$b=[System.Drawing.Bitmap]::new([int]$r.Width,[int]$r.Height);$g=[System.Drawing.Graphics]::FromImage($b)
 try{
  AssertFocus $main;$g.CopyFromScreen([int]$r.Left,[int]$r.Top,0,0,$b.Size)
  $ys=@()
  for($y=1;$y -lt $b.Height-1;$y++){
   $hits=0;$n=0
   for($x=3;$x -lt $b.Width-18;$x+=5){$c=$b.GetPixel($x,$y);$n++;if(($c.B-$c.R -gt 15 -and $c.B -gt 120 -and $c.R -lt 225) -or ($c.R -ge 140 -and $c.R -le 215 -and [Math]::Abs($c.R-$c.G) -lt 15 -and $c.B-$c.R -ge 0 -and $c.B-$c.R -lt 35)){$hits++}}
   if($n -gt 0 -and $hits/$n -gt 0.62){$ys+=$y}
  }
  if($ys.Count -eq 0){throw 'Could not verify selection highlight'}
  # OCR only the selected band: full-list OCR may omit short/highlighted labels.
  $first=[int]$ys[0];$last=[int]$ys[-1]
  if($last-$first+1 -ne $ys.Count){throw 'Selection highlight has multiple bands'}
  $band=[pscustomobject]@{Left=$r.Left;Top=$r.Top+$first;Width=$r.Width;Height=$last-$first+1}
  $selected=@(OcrRows $control $main $band)
  if($selected.Count -ne 1){throw ('Selection highlight does not identify one OCR line: '+(@{rows=$selected;highlightY=$ys}|ConvertTo-Json -Depth 6 -Compress))}
  return [string]$selected[0].text
 }finally{$g.Dispose();$b.Dispose()}
}

function OcrRows($element,$main,$cropRect=$null){
 # OCR may split a table row into one line per column. Merge by vertical alignment.
 $lines=@(OcrControl $element $main $cropRect|Sort-Object { [double]$_.y },{ [double]$_.x });$rows=[Collections.Generic.List[object]]::new()
 foreach($line in $lines){
  $cy=$line.y+$line.height/2;$match=$null
  foreach($row in $rows){if([Math]::Abs($row.cy-$cy) -le [Math]::Max(3,$line.height*0.35)){$match=$row;break}}
  if($null -eq $match){$match=@{cy=$cy;parts=[Collections.Generic.List[object]]::new()};$rows.Add($match)}
  $match.parts.Add($line)
 }
 $result=@()
 foreach($row in $rows){
  $parts=@($row.parts|Sort-Object { [double]$_.x })
  $left=($parts|ForEach-Object{$_.x}|Measure-Object -Minimum).Minimum
  $top=($parts|ForEach-Object{$_.y}|Measure-Object -Minimum).Minimum
  $right=($parts|ForEach-Object{$_.x+$_.width}|Measure-Object -Maximum).Maximum
  $bottom=($parts|ForEach-Object{$_.y+$_.height}|Measure-Object -Maximum).Maximum
  $rowWords=@($parts|ForEach-Object{if($_.words){$_.words}else{$_}})
  $result+=@{words=$rowWords;text=($parts|ForEach-Object{$_.text}) -join ' ';x=$left;y=$top;width=$right-$left;height=$bottom-$top}
 }
 return $result
}
