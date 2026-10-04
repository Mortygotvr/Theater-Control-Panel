# Builds the release zip, dist\theater-control-panel-<version>-windows-x64.zip:
#   theater-control-panel\bin\64bit            the plugin (theater-control-panel.dll)
#   theater-control-panel\data\control-panel   the Control Panel's runtime files
# Only files git tracks go in: never configuration .json files, .env files or
# proxy scripts (control-panel\.clinerules).
# People extract it into C:\ProgramData\obs-studio\plugins.
# Build first: cargo build --release
param([string]$Version = "0.1.0")
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$work = "$root\dist\stage"
$stage = "$work\theater-control-panel"
$dll = "$root\target\release\theater_control_panel.dll"
if (!(Test-Path -LiteralPath $dll)) { throw "$dll not found - run cargo build --release first." }
if (Test-Path $work) { Remove-Item $work -Recurse -Force }
New-Item -ItemType Directory -Force "$stage\bin\64bit", "$stage\data\control-panel" | Out-Null
Copy-Item -LiteralPath $dll "$stage\bin\64bit\theater-control-panel.dll"

# The same runtime files deploy.ps1 copies (no src-tauri, tests or project files), tracked ones only
foreach ($item in 'control_panel.html', 'icon.ico', 'icon.png', 'css', 'js', 'modules', 'overlays') {
    foreach ($file in (git -C $root -c core.quotepath=off ls-files -- "control-panel/$item")) {
        $dest = Join-Path "$stage\data" $file
        New-Item -ItemType Directory -Force -Path (Split-Path -LiteralPath $dest) | Out-Null
        Copy-Item -LiteralPath (Join-Path $root $file) -Destination $dest
    }
}
Copy-Item -LiteralPath "$root\LICENSE" "$stage\LICENSE.txt"

$zip = "$root\dist\theater-control-panel-$Version-windows-x64.zip"
if (Test-Path $zip) { Remove-Item $zip }
Compress-Archive -Path $stage -DestinationPath $zip
Remove-Item $work -Recurse -Force
Write-Host "Made $zip"
