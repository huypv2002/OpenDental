using System.Management.Automation;
using System.Management.Automation.Runspaces;
using System.IO;
var initial=InitialSessionState.CreateDefault2();initial.Commands.Add(new SessionStateCmdletEntry("Sort-Object",typeof(Microsoft.PowerShell.Commands.SortObjectCommand),null));initial.Commands.Add(new SessionStateCmdletEntry("Measure-Object",typeof(Microsoft.PowerShell.Commands.MeasureObjectCommand),null));using var runspace=RunspaceFactory.CreateRunspace(initial);runspace.Open();using var ps=PowerShell.Create();ps.Runspace=runspace;
foreach(var file in Directory.GetFiles(Path.GetDirectoryName(Path.GetFullPath(args[1]))!,"*.ps1")) {
 System.Management.Automation.Language.Parser.ParseFile(file,out var tokens,out var errors);
 if(errors.Length>0)throw new Exception(file+": "+string.Join("; ",errors.Select(e=>e.ToString())));
}
var discovery=File.ReadAllText(Path.Combine(Path.GetDirectoryName(Path.GetFullPath(args[1]))!,"window-discovery.ps1"));
var account=File.ReadAllText(Path.Combine(Path.GetDirectoryName(Path.GetFullPath(args[1]))!,"account-selection.ps1"));
var ocr=File.ReadAllText(args[0]);var workflow=File.ReadAllText(args[1]);
// Load only the pure OCR row aggregation; WinRT hardware calls remain untested here.
ocr=ocr[ocr.IndexOf("function OcrRows(")..];
ps.AddScript("$ErrorActionPreference='Stop'\n"+workflow+"\n"+discovery+"\n"+account+"\n"+ocr+"\n"+"""
$same=@{handle=100;processId=20;id='FormOpenDental';element='correct'}
if((SelectOdMain @($same,$same)) -cne 'correct'){throw 'Duplicate native/UIA handle was not deduplicated'}
$cases=@(
 @{name='missing main';items=@();message='UI Automation'},
 @{name='zero handle';items=@(@{handle=0;processId=20;id='FormOpenDental';element='invalid'});message='UI Automation'},
 @{name='popup only';items=@(@{handle=101;processId=20;id='FormPayment';element='popup'});message='UI Automation'},
 @{name='two mains';items=@($same,@{handle=200;processId=21;id='FormOpenDental';element='other'});message='2'}
)
foreach($case in $cases){
 $caught=$false
 try{SelectOdMain $case.items}catch{$caught=$true;if($_.Exception.Message -notlike ('*'+$case.message+'*')){throw}}
 if(-not $caught){throw ('Unsafe discovery accepted: '+$case.name)}
}
'Window selection policy passed: duplicate handles, missing/inaccessible main, zero handles, popup exclusion and multiple instances.'
function OcrControl($element,$main){
 @(@{text='Date';x=10;y=70;width=40;height=13},@{text='Prov';x=80;y=70;width=30;height=13},@{text='Code';x=120;y=70;width=40;height=13},@{text='Tooth';x=180;y=70;width=25;height=13},@{text='Description';x=220;y=70;width=90;height=13},@{text='09/13/2026';x=10;y=100;width=65;height=13},@{text='DOC';x=80;y=101;width=30;height=13},@{text='D2392';x=120;y=100;width=40;height=13},@{text='13';x=180;y=101;width=20;height=13},@{text='09/13/2026';x=10;y=121;width=65;height=13},@{text='DOC';x=80;y=122;width=30;height=13},@{text='D2392';x=120;y=121;width=40;height=13},@{text='14';x=180;y=122;width=20;height=13},@{text='Restoration 13';x=230;y=122;width=100;height=13})
}
$rows=@(OcrRows $null $null)
if($rows.Count -ne 3){throw 'OCR column fragments were not merged into header + 2 separate rows'}
if($rows[1].text -cne '09/13/2026 DOC D2392 13'){throw 'Row ordering/identity changed'}
$grid=[pscustomobject]@{}
function ById($picker,$id){return $grid}
function PointClick($x,$y,$main){throw 'Unexpected scrolling: exact procedure row should already be found'}
$split=[pscustomobject]@{date='2026-09-13';code='D2392';providerAbbr='DOC';tooth='14'}
$row=FindProcedureRow $null $split $null
if($row.y -ne 121){throw 'Wrong tooth row selected'}
$split.tooth='13';$row=FindProcedureRow $null $split $null
if($row.y -ne 100){throw 'Wrong exact procedure selected'}
if((ListKey 'LE , JULIE') -cne (ListKey 'LE, JULIE')){throw 'Patient punctuation normalization failed'}
if(-not (DateEquals '9/13/2026' '2026-09-13')){throw 'US date comparison failed'}
if(DateEquals '9/14/2026' '2026-09-13'){throw 'Different dates considered equal'}
$header=@{text='Date Patient Prov Code Tth Description';y=10;height=12;words=@(
 @{text='Date';x=10;width=40},@{text='Patient';x=120;width=45},@{text='Prov';x=220;width=30},@{text='Code';x=280;width=35},@{text='Tth';x=350;width=25},@{text='Description';x=420;width=70}
)}
function AccountLine($y,$patient,$code,$tooth){
 @{text='09/20/2026 '+$patient+' DOC '+$code+' '+$tooth;y=$y;height=14;words=@(
 @{text='09/20/2026';x=10;width=75},@{text=$patient;x=120;width=45},@{text='DOC';x=220;width=30},@{text=$code;x=280;width=35},@{text=$tooth;x=350;width=25},@{text='Restoration 14';x=420;width=120})}
}
$accountRows=@(AccountRows @($header,(AccountLine 40 'RYAN' 'D0120' ''),(AccountLine 80 'RYAN' 'D2392' '13'),(AccountLine 120 'RYAN' 'D2392' '14'),(AccountLine 160 'OTHER' 'D2392' '14')))
$draft=[pscustomobject]@{patientName='PHAM, RYAN';splits=@(
 [pscustomobject]@{code='D0120';date='2026-09-20';tooth='';providerAbbr='DOC'},
 [pscustomobject]@{code='D2392';date='2026-09-20';tooth='14';providerAbbr='DOC'}
)}
$targets=@(MatchAccountRows $accountRows $draft)
if($targets.Count -ne 2 -or $targets[0].y -ne 40 -or $targets[1].y -ne 120){throw 'Wrong Account procedure identity'}
foreach($badRows in @(
 @{rows=@($accountRows[0],$accountRows[1],$accountRows[3])},
 @{rows=@($accountRows)+@($accountRows[2])}
)){
 $caught=$false;try{MatchAccountRows $badRows.rows $draft}catch{$caught=$true}
 if(-not $caught){throw 'Missing/ambiguous Account procedure was accepted'}
}
# Invalid OD-generated allocations must stop without opening/editing a split.
function OcrRows($element,$main){return $script:generatedRows}
$draft=[pscustomobject]@{splits=@([pscustomobject]@{code='D0120';providerAbbr='DOC';amountCents=8640})}
foreach($case in @(
 @{rows=@(@{text='RYAN Prepayment 395.40'});expected='Prepayment'},
 @{rows=@();expected='Splits do not match'},
 @{rows=@(@{text='DOC RYAN D0120 4.50'});expected='row match is ambiguous'}
)){
 $script:generatedRows=$case.rows
 $caught=$false
 try{VerifySplits $null $draft $null}catch{
  $caught=$true
  if($_.Exception.Message -notlike ('*'+$case.expected+'*')){throw}
 }
 if(-not $caught){throw 'Invalid generated allocation was accepted'}
}
'Workflow policy executed: Account column/identity mapping, different teeth/patients, duplicate/missing rows and rejected OD-generated Prepayment/wrong allocations passed.'
""");var results=ps.Invoke();if(ps.InvocationStateInfo.State==PSInvocationState.Failed||ps.Streams.Error.Count>0)throw new Exception(ps.InvocationStateInfo.Reason?.Message+"\n"+string.Join("\n",ps.Streams.Error.Select(e=>e.Exception.Message+" at "+e.ScriptStackTrace)));foreach(var r in results)Console.WriteLine(r);
