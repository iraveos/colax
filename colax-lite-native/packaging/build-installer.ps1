# Builds the release binary and wraps it in the NSIS installer.
#
#   .\build-installer.ps1            # cargo build --release, then makensis
#   .\build-installer.ps1 -SkipBuild # package the exe already on disk
#
# Output: <repo root>\Colax Lite Setup <version>.exe  — the same naming the
# Tauri build's copy-installer step produces, so both ships sit side by side.

param([switch]$SkipBuild)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

if (-not $SkipBuild) {
    Push-Location $root
    try { cargo build --release } finally { Pop-Location }
}

$exe = Join-Path $root 'target\release\colax-lite.exe'
if (-not (Test-Path $exe)) {
    throw "release exe not found at $exe"
}

# The workspace's package version — the single source of truth for the
# installer's name, its DisplayVersion, and the shipped binary.
$cargo = Get-Content (Join-Path $root 'Cargo.toml') -Raw
if ($cargo -notmatch '(?m)^version\s*=\s*"(\d+\.\d+\.\d+)"') {
    throw "could not read version from Cargo.toml"
}
$version = $Matches[1]

$makensis = Join-Path $env:LOCALAPPDATA 'tauri\NSIS\makensis.exe'
if (-not (Test-Path $makensis)) {
    throw "makensis not found at $makensis (install the Tauri CLI's NSIS toolchain)"
}

# makensis resolves relative paths in the script against the working
# directory, so run it where the .nsi lives.
Push-Location $PSScriptRoot
try {
    & $makensis "/DPRODUCT_VERSION=$version" "/DAPP_EXE=$exe" 'colax-lite.nsi'
} finally {
    Pop-Location
}
if ($LASTEXITCODE -ne 0) {
    throw "makensis failed with exit code $LASTEXITCODE"
}

$out = Join-Path $root "Colax Lite Setup $version.exe"
if (-not (Test-Path $out)) {
    throw "expected output $out not found"
}
"build-installer: $out ($([math]::Round((Get-Item $out).Length / 1MB, 2)) MB)"
