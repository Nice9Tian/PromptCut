# A4 + A5：PC 原发布配置的安全交付

供用户协调 PC 会话使用。笔记本正式出包卡在缺少原来的 `VITE_DIAG_SUBMIT_URL` 与 `VITE_DIAG_SUBMIT_TOKEN`。不创建或轮换令牌，不改变诊断功能，不改 PC 安装、进程、用户数据或网络配置。

## 来源核对

PC 仓库为 `C:\Users\admin\Documents\PromptCut`。只读检查根目录和已有 worktree 的 `.env*`，只回报文件路径、两个键是否存在。文件内容、值及其 hash 不进会话、信箱、日志或提交。服务器地址与 SSH 私钥路径是连接元数据；私钥内容不读取或回显。

笔记本代码 main 已含两条修复及打包修复，代码相对验证过的 17f515c2 没有再变，之后只有文档。此次交付配置不需要 PC 切分支、提交、推送或运行产品。

## 有现成阿里云 SSH 能力时

将下面 ASCII PowerShell 脚本保存到 PC 仓库之外的临时目录。执行时 `-EnvFile` 指向已找到的原配置，`-KeyFile` 指向 PC 已有的 SSH 私钥文件；参数只有路径，不带任何凭证值。不要给 PowerShell 开调试回显，也不要把配置内容贴到消息里。

脚本只提取两个指定键，临时文件在用户 TEMP；上传前检查服务器目标不存在，目录权限 700、文件权限 600。成功或失败都清理自己创建的本机临时文件，不递归删除。服务器临时文件由笔记本取回后删除。

```powershell
param(
    [Parameter(Mandatory=$true)][string]$EnvFile,
    [Parameter(Mandatory=$true)][string]$KeyFile
)
$ErrorActionPreference = 'Stop'
Set-PSDebug -Off
if (!(Test-Path -LiteralPath $EnvFile -PathType Leaf)) { throw 'Original release configuration file missing' }
if (!(Test-Path -LiteralPath $KeyFile -PathType Leaf)) { throw 'Existing SSH key file missing' }
$selectedLines = @(Get-Content -LiteralPath $EnvFile -Encoding UTF8 | Where-Object {
    $_ -match '^\s*(?:export\s+)?(?:VITE_DIAG_SUBMIT_URL|VITE_DIAG_SUBMIT_TOKEN)\s*='
})
foreach ($keyName in @('VITE_DIAG_SUBMIT_URL','VITE_DIAG_SUBMIT_TOKEN')) {
    $keyLines = @($selectedLines | Where-Object { $_ -match ('^\s*(?:export\s+)?' + $keyName + '\s*=') })
    if ($keyLines.Count -ne 1) { throw ('Missing or duplicate key: ' + $keyName) }
    $keyMatch = [regex]::Match($keyLines[0], '^\s*(?:export\s+)?[^=]+=(.*)$')
    $rhs = $keyMatch.Groups[1].Value.Trim().Trim([char[]]@(34,39))
    if ([string]::IsNullOrWhiteSpace($rhs)) { throw ('Empty key: ' + $keyName) }
}
$StageDir = Join-Path ([IO.Path]::GetTempPath()) ('promptcut-a45-handoff-' + [guid]::NewGuid().ToString('N'))
$StageFile = Join-Path $StageDir 'a45-vite.env'
[IO.Directory]::CreateDirectory($StageDir) | Out-Null
try {
    [IO.File]::WriteAllText($StageFile, ([string]::Join("`n", $selectedLines) + "`n"), [Text.UTF8Encoding]::new($false))
    $sshArgs = @('-i',$KeyFile,'-o','BatchMode=yes','-o','ConnectTimeout=15')
    & ssh.exe @sshArgs 'root@8.219.80.16' 'set -eu; umask 077; mkdir -p /root/.promptcut-release-input; chmod 700 /root/.promptcut-release-input; test ! -e /root/.promptcut-release-input/a45-vite.env'
    if ($LASTEXITCODE -ne 0) { throw 'SSH preflight failed or handoff target already exists' }
    & scp.exe -q @sshArgs $StageFile 'root@8.219.80.16:/root/.promptcut-release-input/a45-vite.env'
    if ($LASTEXITCODE -ne 0) { throw 'Secure handoff upload failed' }
    & ssh.exe @sshArgs 'root@8.219.80.16' 'chmod 600 /root/.promptcut-release-input/a45-vite.env'
    if ($LASTEXITCODE -ne 0) { throw 'Remote permissions check failed' }
    @{ uploaded=$true; path='/root/.promptcut-release-input/a45-vite.env'; keyCount=2 } | ConvertTo-Json -Compress
} finally {
    if (Test-Path -LiteralPath $StageFile -PathType Leaf) { Remove-Item -LiteralPath $StageFile -Force }
    if (Test-Path -LiteralPath $StageDir -PathType Container) { Remove-Item -LiteralPath $StageDir }
}
```

没有已有 SSH 能力时，由用户通过现有安全文件通道把原配置的两键交到笔记本 `D:\VectorMPEG7\PromptCut\.env.local`，不要在会话中发送值。不要为此创建新的服务器凭证。

## 后续真补丁与降装所需文件

原命令保留：`cd desktop && npm run release -- --from-head --patch-only`。基准清单只在 PC；笔记本不制造替代清单。应从协调后的本轮最终 main 出真补丁，回传产物路径、字节数、SHA-256 和清单要点，将产物安全交到笔记本。PC 只构建，不安装补丁到用户正在使用的程序。

后续在笔记本测外壳 0.2.6，需要旧外壳的实际完整安装包；若没有 0.7.13 完整包，可交付兼容的旧完整包及已有的真实 0.7.13 补丁，先在笔记本恢复成应用 0.7.13 / 外壳 0.2.6，再测同一份本轮补丁，最后装回本轮版本。先交付并核对文件，不因缺真补丁提前改变笔记本安装现场。

2026-10-02 只读 GitHub Releases API 返回 200、releases=[]，未发现公开发布资产。没有声称取得或验证了旧安装包；这些文件仍待 PC。任何 PC 计时不替代笔记本性能基准。
