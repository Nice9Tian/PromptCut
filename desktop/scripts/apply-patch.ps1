<#
    PromptCut 更新补丁安装器。

    随补丁包一起发出去，在用户机器上运行（不是构建脚本）。它把补丁里的
    payload 覆盖到已安装的 runtime\app 上，只碰构建产物，用户数据一律不动。

    任何一步失败都回滚到备份 —— 更新失败可以接受，装了一半的程序不行。

    用法:
      .\apply-patch.ps1                     # 装到默认位置
      .\apply-patch.ps1 -InstallDir <路径>  # 装到指定位置
      .\apply-patch.ps1 -Force              # 不询问，直接结束正在运行的 PromptCut
      .\apply-patch.ps1 -WhatIf             # 只检查不写入
#>
[CmdletBinding()]
param(
    [string] $InstallDir,
    [switch] $Force,
    [switch] $WhatIf
)

$ErrorActionPreference = 'Stop'
$PatchRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

function Write-Step { param([string] $Text) Write-Host "  $Text" }
function Write-Ok   { param([string] $Text) Write-Host "  $Text" -ForegroundColor Green }
function Write-Warn { param([string] $Text) Write-Host "  $Text" -ForegroundColor Yellow }

function Fail {
    param([string] $Text)
    Write-Host ""
    Write-Host "  更新未完成：$Text" -ForegroundColor Red
    Write-Host "  程序还是原来的版本，可以正常打开。" -ForegroundColor Red
    Write-Host "  如果需要，用完整安装包覆盖安装也能达到同样效果。" -ForegroundColor Red
    Write-Host ""
    if (-not $env:PROMPTCUT_PATCH_NONINTERACTIVE) { Read-Host "按回车关闭" }
    exit 1
}

# 把 "0.2.10" 这种版本号按数字比，字符串比较会把它排在 "0.2.9" 前面。
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

Write-Host ""
Write-Host "PromptCut 更新" -ForegroundColor Cyan
Write-Host ""

# ── 1. 读补丁清单 ─────────────────────────────────────────────────────
$manifestPath = Join-Path $PatchRoot 'patch.json'
if (-not (Test-Path $manifestPath)) { Fail "补丁包不完整，找不到 patch.json。请重新下载。" }
$patch = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
if ($patch.format -ne 'promptcut-patch/1') { Fail "补丁格式不认识（$($patch.format)）。请下载与本程序匹配的补丁。" }

$payloadDir = Join-Path $PatchRoot 'payload'
if (-not (Test-Path $payloadDir)) { Fail "补丁包不完整，找不到 payload 目录。请重新下载。" }

Write-Step "补丁版本：$($patch.appVersion)"

# ── 2. 找到安装位置 ───────────────────────────────────────────────────
if (-not $InstallDir) { $InstallDir = Join-Path $env:LOCALAPPDATA 'PromptCut' }
$runtimeDir  = Join-Path $InstallDir 'runtime'
$appDir      = Join-Path $runtimeDir 'app'
$versionsPath = Join-Path $runtimeDir 'VERSIONS.json'

if (-not (Test-Path $appDir)) {
    Fail "在 $InstallDir 找不到已安装的 PromptCut。装在别处的话用 -InstallDir 指定，或者直接用完整安装包。"
}
Write-Step "安装位置：$InstallDir"

# ── 3. 版本检查 ───────────────────────────────────────────────────────
$installed = $null
if (Test-Path $versionsPath) { $installed = Get-Content -Raw -LiteralPath $versionsPath | ConvertFrom-Json }

$shellExe = Join-Path $InstallDir 'promptcut.exe'
if (Test-Path $shellExe) {
    $shellVersion = (Get-Item -LiteralPath $shellExe).VersionInfo.ProductVersion
    if ($shellVersion -and (Compare-Version $shellVersion $patch.minShellVersion) -lt 0) {
        Fail "这台机器上的 PromptCut 外壳是 $shellVersion，本补丁需要 $($patch.minShellVersion) 或更新。这一版改动了需要重新编译的部分，请用完整安装包。"
    }
}

if ($installed) {
    Write-Step "当前版本：$($installed.app)"
    if ($installed.app -eq $patch.appVersion) {
        Write-Warn "已经是 $($patch.appVersion) 了。继续会重新覆盖一遍。"
        if (-not $Force -and -not $env:PROMPTCUT_PATCH_NONINTERACTIVE) {
            if ((Read-Host "  继续？(y/N)") -notmatch '^[yY]') { Write-Host "  已取消。"; exit 0 }
        }
    }
}

