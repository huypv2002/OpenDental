param(
    [Parameter(Mandatory = $true)][string]$AutoUser,
    [Parameter(Mandatory = $true)][string]$AutoDomain,
    [Parameter(Mandatory = $true)][string]$AutologonExe,
    [Parameter(Mandatory = $true)][string]$TaskPrefix,
    [Parameter(Mandatory = $true)][string]$ThisFile,
    [Parameter(Mandatory = $true)][string]$StartToolTime,
    [Parameter(Mandatory = $true)][string]$LockTime
)

$password = Read-Host "Windows PASSWORD for auto-login (not PIN)" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($password)

try {
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringUni($bstr)

    if ([string]::IsNullOrWhiteSpace($AutoUser)) {
        throw "Windows username is required."
    }
    if ([string]::IsNullOrEmpty($plain)) {
        throw "Windows password is required. PIN is not supported for auto-login."
    }
    if (-not (Test-Path -LiteralPath $AutologonExe)) {
        throw "Missing Autologon executable: $AutologonExe"
    }

    $autologonProcess = Start-Process -FilePath $AutologonExe -ArgumentList @($AutoUser, $AutoDomain, $plain) -Wait -PassThru
    if ($autologonProcess.ExitCode -ne 0) {
        throw "Autologon returned exit code $($autologonProcess.ExitCode)."
    }

    $runAsUser = if ([string]::IsNullOrWhiteSpace($AutoDomain)) {
        $AutoUser
    } else {
        "$AutoDomain\$AutoUser"
    }

    $startAction = "`"$ThisFile`" run"
    $lockAction = "`"$ThisFile`" lock"

    & schtasks.exe /Create /TN "$TaskPrefix - Start Monitoring" /SC DAILY /ST $StartToolTime /TR $startAction /RU $runAsUser /RP $plain /RL HIGHEST /IT /F
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }

    & schtasks.exe /Create /TN "$TaskPrefix - Lock Screen" /SC DAILY /ST $LockTime /TR $lockAction /RU $runAsUser /RP $plain /RL HIGHEST /IT /F
    exit $LASTEXITCODE
} finally {
    if ($bstr -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
}
