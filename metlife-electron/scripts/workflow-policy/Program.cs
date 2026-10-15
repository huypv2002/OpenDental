using System.Management.Automation;
using System.Management.Automation.Runspaces;
using System.IO;
var initial=InitialSessionState.CreateDefault2();initial.Commands.Add(new SessionStateCmdletEntry("Sort-Object",typeof(Microsoft.PowerShell.Commands.SortObjectCommand),null));initial.Commands.Add(new SessionStateCmdletEntry("Measure-Object",typeof(Microsoft.PowerShell.Commands.MeasureObjectCommand),null));using var runspace=RunspaceFactory.CreateRunspace(initial);runspace.Open();using var ps=PowerShell.Create();ps.Runspace=runspace;
var ocr=File.ReadAllText(args[0]);var workflow=File.ReadAllText(args[1]);
// Load only the pure OCR row aggregation; WinRT hardware calls remain untested here.
ocr=ocr[ocr.IndexOf("function OcrRows(")..];
ps.AddScript("$ErrorActionPreference='Stop'\n"+workflow+"\n"+ocr+"\n"+"""
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
'Workflow policy executed: fragmented OCR rows, repeated code/date with different teeth, patient punctuation and date checks passed.'
""");var results=ps.Invoke();if(ps.HadErrors)throw new Exception(string.Join("\n",ps.Streams.Error));foreach(var r in results)Console.WriteLine(r);
