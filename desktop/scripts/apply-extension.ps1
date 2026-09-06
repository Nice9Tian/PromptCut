<#
    PromptCut 拓展库包安装器。随拓展包发给用户，不在构建机运行。

    把预先下好的 wheel 和模型装进已安装的 PromptCut：
      wheel  → <安装目录>\runtime\pylibs      （pip install --no-index，全程离线）
      模型   → %APPDATA%\com.promptcut.desktop\models

    离线是重点：这个包存在的理由就是用户那边 pip 装不上（断网、内网、镜像不通）。
    所以安装过程绝不联网，--no-index 明确禁掉 PyPI。

    用法：
      .\apply-extension.ps1                     # 装到默认位置
      .\apply-extension.ps1 -InstallDir <路径>  # 装到指定位置
      .\apply-extension.ps1 -WhatIf             # 只检查不写入
#>
[CmdletBinding()]
param(
    [string] $InstallDir,
    [switch] $WhatIf
)

$ErrorActionPreference = 'Stop'
$PackRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

function Step { param([string] $T) Write-Host "  $T" }
function Ok   { param([string] $T) Write-Host "  $T" -ForegroundColor Green }

function Fail {
    param([string] $T)
    Write-Host ""
    Write-Host "  安装未完成：$T" -ForegroundColor Red
    Write-Host "  软件本身不受影响，该功能会继续用不需要拓展的那条路。" -ForegroundColor Red
    Write-Host ""
    if (-not $env:PROMPTCUT_EXT_NONINTERACTIVE) { Read-Host "按回车关闭" }
    exit 1
}

Write-Host ""
Write-Host "PromptCut 拓展库" -ForegroundColor Cyan
Write-Host ""

$manifestPath = Join-Path $PackRoot 'extension.json'
if (-not (Test-Path $manifestPath)) { Fail "包不完整，缺 extension.json。请重新下载。" }
$m = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
if ($m.format -ne 'promptcut-extension/1') { Fail "包格式不认识（$($m.format)）。" }

Step "拓展：$($m.label) $($m.version)"

if (-not $InstallDir) { $InstallDir = Join-Path $env:LOCALAPPDATA 'PromptCut' }
$python  = Join-Path $InstallDir 'runtime\python\python.exe'
$pylibs  = Join-Path $InstallDir 'runtime\pylibs'
# 模型和用户下载的语音模型放一起，卸载软件时不会被删掉
$models  = Join-Path $env:APPDATA 'com.promptcut.desktop\models'

if (-not (Test-Path $python)) {
    Fail "在 $InstallDir 找不到 PromptCut 自带的 Python。装在别处就用 -InstallDir 指定。"
}
Step "安装位置：$InstallDir"

# 拓展只带依赖和模型，用到它们的那半边代码在应用里。版本太旧就没有那半边，
# 这时候必须在动手之前拦住 —— 装完了才自检失败，用户已经白等了一分钟，
# 而且盘上多了一堆没人用的 wheel。
function Compare-Version {
    param([string] $Left, [string] $Right)
    $l = @($Left  -split '[.\-+]' | ForEach-Object { [int]($_ -replace '\D', '0') })
    $r = @($Right -split '[.\-+]' | ForEach-Object { [int]($_ -replace '\D', '0') })
    for ($i = 0; $i -lt [Math]::Max($l.Count, $r.Count); $i++) {
        $a = if ($i -lt $l.Count) { $l[$i] } else { 0 }
        $b = if ($i -lt $r.Count) { $r[$i] } else { 0 }
        if ($a -ne $b) { return $a - $b }
    }
    return 0
}

$versionsPath = Join-Path $InstallDir 'runtime\VERSIONS.json'
if ($m.requiresApp -and (Test-Path $versionsPath)) {
    $appVersion = (Get-Content -Raw -LiteralPath $versionsPath | ConvertFrom-Json).app
    if ($appVersion -and (Compare-Version $appVersion $m.requiresApp) -lt 0) {
        Fail ("你的 PromptCut 是 $appVersion，这个拓展需要 $($m.requiresApp) 或更新。" +
              "先用更新补丁（或完整安装包）升级，再装这个拓展。")
    }
    Step "应用版本：$appVersion"
}

$wheelDir = Join-Path $PackRoot 'wheels'
$wheels = @(Get-ChildItem -LiteralPath $wheelDir -File -ErrorAction SilentlyContinue)
if ($wheels.Count -eq 0) { Fail "包里没有 wheel。请重新下载。" }
Step "离线依赖：$($wheels.Count) 个"

$modelSrc = Join-Path $PackRoot 'models'
$modelFiles = @(Get-ChildItem -LiteralPath $modelSrc -File -ErrorAction SilentlyContinue)
if ($modelFiles.Count -gt 0) {
    Step "模型：$(($modelFiles | ForEach-Object { $_.Name }) -join ', ')"
}

if ($WhatIf) {
    Write-Host ""
    Ok "检查通过。加了 -WhatIf，没有写入任何文件。"
    Write-Host ""
    exit 0
}

# ── 装依赖 ────────────────────────────────────────────────────────────
Step "正在安装依赖（离线，不联网）…"
$null = New-Item -ItemType Directory -Force -Path $pylibs
# --no-index + --find-links：只认包里这些 wheel，绝不去 PyPI
& $python -m pip install --no-index --find-links $wheelDir --target $pylibs --upgrade `
    @($wheels | ForEach-Object { $_.FullName })
if ($LASTEXITCODE -ne 0) { Fail "pip 离线安装失败（退出码 $LASTEXITCODE）。" }
Ok "依赖装好了"

# ── 放模型 ────────────────────────────────────────────────────────────
if ($modelFiles.Count -gt 0) {
    $null = New-Item -ItemType Directory -Force -Path $models
    foreach ($f in $modelFiles) {
        Copy-Item -LiteralPath $f.FullName -Destination (Join-Path $models $f.Name) -Force
    }
    Ok "模型已放到 $models"
}

# ── 验收 ──────────────────────────────────────────────────────────────
# 光是文件到位不算成功，得让程序自己说一句 ready
Step "正在验证…"
$env:PROMPTCUT_PYLIBS = $pylibs
$env:PROMPTCUT_MODELS = $models
$probe = & $python -m ("promptcut_$($m.name)") status 2>&1 | Out-String
if ($probe -match '"ready"\s*:\s*true') {
    Ok "验证通过：$($m.label) 已就绪"
} elseif ($probe -match 'No module named') {
    # 版本号看着够、但代码确实不在，多半是装了个手改过的目录
    Fail ("这个 PromptCut 里没有 $($m.label) 的程序代码（promptcut_$($m.name)），" +
          "拓展只提供依赖和模型。请先把软件升级到 $($m.requiresApp) 或更新。")
} else {
    Write-Host "  验证没通过，程序仍报告未就绪：" -ForegroundColor Yellow
    Write-Host "  $($probe.Trim())" -ForegroundColor Yellow
    Fail "文件已就位但自检未通过，请把上面这段反馈给开发者。"
}

Write-Host ""
Ok $m.note
Write-Host ""
if (-not $env:PROMPTCUT_EXT_NONINTERACTIVE) { Read-Host "按回车关闭" }
