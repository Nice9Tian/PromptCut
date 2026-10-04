param([string] $ControlFile, [ValidateSet('read','arm','restore','init-test','edit-test','delete-test')] [string] $Mode)
$ErrorActionPreference = 'Stop'
$c = Get-Content -LiteralPath $ControlFile -Raw -Encoding UTF8 | ConvertFrom-Json
if ($c.kind -ne 'promptcut-association-lease-v1') { throw 'Unexpected control format' }
$testKey = $c.key -match '^Software\\PromptCut\\ReopenTests\\[a-f0-9]{32}\\command$'
$defaultKey = $c.key -ceq 'Software\Classes\PromptCut Project\shell\open\command'
if (-not ($testKey -or $defaultKey)) { throw 'Unexpected registry target' }
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
    if (-not $defaultKey) { return }
    Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class ReopenAssociationNotify { [DllImport("shell32.dll")] public static extern void SHChangeNotify(uint e, uint f, IntPtr a, IntPtr b); }'
    [ReopenAssociationNotify]::SHChangeNotify(0x08000000,0,[IntPtr]::Zero,[IntPtr]::Zero)
}
if ($Mode -eq 'init-test') {
    if (-not $testKey -or (Read-State).keyExists) { throw 'Fresh owned test key required' }
    $k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($c.key)
    try {$k.SetValue('', 'owned-original', [Microsoft.Win32.RegistryValueKind]::String)} finally {$k.Close()}
} elseif ($Mode -eq 'edit-test') {
    if (-not $testKey) { throw 'Owned test key required' }
    $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($c.key,$true)
    try {$k.SetValue('', 'owned-external-change', [Microsoft.Win32.RegistryValueKind]::String)} finally {$k.Close()}
} elseif ($Mode -eq 'delete-test') {
    if (-not $testKey) { throw 'Owned test key required' }
    [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree(($c.key -replace '\\command$',''),$false)
} elseif ($Mode -eq 'arm') {
    if ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -ge [long]$c.expiresAt) { exit 78 }
    if (-not (Same-State (Read-State) $c.original)) { exit 73 }
    if ($defaultKey) {
        $choice = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.proc\UserChoice')
        if ($choice) {$choice.Close(); exit 74}
        $ext = [Microsoft.Win32.Registry]::ClassesRoot.OpenSubKey('.proc')
        try {if (-not $ext -or $ext.GetValue('') -cne 'PromptCut Project') {exit 75}} finally {if ($ext) {$ext.Close()}}
    }
    if (-not $c.original.keyExists -or -not $c.original.valueExists -or $c.original.valueKind -ne 'String') { exit 76 }
    $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($c.key,$true)
    try {$k.SetValue('', $c.command, [Microsoft.Win32.RegistryValueKind]::String)} finally {$k.Close()}
    Notify-Association
} elseif ($Mode -eq 'restore') {
    $now = Read-State
    if (Same-State $now $c.original) { [pscustomobject]@{restored=$true;alreadyOriginal=$true} | ConvertTo-Json -Compress; exit 0 }
    if (-not $now.valueExists -or $now.valueKind -ne 'String' -or $now.value -cne $c.command) {
        [pscustomobject]@{restored=$false;externalChangePreserved=$true} | ConvertTo-Json -Compress; exit 71
    }
    $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($c.key,$true)
    try {$k.SetValue('', $c.original.value, [Microsoft.Win32.RegistryValueKind]::String)} finally {$k.Close()}
    Notify-Association
    [pscustomobject]@{restored=(Same-State (Read-State) $c.original);alreadyOriginal=$false} | ConvertTo-Json -Compress
} else {Read-State | ConvertTo-Json -Compress}