# 补丁不带依赖时，装上去的依赖必须和补丁编译时用的是同一套，
# 否则新代码会 import 到一个根本没装的包。
if (-not $patch.includesDeps) {
    $lockPath = Join-Path $appDir 'package-lock.json'
    if (-not (Test-Path $lockPath)) { Fail "找不到 $lockPath，无法确认依赖是否匹配。请用完整安装包。" }
    $lockHash = (Get-FileHash -LiteralPath $lockPath -Algorithm SHA256).Hash.ToLower()
    if ($lockHash -ne $patch.lockHash) {
        Fail "这台机器上的依赖和补丁对不上（本补丁不含依赖）。请用完整安装包，或者下载带依赖的补丁。"
    }
    Write-Step "依赖：与补丁一致，不需要更新"
} else {
    Write-Step "依赖：本补丁会一并更新"
}

if ($WhatIf) {
    Write-Host ""
    Write-Ok "检查全部通过。加上 -WhatIf 只做检查，没有写入任何文件。"
    Write-Host ""
    exit 0
}

# ── 4. 请用户关掉正在运行的程序 ───────────────────────────────────────
# 只认可执行文件在本次要更新的目录下的那些进程。按进程名一刀切会连着别处
# 装的、或者开发中跑的 PromptCut 一起杀掉——那些和这次更新没有关系。
function Get-TargetProcesses {
    @(Get-Process -Name 'promptcut' -ErrorAction SilentlyContinue | Where-Object {
        $p = $null
        try { $p = $_.Path } catch { }
        # 取不到路径（权限不足）时保守地算作目标，不然文件被占住会更新到一半。
        (-not $p) -or $p.StartsWith($InstallDir, [StringComparison]::OrdinalIgnoreCase)
    })
}

$running = Get-TargetProcesses
if ($running.Count -gt 0) {
    if (-not $Force -and -not $env:PROMPTCUT_PATCH_NONINTERACTIVE) {
        Write-Warn "PromptCut 正在运行，需要先关掉才能更新。"
        if ((Read-Host "  现在关掉它？(y/N)") -notmatch '^[yY]') { Write-Host "  已取消。"; exit 0 }
    }
    Write-Step "正在关闭 PromptCut…"
    foreach ($p in $running) {
        try { $null = $p.CloseMainWindow() } catch { }
    }
    Start-Sleep -Seconds 2
    foreach ($p in Get-TargetProcesses) {
        try { Stop-Process -Id $p.Id -Force -ErrorAction Stop } catch { }
    }
    # 外壳起的 node 子进程未必跟着退，文件被占住就没法覆盖。
    Start-Sleep -Seconds 2
    if ((Get-TargetProcesses).Count -gt 0) {
        Fail "PromptCut 关不掉。请手动退出后再运行本更新。"
    }
    Write-Ok "已关闭"
}

# ── 5. 备份 ───────────────────────────────────────────────────────────
# 只备份构建产物（补丁会覆盖的那些），不备份 node_modules / exports /
# .pc-chats —— 那是几百 MB 的依赖和用户自己的东西，补丁也不碰它们。
$backupDir = Join-Path $runtimeDir ("app.backup-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
Write-Step "备份当前版本…"
$backedUp = New-Object System.Collections.Generic.List[string]
try {
    foreach ($rel in $patch.files.PSObject.Properties.Name) {
        $src = Join-Path $appDir $rel
        if (-not (Test-Path -LiteralPath $src -PathType Leaf)) { continue }
        $dest = Join-Path $backupDir $rel
        $null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest)
        Copy-Item -LiteralPath $src -Destination $dest -Force
        $backedUp.Add($rel)
    }
    foreach ($rel in @($patch.removed)) {
        $src = Join-Path $appDir $rel
        if (-not (Test-Path -LiteralPath $src -PathType Leaf)) { continue }
        $dest = Join-Path $backupDir $rel
        $null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest)
        Copy-Item -LiteralPath $src -Destination $dest -Force
        $backedUp.Add($rel)
    }
    if (Test-Path $versionsPath) {
        Copy-Item -LiteralPath $versionsPath -Destination (Join-Path $backupDir 'VERSIONS.json') -Force
    }
} catch {
    Fail "备份失败：$($_.Exception.Message)"
}
Write-Ok "已备份 $($backedUp.Count) 个文件到 $(Split-Path -Leaf $backupDir)"

# ── 6. 覆盖 ───────────────────────────────────────────────────────────
function Restore-Backup {
    Write-Warn "正在回滚…"
    try {
        foreach ($rel in $backedUp) {
            $src = Join-Path $backupDir $rel
            if (-not (Test-Path -LiteralPath $src -PathType Leaf)) { continue }
            $dest = Join-Path $appDir $rel
            $null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest)
            Copy-Item -LiteralPath $src -Destination $dest -Force
        }
        $bv = Join-Path $backupDir 'VERSIONS.json'
        if (Test-Path $bv) { Copy-Item -LiteralPath $bv -Destination $versionsPath -Force }
        Write-Warn "已回滚到更新前的版本。"
    } catch {
        Write-Host "  回滚也失败了：$($_.Exception.Message)" -ForegroundColor Red
        Write-Host "  备份还在 $backupDir，也可以直接用完整安装包覆盖安装。" -ForegroundColor Red
    }
}

