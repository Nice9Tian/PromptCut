<#
.SYNOPSIS
  M8 混沌项 C1「笔记本断网 30 s」的断网脚本（docs/plan/m8-plan.md 第 2.6 节 C1、第 4 节第 2 项；主会话裁定 D1）。
  一次做完「断 -> 等 N 秒 -> 恢复」，带恢复保险与逐步日志。

.DESCRIPTION
  两种做法（都要管理员权限、都算改系统设置：执行前主会话在对话里列出命令、确认对端会话的权限模式）：
    -Mode firewall（首选）：加两条 Windows 防火墙阻止规则（出、入站），只挡 -Remote 给的地址（阿里云、PC 的局域网地址），
                            笔记本会话自己连外面的连接不受影响。规则名 PC-M8-Blackout-Out / PC-M8-Blackout-In。
                            新规则对「已建立」的 TCP 流是否立刻生效要先用预检 P-C1 量过；不生效就用 nic。
    -Mode nic             ：禁用 -Adapter 给的网卡（Disable-NetAdapter），N 秒后启用。本机所有连接一起断，
                            调用它的会话也会断 N 秒 —— 恢复只靠本脚本自己，不能靠会话的下一条命令。
  不要管理员的第三种做法（代理层半开）不在这里：render-queue-proxy.mjs --stdin-control 的 stall / resume，
  m8 公共件 procs.mjs 的 startProxy().stall() / resume()。

  恢复保险：
    1. 断之前先登记一个 -GuardSeconds（缺省 90）秒后执行一次的计划任务 PC-M8-Blackout-Guard（以 SYSTEM 身份），
       它做同样的恢复（删规则 / 启用网卡）；本脚本恢复成功后删掉它。
    2. 断与等待在 try 里，恢复在 finally 里（Ctrl+C、异常都会恢复）。
    3. -Detach：以分离的隐藏进程重新启动自己并立刻返回（不依赖调用它的会话还在）；结果看 -Log。
  每一步打一行带时刻的日志到 -Log（缺省 %TEMP%\pc-m8-blackout.log），恢复后由会话读回。

  -DryRun：只打印将要执行的命令，不检查权限、不改任何设置、不登记计划任务。

.EXAMPLE
  # 预演（不改任何东西）
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\probes\m8\blackout.ps1 -Mode firewall -Seconds 30 -Remote 8.219.80.16,192.168.50.96 -DryRun
.EXAMPLE
  # 真断（管理员 PowerShell；分离进程，立刻返回）
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\probes\m8\blackout.ps1 -Mode firewall -Seconds 30 -Remote 8.219.80.16,192.168.50.96 -Log C:\Temp\m8-c1.log -Detach

.NOTES
  退出码：0 断开并恢复成功；2 参数不对；3 不是管理员；4 登记恢复保险失败（没有断）；5 断开失败（已尝试恢复）；6 恢复失败（保险任务会在到点时再试）。
#>
[CmdletBinding()]
param(
  [ValidateSet('firewall', 'nic')][string]$Mode = 'firewall',
  [ValidateRange(1, 600)][int]$Seconds = 30,
  [string[]]$Remote = @(),
  [string]$Adapter = '',
  [string]$Log = (Join-Path $env:TEMP 'pc-m8-blackout.log'),
  [ValidateRange(30, 3600)][int]$GuardSeconds = 90,
  [switch]$DryRun,
  [switch]$Detach
)

$ErrorActionPreference = 'Stop'
$RuleOut = 'PC-M8-Blackout-Out'
$RuleIn = 'PC-M8-Blackout-In'
$GuardTask = 'PC-M8-Blackout-Guard'

function Write-Step([string]$step, [hashtable]$fields = @{}) {
  $o = [ordered]@{ t = (Get-Date).ToString('o'); step = $step; mode = $Mode }
  foreach ($k in $fields.Keys) { $o[$k] = $fields[$k] }
  $line = ($o | ConvertTo-Json -Compress -Depth 4)
  Write-Output $line
  if (-not $DryRun) { Add-Content -LiteralPath $Log -Value $line -Encoding utf8 }
}

# ---- 参数核对（只收安全字符：这些值会拼进计划任务的命令行）
if ($Mode -eq 'firewall') {
  $Remote = @($Remote | ForEach-Object { $_ -split ',' } | Where-Object { $_ -ne '' })
  if ($Remote.Count -eq 0) { [Console]::Error.WriteLine('-Mode firewall 要给 -Remote <地址列表>'); exit 2 }
  foreach ($r in $Remote) { if ($r -notmatch '^[0-9A-Fa-f:./]+$') { [Console]::Error.WriteLine("地址只许 IPv4 / IPv6 / 网段：$r"); exit 2 } }
} else {
  if ($Adapter -eq '' -or $Adapter -notmatch '^[\w .()-]+$') { [Console]::Error.WriteLine('-Mode nic 要给 -Adapter <网卡名>（只许字母数字、空格、.()-）'); exit 2 }
}

