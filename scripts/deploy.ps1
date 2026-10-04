# Copies the built plugin and the Control Panel frontend into OBS's per-machine
# plugin folder:
#   C:\ProgramData\obs-studio\plugins\theater-control-panel\bin\64bit\theater-control-panel.dll
#   C:\ProgramData\obs-studio\plugins\theater-control-panel\data\control-panel\
# Usage: cargo build --release; .\scripts\deploy.ps1
#   -DebugBuild  deploy target\debug instead
#   -DataOnly    only refresh the Control Panel files; works while OBS is running
#                (then use Control Panel -> Reload)
param([switch]$DebugBuild, [switch]$DataOnly)
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$dest = 'C:\ProgramData\obs-studio\plugins\theater-control-panel'

if (!$DataOnly) {
    $buildProfile = if ($DebugBuild) { 'debug' } else { 'release' }
    $dll = Join-Path $root "target\$buildProfile\theater_control_panel.dll"
    $pdb = Join-Path $root "target\$buildProfile\theater_control_panel.pdb"
    if (!(Test-Path $dll)) { throw "$dll not found - run cargo build first." }
    if (Get-Process obs64 -ErrorAction SilentlyContinue) { throw 'OBS is running - close it, or use -DataOnly.' }

    # The plugin's folder under its old name: OBS would load both copies
    $old = 'C:\ProgramData\obs-studio\plugins\obs-tauri'
    if (Test-Path $old) { Remove-Item $old -Recurse -Force; Write-Host "Removed the old plugin folder $old" }

    New-Item -ItemType Directory -Force "$dest\bin\64bit" | Out-Null
    Copy-Item $dll "$dest\bin\64bit\theater-control-panel.dll" -Force
    # Keeps its original name: the DLL refers to theater_control_panel.pdb.
    if (Test-Path $pdb) { Copy-Item $pdb "$dest\bin\64bit\theater_control_panel.pdb" -Force }
    Write-Host "Deployed $buildProfile build"
}

# The Control Panel's runtime files only: no src-tauri, tests or project files.
$panel = Join-Path $root 'control-panel'
$data = "$dest\data\control-panel"
if (Test-Path "$dest\data") { Remove-Item "$dest\data" -Recurse -Force }
New-Item -ItemType Directory -Force $data | Out-Null
foreach ($item in 'control_panel.html', 'split_layout.json', 'icon.ico', 'icon.png', 'css', 'js', 'modules', 'overlays') {
    $src = Join-Path $panel $item
    if (Test-Path $src) { Copy-Item $src $data -Recurse -Force }
}
Write-Host "Deployed the Control Panel to $data"
