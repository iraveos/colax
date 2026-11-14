# Builds the release binary and wraps it in the per-user Colax setup.
#
#   .\packaging\build-setup.ps1              # cargo build --release, then makensis
#   .\packaging\build-setup.ps1 -SkipBuild   # package the exe already on disk
#
# Output: colax-rs\Colax Rust Setup <version>.exe
#
# The version comes from Cargo.toml, so the installer's name, its Add/Remove
# Programs entry and the About card never disagree.

param([switch]$SkipBuild)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

if (-not $SkipBuild) {
    Push-Location $root
    try { cargo build --release } finally { Pop-Location }
}

$exe = Join-Path $root 'target\release\colax.exe'
if (-not (Test-Path $exe)) {
    throw "release exe not found at $exe"
}

$cargo = Get-Content (Join-Path $root 'Cargo.toml') -Raw
if ($cargo -notmatch '(?m)^version\s*=\s*"(\d+\.\d+\.\d+)"') {
    throw 'could not read version from Cargo.toml'
}
$version = $Matches[1]

# The Tauri CLI ships makensis; a standalone NSIS install is accepted too.
$candidates = @(
    (Join-Path $env:LOCALAPPDATA 'tauri\NSIS\makensis.exe'),
    'C:\Program Files (x86)\NSIS\makensis.exe',
    'C:\Program Files\NSIS\makensis.exe'
)
$makensis = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $makensis) {
    throw "makensis not found. Looked in:`n$($candidates -join "`n")"
}

# makensis resolves the script's relative paths against the working directory.
Push-Location $PSScriptRoot
try {
    & $makensis "/DPRODUCT_VERSION=$version" "/DAPP_EXE=$exe" 'colax.nsi'
} finally {
    Pop-Location
}
if ($LASTEXITCODE -ne 0) {
    throw "makensis failed with exit code $LASTEXITCODE"
}

$out = Join-Path $root "Colax Rust Setup $version.exe"
if (-not (Test-Path $out)) {
    throw "expected output $out not found"
}
$size = [math]::Round((Get-Item $out).Length / 1MB, 2)
"build-setup: $out ($size MB)"
