# Internal helper for NEW split values only. Never reads/writes the OD database,
# modifies an existing row, patches a DLL, or disables integrity checks.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
 $inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json
 $candidates = @()
 if ($env:METLIFE_OD_INSTALL_DIR) { $candidates += $env:METLIFE_OD_INSTALL_DIR }
 $candidates += @("${env:ProgramFiles(x86)}\Open Dental", "$env:ProgramFiles\Open Dental", 'C:\Open Dental')
 $install = $candidates | Where-Object { Test-Path -LiteralPath (Join-Path $_ 'OpenDentBusiness.dll') } | Select-Object -First 1
 if (-not $install) { throw 'Không tìm thấy OpenDentBusiness.dll trên SERVER. Kỹ thuật viên kiểm tra thư mục cài OD (METLIFE_OD_INSTALL_DIR nếu cài vị trí riêng).' }
 $install = (Resolve-Path -LiteralPath $install).Path
 [Environment]::CurrentDirectory = $install
 Set-Location -LiteralPath $install
 $assembly = [Reflection.Assembly]::LoadFrom((Join-Path $install 'OpenDentBusiness.dll'))
 $version = $assembly.GetName().Version
 if ($version.Major -ne 24 -or $version.Minor -ne 3) { throw 'Thư viện OD trên SERVER phải thuộc phiên bản 24.3 cho adapter này.' }
 $splitType = $assembly.GetType('OpenDentBusiness.PaySplit', $true)
 $serviceType = $assembly.GetType('OpenDentBusiness.PaySplits', $true)
 $method = $serviceType.GetMethod('HashFields', [Type[]]@($splitType))
 if (-not $method) { throw 'Không tìm thấy hàm tạo hash Split của OD.' }
 $results = @()
 foreach ($row in @($inputData.splits)) {
  if ([string]$row.patNum -notmatch '^[1-9]\d{0,17}$' -or [string]$row.amount -notmatch '^\d+\.\d{2}$' -or [string]$row.date -notmatch '^\d{4}-\d{2}-\d{2}$') { throw 'Dữ liệu Split mới không hợp lệ.' }
  $split = [Activator]::CreateInstance($splitType)
  $splitType.GetField('PatNum').SetValue($split, [long]$row.patNum)
  $splitType.GetField('SplitAmt').SetValue($split, [double]::Parse($row.amount, [Globalization.CultureInfo]::InvariantCulture))
  $splitType.GetField('DatePay').SetValue($split, [DateTime]::ParseExact($row.date, 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture))
  $hash = [string]$method.Invoke($null, @($split))
  # OD catches native library failures and returns the exception type as text.
  # Never accept that text as a valid hash, or use a blank fallback.
  if ([string]::IsNullOrWhiteSpace($hash) -or $hash.Length -lt 16 -or $hash -match 'Exception$' -or $hash -match '\s') { throw 'Thư viện OD chưa tạo được SecurityHash hợp lệ cho Split mới. Kiểm tra CDT.dll và dependency trên SERVER.' }
  $results += $hash
 }
 @{ok=$true;version=$version.ToString();culture=[Globalization.CultureInfo]::CurrentCulture.Name;hashes=@($results)} | ConvertTo-Json -Compress -Depth 5
 exit 0
} catch {
 @{ok=$false;error=$_.Exception.Message} | ConvertTo-Json -Compress
 exit 1
}
