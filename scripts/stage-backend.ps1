[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$Source = Join-Path $Root "backend"
$Stage = [IO.Path]::GetFullPath((Join-Path $Root "src-tauri\backend-bundle"))
$Expected = [IO.Path]::GetFullPath((Join-Path $Root "src-tauri\backend-bundle"))
if ($Stage -ne $Expected -or -not $Stage.StartsWith($Root, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Unsafe backend staging target: $Stage"
}

New-Item -ItemType Directory -Force -Path $Stage | Out-Null
Get-ChildItem -LiteralPath $Stage -Force | Where-Object { $_.Name -ne ".gitkeep" } |
    Remove-Item -Recurse -Force

Copy-Item -LiteralPath (Join-Path $Source "app") -Destination $Stage -Recurse
New-Item -ItemType Directory -Force -Path (Join-Path $Stage "scripts") | Out-Null
Copy-Item -LiteralPath (Join-Path $Source "scripts\prefetch_models.py") -Destination (Join-Path $Stage "scripts\prefetch_models.py") -Force

$rootFiles = @(
    "funasr_worker_entry.py",
    "run-backend.bat",
    "setup.bat",
    "setup.ps1",
    "tts_worker_entry.py",
    "whisper_worker_entry.py",
    "requirements-core.txt",
    "requirements-caption.txt",
    "requirements-funasr.txt",
    "requirements-audio.txt",
    "requirements-tts.txt",
    "requirements.txt"
)
foreach ($name in $rootFiles) {
    Copy-Item -LiteralPath (Join-Path $Source $name) -Destination (Join-Path $Stage $name) -Force
}

Get-ChildItem -LiteralPath $Stage -Recurse -Directory -Filter "__pycache__" |
    Remove-Item -Recurse -Force
Get-ChildItem -LiteralPath $Stage -Recurse -File |
    Where-Object {
        $_.Name -eq ".env" -or
        $_.Extension -in @(".pyc", ".pyo", ".log")
    } |
    Remove-Item -Force

$count = @(Get-ChildItem -LiteralPath $Stage -Recurse -File).Count
Write-Host "Staged $count backend runtime files in $Stage"
