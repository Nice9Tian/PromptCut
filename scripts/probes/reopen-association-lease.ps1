param([string] $ControlFile, [ValidateSet('read','arm','restore','init-test','edit-test','delete-test','edit-probe-test','delete-probe-edit-test')] [string] $Mode)
$ErrorActionPreference = 'Stop'
$c = Get-Content -LiteralPath $ControlFile -Raw -Encoding UTF8 | ConvertFrom-Json
if ($c.kind -ne 'promptcut-association-lease-v1') { throw 'Unexpected control format' }
$testKey = $c.key -match '^Software\\PromptCut\\ReopenTests\\[a-f0-9]{32}\\command$'
$defaultKey = $c.key -ceq 'Software\Classes\PromptCut Project\shell\open\command'
$extensionKey = $c.key -ceq 'Software\Classes\.proc'
$hasProbe = $null -ne $c.ownedProgId
if (-not ($testKey -or $defaultKey -or $extensionKey)) { throw 'Unexpected registry target' }
if ($hasProbe -and ($c.ownedProgId -cnotmatch '^PromptCut\.ReopenTest\.[a-f0-9]{32}$' -or $c.command -cne $c.ownedProgId -or $c.probeCommand -cnotmatch '^"[A-Za-z]:\\[^"\r\n]+\.exe" "%1"$')) { throw 'Unexpected probe ProgID' }
if ($extensionKey -and -not $hasProbe) { throw 'Owned probe ProgID required' }
$probePath = $(if ($hasProbe) {'Software\Classes\' + $c.ownedProgId} else {$null})
if ($c.faultAfterProbeStep -and (-not $testKey -or $c.faultAfterProbeStep -lt 1 -or $c.faultAfterProbeStep -gt 6)) {throw 'Fault injection requires owned test key'}
function Probe-Fault([int] $Step) {if ($c.faultAfterProbeStep -eq $Step) {throw 'Injected owned probe creation failure'}}
function Probe-Unchanged([bool] $AllowPartial = $false) {
    if (-not $hasProbe) { return $false }
    $shape = @(
        @{path='';values=@{''='PromptCut isolated recovery test'};subs=@('shell')},
        @{path='\shell';values=@{''='open'};subs=@('open')},
        @{path='\shell\open';values=@{};subs=@('command')},
        @{path='\shell\open\command';values=@{''=$c.probeCommand};subs=@()}
    )
    foreach ($node in $shape) {
        $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($probePath + $node.path)
        if (-not $k) { if ($AllowPartial) {continue}; return $false }
        try {
            if (-not $AllowPartial -and ($k.GetValueNames().Count -ne $node.values.Count -or $k.GetSubKeyNames().Count -ne $node.subs.Count)) { return $false }
            foreach ($name in $k.GetValueNames()) {
                if (-not $node.values.ContainsKey($name) -or $k.GetValueKind($name).ToString() -cne 'String' -or $k.GetValue($name) -cne $node.values[$name]) { return $false }
            }
            foreach ($name in $k.GetSubKeyNames()) {if ($node.subs -cnotcontains $name) {return $false}}
        } finally {$k.Close()}
    }
    return $true
}
function Cleanup-Probe {
    if (-not $hasProbe) { return $null }
    $existing = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($probePath)
    if (-not $existing) { return $true }
    $existing.Close()
    # An interrupted creation may contain only a subset of this run's exact tree.
    # Retain observed external changes. Registry scan/delete is not a transaction;
    # delete only the known leaves, rechecking before each step rather than
    # recursively swallowing a new, unknown child subtree.
    foreach ($suffix in @('\shell\open\command','\shell\open','\shell','')) {
        if (-not (Probe-Unchanged $true)) { return $false }
        $existing = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($probePath + $suffix)
        if ($existing) {$existing.Close(); [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKey($probePath + $suffix,$false)}
    }
    return $true
}
function Read-State {
    $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($c.key)
    try {
        $exists = $k -and ($k.GetValueNames() -contains '')
        [pscustomobject]@{keyExists=($null -ne $k);valueExists=[bool]$exists;value=$(if ($exists) {$k.GetValue('', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)} else {$null});valueKind=$(if ($exists) {$k.GetValueKind('').ToString()} else {$null})}
    } finally { if ($k) {$k.Close()} }
}
function Same-State($a, $b) {
    ($a.keyExists -eq $b.keyExists) -and ($a.valueExists -eq $b.valueExists) -and ($a.value -ceq $b.value) -and ($a.valueKind -ceq $b.valueKind)
}
function Notify-Association {
    if (-not ($defaultKey -or $extensionKey)) { return }
    Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class ReopenAssociationNotify { [DllImport("shell32.dll")] public static extern void SHChangeNotify(uint e, uint f, IntPtr a, IntPtr b); }'
    # SHCNF_IDLIST | SHCNF_FLUSH: wait for affected Shell components to receive
    # the association notification before exposing the short operator window.
    # This does not change UserChoice or establish that Explorer will route a
    # subsequent click correctly; the native matching receipt remains required.
    [ReopenAssociationNotify]::SHChangeNotify(0x08000000,0x1000,[IntPtr]::Zero,[IntPtr]::Zero)
}
if ($Mode -eq 'init-test') {
    if (-not $testKey -or (Read-State).keyExists) { throw 'Fresh owned test key required' }
    $k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($c.key)
    try {$k.SetValue('', 'owned-original', [Microsoft.Win32.RegistryValueKind]::String)} finally {$k.Close()}
} elseif ($Mode -eq 'edit-probe-test' -or $Mode -eq 'delete-probe-edit-test') {
    if (-not $testKey -or -not $hasProbe) {throw 'Owned test key and probe required'}
    $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($probePath,$true)
    if (-not $k) {throw 'Owned test probe missing'}
    try {
        if ($Mode -eq 'edit-probe-test') {
            if ($k.GetValueNames() -contains 'owned-test-extra') {throw 'Fresh test value required'}
            $k.SetValue('owned-test-extra','owned-extra-change',[Microsoft.Win32.RegistryValueKind]::String)
        } else {
            if ($k.GetValue('owned-test-extra') -cne 'owned-extra-change') {throw 'Unexpected test value'}
            $k.DeleteValue('owned-test-extra')
        }
    } finally {$k.Close()}
} elseif ($Mode -eq 'edit-test') {
    if (-not $testKey) { throw 'Owned test key required' }
    $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($c.key,$true)
    try {$k.SetValue('', 'owned-external-change', [Microsoft.Win32.RegistryValueKind]::String)} finally {$k.Close()}
} elseif ($Mode -eq 'delete-test') {
    if (-not $testKey) { throw 'Owned test key required' }
    [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree(($c.key -replace '\\command$',''),$false)
    $null = Cleanup-Probe
} elseif ($Mode -eq 'arm') {
    if ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -ge [long]$c.expiresAt) { exit 78 }
    if (-not (Same-State (Read-State) $c.original)) { exit 73 }
    if ($defaultKey -or $extensionKey) {
        $choice = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.proc\UserChoice')
        if ($choice) {$choice.Close(); exit 74}
        $ext = [Microsoft.Win32.Registry]::ClassesRoot.OpenSubKey('.proc')
        try {if (-not $ext -or $ext.GetValue('') -cne 'PromptCut Project') {exit 75}} finally {if ($ext) {$ext.Close()}}
    }
    if (-not $c.original.keyExists -or -not $c.original.valueExists -or $c.original.valueKind -ne 'String') { exit 76 }
    if ($extensionKey -and $c.original.value -cne 'PromptCut Project') {exit 75}
    if ($hasProbe) {
        $existing = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($probePath)
        if ($existing) {$existing.Close();exit 77}
        $k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($probePath)
        Probe-Fault 1
        try {$k.SetValue('', 'PromptCut isolated recovery test', [Microsoft.Win32.RegistryValueKind]::String)} finally {$k.Close()}
        Probe-Fault 2
        $k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($probePath + '\shell')
        Probe-Fault 3
        try {$k.SetValue('', 'open', [Microsoft.Win32.RegistryValueKind]::String)} finally {$k.Close()}
        Probe-Fault 4
        $k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($probePath + '\shell\open\command')
        Probe-Fault 5
        try {$k.SetValue('', $c.probeCommand, [Microsoft.Win32.RegistryValueKind]::String)} finally {$k.Close()}
        Probe-Fault 6
        if (-not (Probe-Unchanged)) {throw 'Owned ProgID creation verification failed'}
    }
    if (-not (Same-State (Read-State) $c.original)) {exit 73}
    $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($c.key,$true)
    try {$k.SetValue('', $c.command, [Microsoft.Win32.RegistryValueKind]::String)} finally {$k.Close()}
    Notify-Association
} elseif ($Mode -eq 'restore') {
    $now = Read-State
    if (Same-State $now $c.original) {
        $removed = Cleanup-Probe
        [pscustomobject]@{restored=$true;alreadyOriginal=$true;ownedProgIdRemoved=$removed;cleanupComplete=($removed -ne $false)} | ConvertTo-Json -Compress
        if ($removed -eq $false) {exit 79}; exit 0
    }
    if (-not $now.valueExists -or $now.valueKind -ne 'String' -or $now.value -cne $c.command) {
        [pscustomobject]@{restored=$false;externalChangePreserved=$true} | ConvertTo-Json -Compress; exit 71
    }
    $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($c.key,$true)
    try {$k.SetValue('', $c.original.value, [Microsoft.Win32.RegistryValueKind]::String)} finally {$k.Close()}
    Notify-Association
    $removed = Cleanup-Probe
    [pscustomobject]@{restored=(Same-State (Read-State) $c.original);alreadyOriginal=$false;ownedProgIdRemoved=$removed;cleanupComplete=($removed -ne $false)} | ConvertTo-Json -Compress
    if ($removed -eq $false) {exit 79}
} else {Read-State | ConvertTo-Json -Compress}
