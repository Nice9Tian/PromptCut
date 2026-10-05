# Read-only queries for the installed-application reopen probe. Nothing here writes the
# registry, starts a program or stops a process.
#   -Mode assoc                 which program Windows runs for a .proc file (effective association)
#   -Mode processes -Exe <exe>  every running process of that executable and its WebView2 debugging ports
#   -Mode watch -Exe <exe>      one JSON line per process of that executable started after this watcher
param(
    [Parameter(Mandatory = $true)][ValidateSet('assoc', 'processes', 'watch')][string] $Mode,
    [string] $Exe,
    [int] $TimeoutSec = 3600
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
function Emit($value) { [Console]::Out.WriteLine(($value | ConvertTo-Json -Compress -Depth 5)); [Console]::Out.Flush() }
function Utc($date) { if ($date) { $date.ToUniversalTime().ToString('o') } else { $null } }
function Row($p) {
    $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)" -ErrorAction SilentlyContinue
    [pscustomobject]@{
        pid = [int]$p.ProcessId; exe = $p.ExecutablePath; commandLine = $p.CommandLine; createdAt = (Utc $p.CreationDate)
        parentPid = [int]$p.ParentProcessId; parentName = $parent.Name; parentCreatedAt = (Utc $parent.CreationDate)
    }
}

if ($Mode -eq 'assoc') {
    Add-Type -TypeDefinition @'
using System; using System.Text; using System.Runtime.InteropServices;
public static class PromptCutAssociation {
    [DllImport("Shlwapi.dll", CharSet = CharSet.Unicode)]
    static extern uint AssocQueryString(uint flags, uint str, string assoc, string extra, StringBuilder buffer, ref uint length);
    public static string Query(uint str, string extension) {
        uint length = 4096; var buffer = new StringBuilder((int)length);
        return AssocQueryString(0, str, extension, null, buffer, ref length) == 0 ? buffer.ToString() : null;
    }
}
'@
    $choice = 'Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.proc\UserChoice'
    $classes = 'Registry::HKEY_CLASSES_ROOT\.proc'
    Emit ([pscustomobject]@{
        exe = [PromptCutAssociation]::Query(2, '.proc'); command = [PromptCutAssociation]::Query(1, '.proc')
        progId = $(if (Test-Path -LiteralPath $classes) { (Get-Item -LiteralPath $classes).GetValue('') } else { $null })
        userChoice = $(if (Test-Path -LiteralPath $choice) { (Get-ItemProperty -LiteralPath $choice).ProgId } else { $null })
    })
    exit 0
}

if (-not $Exe) { throw '-Exe is required' }
$name = [IO.Path]::GetFileNameWithoutExtension($Exe)
$same = { param($path) $path -and $path.Equals($Exe, [StringComparison]::OrdinalIgnoreCase) }

if ($Mode -eq 'processes') {
    $all = Get-CimInstance Win32_Process
    $apps = @($all | Where-Object { & $same $_.ExecutablePath })
    $ids = @($apps | ForEach-Object { [int]$_.ProcessId })
    # The WebView2 browser process is normally a child of the application; its command line names the host program too.
    $hostFlag = '--webview-exe-name=' + [regex]::Escape([IO.Path]::GetFileName($Exe))
    $views = @($all | Where-Object { $_.Name -eq 'msedgewebview2.exe' -and $_.CommandLine -match '--remote-debugging-port=(\d+)' -and ($ids -contains [int]$_.ParentProcessId -or $_.CommandLine -match $hostFlag) } |
        ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; parentPid = [int]$_.ParentProcessId; port = [int]([regex]::Match($_.CommandLine, '--remote-debugging-port=(\d+)').Groups[1].Value) } })
    Emit ([pscustomobject]@{ processes = @($apps | ForEach-Object { Row $_ }); webviews = $views })
    exit 0
}

# watch: a second launch only lives until it has handed its file to the running window,
# so poll the cheap process list quickly and ask WMI about each new id once.
$seen = @{}
foreach ($p in [Diagnostics.Process]::GetProcessesByName($name)) { $seen[$p.Id] = $true }
Emit ([pscustomobject]@{ watching = $true; existing = $seen.Count })
$deadline = (Get-Date).AddSeconds($TimeoutSec)
while ((Get-Date) -lt $deadline) {
    foreach ($p in [Diagnostics.Process]::GetProcessesByName($name)) {
        if ($seen.ContainsKey($p.Id)) { continue }
        $seen[$p.Id] = $true
        $row = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.Id)" -ErrorAction SilentlyContinue
        if (-not $row) { Emit ([pscustomobject]@{ pid = [int]$p.Id; exitedBeforeQuery = $true }); continue }
        if (& $same $row.ExecutablePath) { Emit (Row $row) }
    }
    Start-Sleep -Milliseconds 40
}
exit 0
