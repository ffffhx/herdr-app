param([ValidatePattern('^([01][0-9]|2[0-3]):[0-5][0-9]$')][string]$At = '04:00', [switch]$CheckOnly)

$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runner = Join-Path $PSScriptRoot 'upstream-daily-windows.ps1'
$taskName = 'Herdr - Daily Upstream Sync'
$powershell = Join-Path $env:WINDIR 'System32/WindowsPowerShell/v1.0/powershell.exe'
$arguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $runner + '"'
if ((Get-TimeZone).Id -ne 'China Standard Time') { throw 'This schedule requires the agreed Asia/Shanghai Windows timezone.' }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute $powershell -Argument $arguments -WorkingDirectory $repo
$firstRun = [DateTime]::Today.Add([TimeSpan]::Parse($At))
if ($firstRun -le [DateTime]::Now) { $firstRun = $firstRun.AddDays(1) }
$trigger = New-ScheduledTaskTrigger -Daily -At $firstRun
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
# Never interrupt another run or forcibly kill a merge/install at a time limit.
# Run only in the user's logged-in desktop; no password, elevated token or wake timer.
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$description = 'Daily Herdr upstream integration via Codex CLI, authorized 2026-11-12. Merge, validate and install own build; preserve customized features and daily core. Logs: .tools/upstream-daily.'
$definition = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description $description
if ($CheckOnly) {
    [ordered]@{task=$taskName;time=$At;timezone='Asia/Shanghai';firstRun=$firstRun.ToString('o');user=$identity;execute=$powershell;arguments=$arguments;workingDirectory=$repo;logonType=[string]$principal.LogonType;runLevel=[string]$principal.RunLevel;multipleInstances=[string]$settings.MultipleInstances;executionTimeLimit=$settings.ExecutionTimeLimit;startWhenAvailable=$settings.StartWhenAvailable;wakeToRun=$settings.WakeToRun;registered=$false} | ConvertTo-Json
    return
}
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
    if ($existing.Actions.Count -ne 1 -or $existing.Actions[0].Execute -ne $powershell -or $existing.Actions[0].Arguments -ne $arguments) {
        throw 'A task with this name belongs to another command; it was not overwritten.'
    }
    if ($existing.State -eq 'Running') { throw 'The scheduled task is running; leave it intact.' }
}
[void](Register-ScheduledTask -TaskName $taskName -InputObject $definition -Force)
$saved = Get-ScheduledTask -TaskName $taskName
$info = Get-ScheduledTaskInfo -TaskName $taskName
$record = [ordered]@{task=$taskName;time=$At;timezone='Asia/Shanghai';repository=$repo;state=[string]$saved.State;nextRun=$info.NextRunTime.ToString('o');user=$identity;runner=$runner}
$directory = Join-Path $repo '.tools/upstream-daily'
[void][IO.Directory]::CreateDirectory($directory)
[IO.File]::WriteAllText((Join-Path $directory 'schedule.json'), ($record | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
Write-Output ($record | ConvertTo-Json)
