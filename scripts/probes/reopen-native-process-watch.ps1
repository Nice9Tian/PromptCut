param([int] $NativePid, [string] $ExpectedExe, [ValidateSet('watch','stop')] [string] $Mode, [string] $StartedTicks)
$ErrorActionPreference='Stop'
try {$p=[System.Diagnostics.Process]::GetProcessById($NativePid)} catch {if($Mode -eq 'stop'){exit 0};throw}
if (-not $p.MainModule.FileName.Equals($ExpectedExe,[StringComparison]::OrdinalIgnoreCase)) {throw 'Unexpected process executable'}
$ticks=$p.StartTime.ToUniversalTime().Ticks.ToString()
if ($Mode -eq 'stop') {
    if ($ticks -cne $StartedTicks) {throw 'Process identity changed'}
    $p.Kill();$p.WaitForExit();exit 0
}
$null=$p.Handle
[pscustomobject]@{pid=$NativePid;startedTicks=$ticks} | ConvertTo-Json -Compress
$p.WaitForExit()
exit $p.ExitCode
