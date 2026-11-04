$ErrorActionPreference='Stop'
Add-Type -Path (Join-Path $PSScriptRoot 'DatePolicy.cs')
$cases=@(
 @('2026-11-04','2026-05-04'),@('2026-08-31','2026-02-28'),
 @('2024-08-31','2024-02-29'),@('2026-03-31','2025-09-30'),
 @('2026-01-31','2025-07-31'),@('2026-05-04','2025-11-04'))
foreach ($case in $cases) {
 $date=[DateTime]::ParseExact($case[0],'yyyy-MM-dd',[Globalization.CultureInfo]::InvariantCulture)
 $actual=[LukOdCalendarHotkey.DatePolicy]::BackSixMonths($date).ToString('yyyy-MM-dd')
 if ($actual -cne $case[1]) { throw "Date mismatch for $($case[0])" }
}
$culture=[Globalization.CultureInfo]::GetCultureInfo('en-US')
if ([LukOdCalendarHotkey.DatePolicy]::Parse('11/4/2026',$culture).ToString('yyyy-MM-dd') -ne '2026-11-04') { throw 'US parsing failed' }
$failed=$false
try { [LukOdCalendarHotkey.DatePolicy]::Parse('not a date',$culture) | Out-Null } catch { $failed=$true }
if (-not $failed) { throw 'Invalid date accepted' }
$tokens=$null; $errors=$null
[void][Management.Automation.Language.Parser]::ParseFile((Join-Path (Split-Path $PSScriptRoot -Parent) 'start-od-calendar-hotkey.ps1'),[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
Write-Host 'PASS: 6 date transitions, US date parsing, invalid-date rejection and launcher syntax. Not a Windows UI test.'
