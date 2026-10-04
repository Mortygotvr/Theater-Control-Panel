# Turns OBS's built-in obs-browser (CEF) plugin off or back on by renaming its
# files to *.old and back. obs-browser provides both the Browser Source and the
# custom browser docks; CEF's own runtime files (libcef.dll, *.pak, ...) are only
# used by it and stay as they are.
#   .\scripts\obs-browser.ps1 -Disable
#   .\scripts\obs-browser.ps1 -Enable
# Needs admin rights (it asks for them) and OBS must be closed. An OBS update
# puts the files back.
param(
    [Parameter(Mandatory, ParameterSetName = 'Disable')][switch]$Disable,
    [Parameter(Mandatory, ParameterSetName = 'Enable')][switch]$Enable,
    [string]$ObsDir = 'C:\Program Files\obs-studio'
)
$ErrorActionPreference = 'Stop'

$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $mode = if ($Disable) { '-Disable' } else { '-Enable' }
    $proc = Start-Process powershell -Verb RunAs -Wait -PassThru -ArgumentList @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", $mode, '-ObsDir', "`"$ObsDir`"")
    $state = if (Test-Path (Join-Path $ObsDir 'obs-plugins\64bit\obs-browser.dll')) { 'enabled' } else { 'disabled' }
    Write-Host "obs-browser is $state (elevated run exit code $($proc.ExitCode))"
    exit $proc.ExitCode
}
if (Get-Process obs64 -ErrorAction SilentlyContinue) { throw 'OBS is running - close it first.' }

$dir = Join-Path $ObsDir 'obs-plugins\64bit'
foreach ($name in 'obs-browser.dll', 'obs-browser.pdb', 'obs-browser-page.exe', 'obs-browser-page.pdb') {
    $live = Join-Path $dir $name
    $old = "$live.old"
    $from, $to = if ($Disable) { $live, $old } else { $old, $live }
    if (!(Test-Path $from)) { continue }
    if (Test-Path $to) { throw "$to already exists" }
    Rename-Item $from (Split-Path $to -Leaf)
}
