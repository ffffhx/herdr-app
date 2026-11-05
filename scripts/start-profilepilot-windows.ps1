param([string]$Executable = (Join-Path $env:LOCALAPPDATA 'Programs\herdr-app\herdr-app.exe'))

$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSEdition -ne 'Desktop') { throw 'Use Windows PowerShell 5.1.' }
if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) { throw "Herdr executable not found: $Executable" }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Open the Herdr (ProfilePilot) shortcut as an ordinary user so it shares the normal Herdr core.'
}

# WMI starts a short-lived helper outside the caller's Job Object. The helper
# starts the GUI with no console or inherited stdout/stderr redirection.
$appLiteral = ([IO.Path]::GetFullPath($Executable)).Replace("'", "''")
$workingLiteral = $env:USERPROFILE.Replace("'", "''")
$inner = @"
`$psi = New-Object System.Diagnostics.ProcessStartInfo
`$psi.FileName = '$appLiteral'
`$psi.WorkingDirectory = '$workingLiteral'
`$psi.UseShellExecute = `$false
`$psi.CreateNoWindow = `$true
`$psi.EnvironmentVariables['HERDR_GPUI_DEBUG'] = '1'
[void][System.Diagnostics.Process]::Start(`$psi)
"@
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($inner))
$systemPowerShell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$command = '"' + $systemPowerShell + '" -NoProfile -STA -WindowStyle Hidden -EncodedCommand ' + $encoded
$startup = ([wmiclass]'Win32_ProcessStartup').CreateInstance()
$startup.ShowWindow = 0
$result = ([wmiclass]'Win32_Process').Create($command, $env:USERPROFILE, $startup)
if ($result.ReturnValue -ne 0) { throw "Independent Herdr startup failed: $($result.ReturnValue)" }
