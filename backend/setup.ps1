[CmdletBinding()]
param(
    [string]$Components = "core",
    [ValidateSet("tiny", "small", "large-v3")]
    [string]$WhisperModel = "small",
    [switch]$DownloadModels,
    [switch]$PlanOnly
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$utf8Console = New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8Console
[Console]::InputEncoding = $utf8Console

function ConvertFrom-ExtendedPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    # Tauri may launch bundled resources through an extended-length path. Windows
    # PowerShell 5.1's filesystem provider cannot pass that prefix to Join-Path.
    if ($Path.StartsWith('\\?\UNC\', [StringComparison]::OrdinalIgnoreCase)) {
        return '\\' + $Path.Substring(8)
    }
    if ($Path.StartsWith('\\?\', [StringComparison]::OrdinalIgnoreCase)) {
        return $Path.Substring(4)
    }
    return $Path
}

$ScriptPath = ConvertFrom-ExtendedPath ([string]$MyInvocation.MyCommand.Path)
$BackendDir = [IO.Path]::GetDirectoryName($ScriptPath)
if (-not $BackendDir) {
    throw "Cannot resolve the backend directory from '$ScriptPath'."
}
$AiDir = if ($env:XINCHAO_AI_DIR) { $env:XINCHAO_AI_DIR } else { Join-Path $env:LOCALAPPDATA "XinChao-Cut" }
$MainVenv = Join-Path $AiDir "venv"
$OmniVenv = Join-Path $AiDir "venv-omnivoice"
$BinDir = Join-Path $AiDir "bin"
$MarkerDir = Join-Path $AiDir "components"
$StatePath = Join-Path $AiDir "install-state.json"

$allowed = @("core", "caption", "funasr", "audio", "tts")
$selected = @("core") + ($Components -split "," | ForEach-Object { $_.Trim().ToLowerInvariant() })
$selected = @($selected | Where-Object { $_ } | Sort-Object -Unique)
$unknown = @($selected | Where-Object { $_ -notin $allowed })
if ($unknown.Count -gt 0) {
    throw "Unknown component(s): $($unknown -join ', '). Allowed: $($allowed -join ', ')."
}

Write-Host "=== XinChao-Cut model setup ==="
Write-Host "Runtime:    $AiDir"
Write-Host "Components: $($selected -join ', ')"
if ($selected -contains "caption") { Write-Host "Whisper:    $WhisperModel" }
Write-Host "Models:     $(if ($DownloadModels) { 'download now' } else { 'download on first use' })"

if ($PlanOnly) {
    $coreRequirements = Join-Path $BackendDir "requirements-core.txt"
    if (-not (Test-Path -LiteralPath $coreRequirements)) {
        throw "Backend resources were not found in '$BackendDir'."
    }
    Write-Host "[plan] Backend: $BackendDir"
    Write-Host "[plan] No files were changed."
    exit 0
}

New-Item -ItemType Directory -Force -Path $AiDir, $MarkerDir | Out-Null

function Find-Python311 {
    if (Get-Command py -ErrorAction SilentlyContinue) {
        $version = & py -3.11 --version 2>&1
        if ($LASTEXITCODE -eq 0 -and "$version" -match "3\.11") {
            return @{ Exe = "py"; Prefix = @("-3.11") }
        }
    }
    if (Get-Command python -ErrorAction SilentlyContinue) {
        $version = & python --version 2>&1
        if ($LASTEXITCODE -eq 0 -and "$version" -match "3\.11") {
            return @{ Exe = "python"; Prefix = @() }
        }
    }
    throw "Python 3.11 x64 was not found. Install it and enable 'Add python.exe to PATH'."
}

function Invoke-CheckedPython {
    param([string]$Python, [string[]]$Arguments)
    & $Python @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Python command failed with exit code $LASTEXITCODE."
    }
}

function Invoke-BasePython {
    param([hashtable]$Base, [string[]]$Arguments)
    $all = @($Base.Prefix) + $Arguments
    & $Base.Exe @all
    if ($LASTEXITCODE -ne 0) {
        throw "Python command failed with exit code $LASTEXITCODE."
    }
}

function Ensure-Venv {
    param([hashtable]$Base, [string]$Path, [string]$Label)
    $python = Join-Path $Path "Scripts\python.exe"
    if (-not (Test-Path -LiteralPath $python)) {
        Write-Host "[$Label] creating Python environment..."
        Invoke-BasePython $Base @("-m", "venv", $Path)
    } else {
        Write-Host "[$Label] environment already exists."
    }
    return $python
}

function Install-Tier {
    param([string]$Name, [string]$Python, [string]$Requirements)
    $requirementsPath = Join-Path $BackendDir $Requirements
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $requirementsPath).Hash.ToLowerInvariant()
    $marker = Join-Path $MarkerDir "$Name.sha256"
    if ((Test-Path -LiteralPath $marker) -and ((Get-Content -Raw -LiteralPath $marker).Trim() -eq $hash)) {
        Write-Host "[$Name] already matches $Requirements."
        return
    }
    Write-Host "[$Name] installing $Requirements..."
    Invoke-CheckedPython $Python @("-m", "pip", "install", "-r", $requirementsPath)
    Set-Content -LiteralPath $marker -Value $hash -Encoding ASCII -NoNewline
}