Write-Step "正在更新…"
try {
    # dist 整个换掉：它完全由构建产生，留下上一版的碎片会让页面加载到旧资源。
    $distSrc = Join-Path $payloadDir 'dist'
    $distDest = Join-Path $appDir 'dist'
    if ((Test-Path $distSrc) -and (Test-Path $distDest)) {
        Remove-Item -LiteralPath $distDest -Recurse -Force
    }

    $copied = 0
    foreach ($rel in $patch.files.PSObject.Properties.Name) {
        $src = Join-Path $payloadDir $rel
        if (-not (Test-Path -LiteralPath $src -PathType Leaf)) { throw "补丁包缺少文件：$rel" }
        $dest = Join-Path $appDir $rel
        $null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest)
        Copy-Item -LiteralPath $src -Destination $dest -Force
        $copied++
    }

    foreach ($rel in @($patch.removed)) {
        $dest = Join-Path $appDir $rel
        if (Test-Path -LiteralPath $dest -PathType Leaf) { Remove-Item -LiteralPath $dest -Force }
    }

    if ($patch.includesDeps) {
        Write-Step "正在更新依赖（文件较多，请耐心等待）…"
        $depSrc = Join-Path $payloadDir 'node_modules'
        if (-not (Test-Path $depSrc)) { throw "补丁声明含依赖，但 payload\node_modules 不存在" }
        $depDest = Join-Path $appDir 'node_modules'
        $depOld = "$depDest.old"
        if (Test-Path $depOld) { Remove-Item -LiteralPath $depOld -Recurse -Force }
        # 先挪开再复制：直接覆盖会留下上一版删掉的包，混合出一个谁都没测过的依赖树。
        if (Test-Path $depDest) { Move-Item -LiteralPath $depDest -Destination $depOld -Force }
        try {
            # 用 robocopy 而不是 Copy-Item：几万个小文件快得多，深层嵌套的
            # node_modules 路径也不会撞上 260 字符上限。
            $rc = Start-Process -FilePath 'robocopy.exe' -Wait -NoNewWindow -PassThru `
                -ArgumentList @($depSrc, $depDest, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:1', '/W:1')
            if ($rc.ExitCode -ge 8) { throw "robocopy 复制依赖失败（代码 $($rc.ExitCode)）" }
        } catch {
            if (Test-Path $depDest) { Remove-Item -LiteralPath $depDest -Recurse -Force }
            if (Test-Path $depOld) { Move-Item -LiteralPath $depOld -Destination $depDest -Force }
            throw
        }
        if (Test-Path $depOld) { Remove-Item -LiteralPath $depOld -Recurse -Force }
    }

    # 版本信息：只改 Node 那半边，Chrome/ffmpeg/Python 保持安装时写下的值。
    # appSrcHash 是构建机上算的东西（源码 size+mtime），补丁装完必然对不上，
    # 干脆去掉，免得留一个看着像真的、其实没有意义的哈希。
    if ($installed) {
        $installed.app = $patch.appVersion
        $installed.PSObject.Properties.Remove('appSrcHash')
        $installed | Add-Member -NotePropertyName 'patchedAt' -NotePropertyValue $patch.builtAt -Force
        $installed | Add-Member -NotePropertyName 'patchLockHash' -NotePropertyValue $patch.lockHash -Force
        $installed | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $versionsPath -Encoding UTF8
    }

    Write-Ok "已更新 $copied 个文件"
} catch {
    Write-Host "  更新过程中出错：$($_.Exception.Message)" -ForegroundColor Red
    Restore-Backup
    Fail $_.Exception.Message
}

# ── 7. 校验 ───────────────────────────────────────────────────────────
Write-Step "正在校验…"
$bad = @()
foreach ($rel in $patch.files.PSObject.Properties.Name) {
    $dest = Join-Path $appDir $rel
    if (-not (Test-Path -LiteralPath $dest -PathType Leaf)) { $bad += $rel; continue }
    $h = (Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash.ToLower()
    if ($h -ne $patch.files.$rel) { $bad += $rel }
}
if ($bad.Count -gt 0) {
    Write-Host "  有 $($bad.Count) 个文件校验不通过，例如 $($bad[0])" -ForegroundColor Red
    Restore-Backup
    Fail "文件校验不通过"
}
Write-Ok "校验通过"

Write-Host ""
Write-Ok "已更新到 $($patch.appVersion)。"
Write-Step "备份留在 $backupDir，确认新版本没问题后可以删掉。"
Write-Host ""
if (-not $env:PROMPTCUT_PATCH_NONINTERACTIVE) { Read-Host "按回车关闭" }
