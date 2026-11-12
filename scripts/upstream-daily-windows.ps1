param([switch]$CheckOnly)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$stateRoot = Join-Path $repo '.tools/upstream-daily'
[void][IO.Directory]::CreateDirectory($stateRoot)
$runId = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
$runDirectory = Join-Path $stateRoot $runId
[void][IO.Directory]::CreateDirectory($runDirectory)
$record = [ordered]@{run=$runId;startedAt=[DateTime]::UtcNow.ToString('o');repository=$repo;checkOnly=[bool]$CheckOnly;outcome='failed';summary='';directory=$runDirectory}
$exitCode = 1
$lock = $null

function Write-JsonFile($Path, $Value) {
    [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 12), (New-Object Text.UTF8Encoding($false)))
}
function Invoke-RepoGit([string[]]$Arguments) {
    $output = & git -c ('safe.directory=' + $repo.Replace('\', '/')) -C $repo @Arguments
    if ($LASTEXITCODE -ne 0) { throw ('git failed: ' + ($Arguments -join ' ')) }
    return ($output -join "`n").Trim()
}

try {
    # A kernel-held file lock releases even after a crash; never delete another run's lock.
    try {
        $lock = [IO.File]::Open((Join-Path $stateRoot 'run.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
    } catch [IO.IOException] {
        $record.outcome = 'skipped'
        $record.summary = 'Another upstream update is running.'
        $exitCode = 0
        return
    }
    # Task Scheduler does not inherit the interactive shell's developer PATH.
    $extraPaths = @((Join-Path $env:USERPROFILE '.cargo/bin'), (Join-Path $env:USERPROFILE '.bun/bin'), (Join-Path $env:LOCALAPPDATA 'npm'))
    $env:PATH = $env:PATH + ';' + ($extraPaths -join ';')
    $env:GIT_TERMINAL_PROMPT = '0'
    Set-Location -LiteralPath $repo
    if ((Invoke-RepoGit @('branch', '--show-current')) -ne 'main') {
        $record.outcome = 'skipped'; $record.summary = 'The primary checkout is not on main.'; $exitCode = 0; return
    }
    foreach ($marker in @('MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'index.lock')) {
        $path = Invoke-RepoGit @('rev-parse', '--git-path', $marker)
        if (Test-Path -LiteralPath $path) {
            $record.outcome = 'skipped'; $record.summary = "Git operation in progress: $marker"; $exitCode = 0; return
        }
    }
    # The owner authorized saving existing project work before integration.
    # Let Codex inspect and commit it separately; the launcher never stages files blindly.
    $record.uncommitted = Invoke-RepoGit @('status', '--porcelain', '--untracked-files=all')
    $record.needsCheckpoint = [bool]$record.uncommitted
    $record.head = Invoke-RepoGit @('rev-parse', 'HEAD')
    $record.origin = Invoke-RepoGit @('remote', 'get-url', 'origin')
    $record.upstream = Invoke-RepoGit @('remote', 'get-url', 'upstream')
    $codex = Get-Command codex.cmd -ErrorAction Stop
    foreach ($tool in @('git', 'node', 'cargo', 'bun', 'ppilot')) { [void](Get-Command $tool -ErrorAction Stop) }
    $record.codex = $codex.Source
    if ($CheckOnly) {
        $record.outcome = 'ready'
        $record.summary = if ($record.needsCheckpoint) { 'Local prerequisites passed. Scheduled Codex will inspect and commit existing project work first. This check did not change any files or commits.' } else { 'Local prerequisites passed. No agent, merge, build or installation was started.' }
        $exitCode = 0; return
    }
    $prompt = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'upstream-daily.prompt.txt') -Raw -Encoding UTF8
    $prompt += "`nRun directory: $runDirectory`nStarting main commit: $($record.head)`nExisting uncommitted work needs a separate checkpoint commit: $($record.needsCheckpoint)`nInspect current git status and diffs yourself before staging; the launch-time record is only a snapshot.`n"
    [IO.File]::WriteAllText((Join-Path $runDirectory 'prompt.txt'), $prompt, (New-Object Text.UTF8Encoding($false)))
    $reportFile = Join-Path $runDirectory 'result.json'
    $schema = Join-Path $PSScriptRoot 'upstream-daily.schema.json'
    $record.outcome = 'running'
    Write-JsonFile (Join-Path $runDirectory 'run.json') $record
    Write-JsonFile (Join-Path $stateRoot 'latest.json') $record
    # Preserve the user's model, sandbox and hooks. Never disable approval review or sandboxing.
    # A noninteractive run must fail an operation that needs new approval, not wait indefinitely.
    $savedPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $prompt | & $codex.Source --no-daemon -a never exec --json -C $repo --output-schema $schema -o $reportFile - 2> (Join-Path $runDirectory 'stderr.log') | Out-File -LiteralPath (Join-Path $runDirectory 'events.jsonl') -Encoding utf8
        $agentExitCode = $LASTEXITCODE
    } finally { $ErrorActionPreference = $savedPreference }
    if ($agentExitCode -ne 0) { throw "Codex exited with code $agentExitCode; inspect the run logs before retrying." }
    $report = Get-Content -LiteralPath $reportFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($report.outcome -notin @('installed', 'up-to-date', 'blocked', 'failed')) { throw 'Codex returned an invalid outcome.' }
    if ($report.outcome -eq 'installed') {
        if ($report.installed_commit -notmatch '^[0-9a-f]{40,64}$' -or $report.installed_sha256 -notmatch '^[0-9a-f]{64}$') { throw 'The installation report is missing commit/hash evidence.' }
        $install = Join-Path $env:LOCALAPPDATA 'Programs/herdr-app'
        $installed = Get-Content -LiteralPath (Join-Path $install 'development.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        $actualHash = (Get-FileHash -LiteralPath (Join-Path $install 'herdr-app.exe') -Algorithm SHA256).Hash
        if ($installed.repository -ne $repo -or $installed.branch -ne 'main' -or $installed.dirty -ne $false -or $installed.commit -ne $report.installed_commit -or $installed.sha256 -ne $actualHash -or $report.installed_sha256 -ne $actualHash) {
            throw 'The claimed installation does not match a clean, verified main build.'
        }
    }
    $record.outcome = $report.outcome
    $record.summary = $report.summary
    $record.report = $report
    $exitCode = if ($report.outcome -in @('installed', 'up-to-date')) { 0 } else { 2 }
} catch {
    $record.outcome = 'failed'
    $record.summary = $_.Exception.Message
    $exitCode = 1
} finally {
    $record.finishedAt = [DateTime]::UtcNow.ToString('o')
    Write-JsonFile (Join-Path $runDirectory 'run.json') $record
    # A concurrent probe must not replace the running task's status.
    if ($lock) {
        Write-JsonFile (Join-Path $stateRoot 'latest.json') $record
        $lock.Dispose()
    }
    Write-Output ($record | ConvertTo-Json -Depth 12)
    exit $exitCode
}