$base = Find-Python311
Write-Host "Python:     $($base.Exe) $($base.Prefix -join ' ')"
if (-not (Get-Command nvidia-smi -ErrorAction SilentlyContinue)) {
    Write-Warning "NVIDIA GPU was not detected. AI models can run slowly or fall back to CPU."
}

$mainPython = Ensure-Venv $base $MainVenv "core"
Invoke-CheckedPython $mainPython @("-m", "pip", "install", "pip==25.3")
Install-Tier "core" $mainPython "requirements-core.txt"
if ($selected -contains "caption") { Install-Tier "caption" $mainPython "requirements-caption.txt" }
if ($selected -contains "funasr") { Install-Tier "funasr" $mainPython "requirements-funasr.txt" }
if ($selected -contains "audio") { Install-Tier "audio" $mainPython "requirements-audio.txt" }

if ($selected -contains "tts") {
    $omniPython = Ensure-Venv $base $OmniVenv "tts"
    $ttsRequirement = Join-Path $BackendDir "requirements-tts.txt"
    $ttsHashSource = (Get-FileHash -Algorithm SHA256 -LiteralPath $ttsRequirement).Hash + "|torch=2.6.0+cu124"
    $ttsHashBytes = [Text.Encoding]::UTF8.GetBytes($ttsHashSource)
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $ttsHash = ([BitConverter]::ToString($sha.ComputeHash($ttsHashBytes))).Replace("-", "").ToLowerInvariant()
    } finally {
        $sha.Dispose()
    }
    $ttsMarker = Join-Path $MarkerDir "tts.sha256"
    if (-not ((Test-Path -LiteralPath $ttsMarker) -and ((Get-Content -Raw -LiteralPath $ttsMarker).Trim() -eq $ttsHash))) {
        Write-Host "[tts] installing isolated OmniVoice runtime..."
        Invoke-CheckedPython $omniPython @("-m", "pip", "install", "pip==25.3")
        Invoke-CheckedPython $omniPython @("-m", "pip", "install", "torch==2.6.0", "torchaudio==2.6.0", "--index-url", "https://download.pytorch.org/whl/cu124")
        Invoke-CheckedPython $omniPython @("-m", "pip", "install", "-r", $ttsRequirement)
        Set-Content -LiteralPath $ttsMarker -Value $ttsHash -Encoding ASCII -NoNewline
    } else {
        Write-Host "[tts] isolated OmniVoice runtime is current."
    }
}

# Pinned FFmpeg build. Version and checksum must be reviewed together.
$ffmpegVersion = "8.1.2"
$ffmpegSha256 = "db580001caa24ac104c8cb856cd113a87b0a443f7bdf47d8c12b1d740584a2ec"
$ffmpegUrl = "https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-8.1.2-essentials_build.zip"
$ffmpegMarker = Join-Path $BinDir "xinchao-ffmpeg-version.txt"
$ffmpegReady = (Test-Path (Join-Path $BinDir "ffmpeg.exe")) -and
    (Test-Path (Join-Path $BinDir "ffprobe.exe")) -and
    (Test-Path $ffmpegMarker) -and
    ((Get-Content -Raw $ffmpegMarker).Trim() -eq "$ffmpegVersion $ffmpegSha256")
