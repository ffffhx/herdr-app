$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'The daily Windows installer requires Windows.' }
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$install = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Programs/herdr-app'))
$dailyHome = Join-Path $env:USERPROFILE '.config/herdr-app'
$app = Join-Path $install 'herdr-app.exe'
$powershell = Join-Path $env:WINDIR 'System32/WindowsPowerShell/v1.0/powershell.exe'
function Invoke-DailyCli([string]$Arguments) {
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $app
    $info.Arguments = $Arguments
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $process = [Diagnostics.Process]::Start($info)
    $output = $process.StandardOutput.ReadToEnd()
    $diagnostic = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    $result = [PSCustomObject]@{ExitCode=$process.ExitCode;Text=$output;Error=$diagnostic}
    $process.Dispose()
    return $result
}
& $powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'build-daily-windows.ps1')
if ($LASTEXITCODE -ne 0) { throw 'Development build failed; installed app was not changed.' }
$build = Get-Content -LiteralPath (Join-Path $repo '.tools/development/build.json') -Raw | ConvertFrom-Json
if ($build.branch -ne 'main') { throw 'Only a main build can replace the daily installation.' }
$binary = $build.binary
if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) { throw "Missing build: $binary" }
$sourceHash = (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash
if ($sourceHash -ne $build.sha256) { throw 'Build provenance does not match the binary.' }
# Never use an application update to bypass a user's paused control session.
if (Get-Command ppilot -ErrorAction SilentlyContinue) {
    $control = ppilot gpui status | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0) { throw 'Cannot verify the current GPUI control state.' }
    $dailyProcessIds = @(Get-CimInstance Win32_Process -Filter "Name = 'herdr-app.exe'" | Where-Object { $_.ExecutablePath -eq $app } | ForEach-Object { $_.ProcessId })
    foreach ($session in $control.sessions) {
        if ($session.app.pid -in $dailyProcessIds -and $session.state -in @('active', 'paused')) {
            throw "Daily Herdr is reserved by GPUI session '$($session.name)' ($($session.state)); finish or return control before updating."
        }
    }
}
$backup = [IO.Path]::GetFullPath((Join-Path $install ('backups/daily-dev-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))))
if (-not $backup.StartsWith($install + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Backup escaped installation folder.' }
[void][IO.Directory]::CreateDirectory($backup)
foreach ($name in @('settings.json','view.json','keys.json','installed.json','shared.json','window.json')) {
    $file = Join-Path $dailyHome $name
    if (Test-Path -LiteralPath $file) { Copy-Item -LiteralPath $file -Destination (Join-Path $backup $name) }
}
$env:HERDR_APP_HOME = $dailyHome
Remove-Item Env:HC_SESSION -ErrorAction SilentlyContinue
Remove-Item Env:HERDR_RELEASES_URL -ErrorAction SilentlyContinue
$state = Invoke-DailyCli 'status'
$wasRunning = $state.ExitCode -eq 0
if ($wasRunning) {
    [IO.File]::WriteAllText((Join-Path $backup 'before-status.json'), $state.Text)
    $close = Invoke-DailyCli 'do window.close'
    # Closing the window drains layout changes; never terminate the core.
    $closed = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Milliseconds 200
        $state = Invoke-DailyCli 'status'
        if ($state.ExitCode -ne 0) { $closed = $true; break }
    }
    if (-not $closed) { throw 'Daily window did not close; reconcile before retrying.' }
}
$previous = Join-Path $backup 'herdr-app.exe'
if (Test-Path -LiteralPath $app) { Move-Item -LiteralPath $app -Destination $previous }
try {
    Copy-Item -LiteralPath $binary -Destination $app
    if ((Get-FileHash -LiteralPath $app -Algorithm SHA256).Hash -ne $sourceHash) { throw 'Installed build hash mismatch.' }
} catch {
    if (Test-Path -LiteralPath $app) { Move-Item -LiteralPath $app -Destination (Join-Path $backup 'failed-herdr-app.exe') }
    if (Test-Path -LiteralPath $previous) { Copy-Item -LiteralPath $previous -Destination $app }
    throw
}
Copy-Item -LiteralPath (Join-Path $repo 'scripts/start-profilepilot-windows.ps1') -Destination (Join-Path $install 'start-profilepilot.ps1')
$shell = New-Object -ComObject WScript.Shell
$programs = [Environment]::GetFolderPath('Programs')
foreach ($name in @('Herdr.lnk', 'Herdr (ProfilePilot).lnk')) {
    $path = Join-Path $programs $name
    if (Test-Path -LiteralPath $path) { Copy-Item -LiteralPath $path -Destination (Join-Path $backup $name) }
}
$link = $shell.CreateShortcut((Join-Path $programs 'Herdr.lnk'))
$link.TargetPath = $powershell
$link.Arguments = '-NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $install 'start-profilepilot.ps1') + '"'
$link.WorkingDirectory = $env:USERPROFILE
$link.WindowStyle = 7
$link.Description = 'Herdr daily development build from main'
$link.IconLocation = (Join-Path $install 'herdr-app.ico') + ',0'
$link.Save()
$legacyShortcut = Join-Path $programs 'Herdr (ProfilePilot).lnk'
if (Test-Path -LiteralPath $legacyShortcut) { Remove-Item -LiteralPath $legacyShortcut -Force }
$record = [ordered]@{channel='local-development';branch=$build.branch;commit=$build.commit;dirty=$build.dirty;builtAt=$build.builtAt;repository=$repo;source=$binary;sha256=$sourceHash;installedAt=[DateTime]::UtcNow.ToString('o');backup=$backup;home=$dailyHome}
[IO.File]::WriteAllText((Join-Path $install 'development.json'), ($record | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
[IO.File]::WriteAllText((Join-Path $install 'SHA256SUMS'), ($sourceHash.ToLowerInvariant() + "  herdr-app.exe`n"), (New-Object Text.UTF8Encoding($false)))
& $powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $install 'start-profilepilot.ps1') -Executable $app
if ($LASTEXITCODE -ne 0) { throw 'Independent launch failed.' }
$ready = $false
for ($attempt = 0; $attempt -lt 40; $attempt++) {
    Start-Sleep -Milliseconds 250
    $state = Invoke-DailyCli 'status'
    if ($state.ExitCode -eq 0) { $ready = $true; break }
}
if (-not $ready) { throw 'Installed build did not become ready; inspect the process before retrying.' }
Write-Output ($record | ConvertTo-Json)
Write-Output $state.Text