# ---- 恢复命令（本脚本 finally 与保险任务共用同一段）
if ($Mode -eq 'firewall') {
  $restoreCmd = "Remove-NetFirewallRule -DisplayName '$RuleOut','$RuleIn' -ErrorAction SilentlyContinue"
} else {
  $restoreCmd = "Enable-NetAdapter -Name '$Adapter' -Confirm:`$false"
}
$remoteList = ($Remote | ForEach-Object { "'$_'" }) -join ','
$cutCmds = if ($Mode -eq 'firewall') {
  @(
    "New-NetFirewallRule -DisplayName '$RuleOut' -Direction Outbound -Action Block -RemoteAddress $remoteList",
    "New-NetFirewallRule -DisplayName '$RuleIn' -Direction Inbound -Action Block -RemoteAddress $remoteList"
  )
} else {
  @("Disable-NetAdapter -Name '$Adapter' -Confirm:`$false")
}
$guardCmd = "$restoreCmd; Unregister-ScheduledTask -TaskName '$GuardTask' -Confirm:`$false -ErrorAction SilentlyContinue"

if ($DryRun) {
  Write-Step 'dry-run' @{ seconds = $Seconds; guardSeconds = $GuardSeconds; log = $Log; cut = $cutCmds; restore = $restoreCmd; guard = $guardCmd }
  exit 0
}

# ---- 分离：以隐藏的独立进程重启自己，立刻返回
if ($Detach) {
  $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Mode', $Mode, '-Seconds', $Seconds, '-Log', "`"$Log`"", '-GuardSeconds', $GuardSeconds)
  if ($Mode -eq 'firewall') { $argList += @('-Remote', ($Remote -join ',')) } else { $argList += @('-Adapter', "`"$Adapter`"") }
  $p = Start-Process -FilePath 'powershell.exe' -ArgumentList $argList -WindowStyle Hidden -PassThru
  Write-Output (@{ t = (Get-Date).ToString('o'); step = 'detached'; pid = $p.Id; log = $Log } | ConvertTo-Json -Compress)
  exit 0
}

# ---- 管理员
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Write-Step 'not-admin'; exit 3 }

Write-Step 'start' @{ seconds = $Seconds; remote = $Remote; adapter = $Adapter; guardSeconds = $GuardSeconds }

# ---- 1. 恢复保险：先登记，登记不上就不断
try {
  Unregister-ScheduledTask -TaskName $GuardTask -Confirm:$false -ErrorAction SilentlyContinue
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -Command `"$guardCmd`""
  $trigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddSeconds($GuardSeconds))
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  Register-ScheduledTask -TaskName $GuardTask -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null
  Write-Step 'guard-registered' @{ task = $GuardTask; at = (Get-Date).AddSeconds($GuardSeconds).ToString('o') }
} catch {
  Write-Step 'guard-failed' @{ error = "$($_.Exception.Message)" }
  exit 4
}

$code = 0
$cutOk = $false
try {
  # ---- 2. 断
  foreach ($c in $cutCmds) { Invoke-Expression $c | Out-Null }
  $cutOk = $true
  if ($Mode -eq 'firewall') {
    $rules = @(Get-NetFirewallRule -DisplayName $RuleOut, $RuleIn -ErrorAction SilentlyContinue | ForEach-Object { "$($_.DisplayName):$($_.Enabled)" })
    Write-Step 'cut' @{ rules = $rules }
  } else {
    Write-Step 'cut' @{ adapter = $Adapter; status = "$((Get-NetAdapter -Name $Adapter).Status)" }
  }
  # ---- 3. 等
  Start-Sleep -Seconds $Seconds
} catch {
  Write-Step 'cut-failed' @{ error = "$($_.Exception.Message)" }
  $code = 5
} finally {
  # ---- 4. 恢复
  try {
    Invoke-Expression $restoreCmd | Out-Null
    if ($Mode -eq 'firewall') {
      $left = @(Get-NetFirewallRule -DisplayName $RuleOut, $RuleIn -ErrorAction SilentlyContinue).Count
      if ($left -ne 0) { throw "还剩 $left 条规则" }
      Write-Step 'restored' @{ rulesLeft = 0; cutOk = $cutOk }
    } else {
      $deadline = (Get-Date).AddSeconds(30)
      do { Start-Sleep -Milliseconds 500; $st = "$((Get-NetAdapter -Name $Adapter).Status)" } while ($st -ne 'Up' -and (Get-Date) -lt $deadline)
      Write-Step 'restored' @{ adapter = $Adapter; status = $st; cutOk = $cutOk }
    }
    Unregister-ScheduledTask -TaskName $GuardTask -Confirm:$false -ErrorAction SilentlyContinue
    Write-Step 'guard-removed' @{ task = $GuardTask }
  } catch {
    Write-Step 'restore-failed' @{ error = "$($_.Exception.Message)"; guard = $GuardTask }
    if ($code -eq 0) { $code = 6 }
  }
}
Write-Step 'end' @{ code = $code }
exit $code
