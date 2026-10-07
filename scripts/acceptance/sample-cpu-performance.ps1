# 笔记本复核用:后台采样 "% Processor Performance"(全核频率相对标称的百分比),写成 CSV,结束后给出汇总。
# 这台笔记本有过全核频率只有标称 74% 的时段(REPORT 记录),那段时间里量的耗时不作数。
#
# 用法(PowerShell,窗口静默:用 Start-Process -WindowStyle Hidden 起,别开可见窗口):
#   开始: Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoProfile','-File','scripts\acceptance\sample-cpu-performance.ps1','-Out','<目录>\cpu-perf.csv','-StopFile','<目录>\cpu-perf.stop'
#   结束: New-Item <目录>\cpu-perf.stop -ItemType File   (采样脚本发现这个文件就写汇总并退出)
#   只汇总已有的 CSV: powershell -NoProfile -File scripts\acceptance\sample-cpu-performance.ps1 -Summarize -Out <目录>\cpu-perf.csv
# 汇总行: min、平均、低于 100% 的采样占比;只要 min < 100 就把「采样期间低于 100%」写出来,这一轮的计时项不作数,要等频率恢复后重量。
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$StopFile = '',
  [int]$IntervalSec = 5,
  [switch]$Summarize
)
$ErrorActionPreference = 'Stop'

function Write-Summary([string]$csv) {
  $rows = Import-Csv -LiteralPath $csv
  if (-not $rows) { Write-Output 'SUMMARY {"samples":0}'; return }
  $vals = @($rows | Where-Object { $_.perf -ne 'NaN' } | ForEach-Object { [double]$_.perf })
  if (-not $vals.Count) { Write-Output 'SUMMARY {"samples":0,"note":"没有取到有效读数"}'; return }
  $min = ($vals | Measure-Object -Minimum).Minimum
  $avg = ($vals | Measure-Object -Average).Average
  $below = @($vals | Where-Object { $_ -lt 100 }).Count
  $obj = [ordered]@{
    samples = $vals.Count; minPct = [math]::Round($min, 1); avgPct = [math]::Round($avg, 1)
    belowFullPct = [math]::Round(100.0 * $below / $vals.Count, 1)
    first = $rows[0].time; last = $rows[-1].time
    verdict = $(if ($min -lt 100) { '采样期间 % Processor Performance 低于 100%,这一轮的计时项不作数' } else { '全程不低于 100%,计时项可以作数' })
  }
  Write-Output ('SUMMARY ' + ($obj | ConvertTo-Json -Compress))
}

if ($Summarize) { Write-Summary $Out; exit 0 }

$dir = Split-Path -Parent $Out
if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
'time,perf' | Set-Content -LiteralPath $Out -Encoding utf8
$counter = '\Processor Information(_Total)\% Processor Performance'
while ($true) {
  if ($StopFile -and (Test-Path -LiteralPath $StopFile)) { break }
  try {
    $v = (Get-Counter -Counter $counter -SampleInterval 1 -MaxSamples 1).CounterSamples[0].CookedValue
    ('{0},{1}' -f (Get-Date).ToString('o'), [math]::Round($v, 1)) | Add-Content -LiteralPath $Out -Encoding utf8
  } catch {
    ('{0},{1}' -f (Get-Date).ToString('o'), 'NaN') | Add-Content -LiteralPath $Out -Encoding utf8
  }
  Start-Sleep -Seconds ([math]::Max(1, $IntervalSec - 1))
}
Write-Summary $Out | Tee-Object -FilePath ($Out + '.summary.txt')
