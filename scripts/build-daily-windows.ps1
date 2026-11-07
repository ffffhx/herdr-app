param([string]$TargetDirectory)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'The daily Windows build requires Windows.' }
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $repo
$gitArgs = @('-c', ('safe.directory=' + $repo.Replace('\', '/')))
$branch = & git @gitArgs branch --show-current
if ($LASTEXITCODE -ne 0 -or $branch -ne 'main') { throw 'Build the daily app from main in the primary checkout.' }
$commit = & git @gitArgs rev-parse HEAD
if ($LASTEXITCODE -ne 0) { throw 'Cannot identify the source commit.' }
if (-not $TargetDirectory) {
    # Reuse this machine's existing cache; new checkouts use target/daily.
    $cachedTarget = Join-Path $repo '.tools/artifacts/acceptance/herdr-gpui-20261103/target'
    $TargetDirectory = if (Test-Path -LiteralPath $cachedTarget) { $cachedTarget } else { Join-Path $repo 'target/daily' }
}
$env:CARGO_TARGET_DIR = [IO.Path]::GetFullPath($TargetDirectory)
$env:CARGO_PROFILE_DEV_DEBUG = '0'
$env:CARGO_BUILD_JOBS = '3'
if (-not $env:LIBCLANG_PATH) {
    foreach ($clangDirectory in @((Join-Path $env:LOCALAPPDATA 'Android/Sdk/ndk/29.0.14206865/toolchains/llvm/prebuilt/windows-x86_64/bin'), 'C:/Program Files/LLVM/bin')) {
        if (Test-Path -LiteralPath (Join-Path $clangDirectory 'libclang.dll')) { $env:LIBCLANG_PATH = $clangDirectory; break }
    }
}
$env:PATH = "$env:USERPROFILE/.cargo/bin;$env:PATH"
$env:CARGO_NET_GIT_FETCH_WITH_CLI = 'true'
Remove-Item Env:HERDR_APP_RELEASE -ErrorAction SilentlyContinue
& cargo.exe build --features profilepilot --locked
if ($LASTEXITCODE -ne 0) { throw 'Daily development build failed.' }
if ((& git @gitArgs branch --show-current) -ne $branch -or (& git @gitArgs rev-parse HEAD) -ne $commit) { throw 'Source branch or commit changed during the build; build again.' }
$binary = Join-Path $env:CARGO_TARGET_DIR 'debug/herdr-app.exe'
$dirty = [bool](& git @gitArgs status --porcelain)
$record = [ordered]@{branch=$branch;commit=$commit;dirty=$dirty;binary=$binary;sha256=(Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash;builtAt=[DateTime]::UtcNow.ToString('o')}
$recordDirectory = Join-Path $repo '.tools/development'
[void][IO.Directory]::CreateDirectory($recordDirectory)
[IO.File]::WriteAllText((Join-Path $recordDirectory 'build.json'), ($record | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
Write-Output ($record | ConvertTo-Json)
