param(
    [Parameter(Mandatory = $true)][string]$SourceDirectory,
    [Parameter(Mandatory = $true)][string]$TargetDirectory,
    [string]$CargoHome,
    [string]$Toolchain = '1.96.0',
    [switch]$SkipUnitTests
)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'This recipe validates the Windows CLI.' }
$revision = '737775c30b0135ca89892da2a7fd394feede12d3'
$tag = 'rust-v0.169.0-alpha.3'
$patch = Join-Path $PSScriptRoot 'native-panels.patch'
$source = [IO.Path]::GetFullPath($SourceDirectory)
$target = [IO.Path]::GetFullPath($TargetDirectory)
if (-not (Test-Path -LiteralPath $source)) {
    & git clone --depth 1 --branch $tag https://github.com/openai/codex.git $source
    if ($LASTEXITCODE -ne 0) { throw 'Cannot download the pinned Codex source.' }
}
$gitArgs = @('-c', ('safe.directory=' + $source.Replace('\', '/')), '-C', $source)
if ((& git @gitArgs rev-parse HEAD) -ne $revision) { throw 'The source checkout does not match the tested upstream revision.' }
function Test-PatchApplication([switch]$Reverse) {
    # A failed check is expected for a source tree that is already patched.
    $ErrorActionPreference = 'Continue'
    $PSNativeCommandUseErrorActionPreference = $false
    $checkArgs = @('apply', '--check')
    if ($Reverse) { $checkArgs += '--reverse' }
    & git @gitArgs @checkArgs $patch 2>$null
    return $LASTEXITCODE -eq 0
}
if (Test-PatchApplication) {
    & git @gitArgs apply $patch
    if ($LASTEXITCODE -ne 0) { throw 'Cannot apply the native panel patch.' }
} else {
    if (-not (Test-PatchApplication -Reverse)) { throw 'Source differs from both the pinned revision and its patched version. Inspect it before continuing.' }
}
# The official Windows release embeds CRLF SQL. sqlx hashes those exact bytes;
# an LF checkout otherwise rejects databases created by the installed CLI.
Get-ChildItem -LiteralPath (Join-Path $source 'codex-rs/state') -Recurse -File -Filter '*.sql' | ForEach-Object {
    $sql = [IO.File]::ReadAllText($_.FullName)
    $windowsSql = $sql -replace "`r?`n", "`r`n"
    if ($sql -cne $windowsSql) {
        [IO.File]::WriteAllText($_.FullName, $windowsSql, (New-Object Text.UTF8Encoding($false)))
    }
}
$env:PATH = "$env:USERPROFILE/.cargo/bin;$env:PATH"
if ($CargoHome) { $env:CARGO_HOME = [IO.Path]::GetFullPath($CargoHome) }
$env:CARGO_TARGET_DIR = $target
$env:CARGO_PROFILE_DEV_DEBUG = '0'
$env:CARGO_BUILD_JOBS = '1'
$env:CARGO_NET_GIT_FETCH_WITH_CLI = 'true'
Push-Location -LiteralPath (Join-Path $source 'codex-rs')
try {
    if (-not $SkipUnitTests) {
        # The upstream TUI test crate is large. Avoid its incremental hashing
        # overhead while keeping the dependency caches intact.
        $testProfile = 'profile.test.package.codex-tui.incremental=false'
        & cargo "+$Toolchain" --config $testProfile test -p codex-tui --lib 'app::split_threads::tests' --locked -- --test-threads=2
        if ($LASTEXITCODE -ne 0) { throw 'Native panel regression tests failed.' }
        & cargo "+$Toolchain" --config $testProfile test -p codex-tui --lib 'app::tests::side_' --locked -- --test-threads=2
        if ($LASTEXITCODE -ne 0) { throw 'Native side-conversation compatibility tests failed.' }
    }
    & cargo "+$Toolchain" build -p codex-cli --bin codex --locked
    if ($LASTEXITCODE -ne 0) { throw 'Native Codex build failed.' }
} finally { Pop-Location }
$binary = Join-Path $target 'debug/codex.exe'
$record = [ordered]@{
    upstream = $revision
    tag = $tag
    toolchain = $Toolchain
    unitTests = $(if ($SkipUnitTests) { 'skipped' } else { 'passed' })
    patchSha256 = (Get-FileHash -LiteralPath $patch -Algorithm SHA256).Hash
    binary = $binary
    binarySha256 = (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash
    builtAt = [DateTime]::UtcNow.ToString('o')
}
[IO.File]::WriteAllText((Join-Path $target 'native-panels-build.json'), ($record | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
$record | ConvertTo-Json