if ($ffmpegReady) {
    Write-Host "[ffmpeg] pinned $ffmpegVersion build is ready."
} else {
    Write-Host "[ffmpeg] downloading pinned $ffmpegVersion build..."
    $zip = Join-Path $AiDir "ffmpeg.zip"
    $temp = Join-Path $AiDir "ffmpeg-extract"
    Remove-Item -LiteralPath $zip, $temp -Recurse -Force -ErrorAction SilentlyContinue
    Invoke-WebRequest -Uri $ffmpegUrl -OutFile $zip -TimeoutSec 180
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLowerInvariant()
    if ($actual -ne $ffmpegSha256) {
        Remove-Item -LiteralPath $zip -Force
        throw "FFmpeg checksum mismatch: $actual"
    }
    Expand-Archive -LiteralPath $zip -DestinationPath $temp -Force
    $ffmpegExe = Get-ChildItem $temp -Recurse -Filter ffmpeg.exe | Select-Object -First 1
    if (-not $ffmpegExe) { throw "FFmpeg archive does not contain ffmpeg.exe." }
    $sourceBin = $ffmpegExe.Directory.FullName
    if (-not (Test-Path (Join-Path $sourceBin "ffprobe.exe"))) { throw "FFmpeg archive does not contain ffprobe.exe." }
    New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
    Copy-Item (Join-Path $sourceBin "ffmpeg.exe") $BinDir -Force
    Copy-Item (Join-Path $sourceBin "ffprobe.exe") $BinDir -Force
    Set-Content -LiteralPath $ffmpegMarker -Value "$ffmpegVersion $ffmpegSha256" -Encoding ASCII -NoNewline
    Remove-Item -LiteralPath $zip, $temp -Recurse -Force
}

$dataConfig = Join-Path $AiDir "data-dir.txt"
$workDir = if (Test-Path $dataConfig) { (Get-Content -Raw $dataConfig).Trim() } else { Join-Path $AiDir "work" }
if (-not $workDir) { $workDir = Join-Path $AiDir "work" }
New-Item -ItemType Directory -Force -Path $workDir | Out-Null

if ($DownloadModels) {
    $prefetch = Join-Path $BackendDir "scripts\prefetch_models.py"
    $args = @($prefetch, "--data-dir", $workDir)
    if ($selected -contains "caption") { $args += @("--whisper", $WhisperModel) }
    if ($selected -contains "audio") { $args += "--demucs" }
    if ($selected -contains "funasr") { $args += "--funasr" }
    if ($args.Count -gt 3) {
        Write-Host "[models] downloading selected main-runtime models..."
        Invoke-CheckedPython $mainPython $args
    }
    if ($selected -contains "tts") {
        Write-Host "[models] downloading OmniVoice..."
        $omniPython = Join-Path $OmniVenv "Scripts\python.exe"
        Invoke-CheckedPython $omniPython @($prefetch, "--data-dir", $workDir, "--tts")
    }
}

$installed = Get-ChildItem $MarkerDir -Filter "*.sha256" | ForEach-Object { $_.BaseName } | Sort-Object -Unique
$state = [ordered]@{
    schemaVersion = 1
    installedComponents = @($installed)
    selectedComponents = @($selected)
    whisperModel = $WhisperModel
    modelDownloadPolicy = if ($DownloadModels) { "download-now" } else { "first-use" }
    updatedAt = [DateTime]::UtcNow.ToString("o")
}
$stateJson = $state | ConvertTo-Json -Depth 4
$utf8NoBom = New-Object Text.UTF8Encoding($false)
[IO.File]::WriteAllText($StatePath, $stateJson, $utf8NoBom)
[IO.File]::WriteAllText((Join-Path $AiDir "whisper-model.txt"), $WhisperModel, $utf8NoBom)

Write-Host "=== Setup done ==="
Write-Host "Core editor/export runtime is ready."
if (-not $DownloadModels -and $selected.Count -gt 1) {
    Write-Host "Selected model weights will download when each feature is used for the first time."
}
