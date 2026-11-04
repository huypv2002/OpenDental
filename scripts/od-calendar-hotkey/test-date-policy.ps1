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
foreach ($value in @('11-04-2026','11.04.2026','2026-11-04',(([string][char]0x200E)+'11/04/2026'))) {
 if ([LukOdCalendarHotkey.DatePolicy]::Parse($value,$culture).ToString('yyyy-MM-dd') -ne '2026-11-04') { throw 'Date separator/ISO normalization failed' }
}
$uk=[Globalization.CultureInfo]::GetCultureInfo('en-GB')
if ([LukOdCalendarHotkey.DatePolicy]::Parse('04-11-2026',$uk).ToString('yyyy-MM-dd') -ne '2026-11-04') { throw 'UK date order failed' }
$date=[DateTime]::new(2026,5,4)
if ([LukOdCalendarHotkey.DatePolicy]::Format($date,'11-04-2026',$culture) -cne '05-04-2026') { throw 'US write format failed' }
if ([LukOdCalendarHotkey.DatePolicy]::Format($date,'04-11-2026',$uk) -cne '04-05-2026') { throw 'UK write format failed' }
$badOrder=$false
try { [LukOdCalendarHotkey.DatePolicy]::Parse('31-08-2026',$culture) | Out-Null } catch { $badOrder=$true }
if (-not $badOrder) { throw 'Guessed a different date order' }
$failed=$false
try { [LukOdCalendarHotkey.DatePolicy]::Parse('not a date',$culture) | Out-Null } catch { $failed=$true }
if (-not $failed) { throw 'Invalid date accepted' }
$tokens=$null; $errors=$null
[void][Management.Automation.Language.Parser]::ParseFile((Join-Path (Split-Path $PSScriptRoot -Parent) 'start-od-calendar-hotkey.ps1'),[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
Write-Host 'PASS: month-end/leap dates, US/UK date order, separators/ISO/bidi marks, matching write format, invalid-date rejection and launcher syntax. Not a Windows UI test.'
