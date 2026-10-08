//! Windows-only, main-editor bridge. Passwords and access credentials never go on disk.
use std::io::Write;
use std::process::{Command, Stdio};
use tauri::Manager;

const SCRIPT: &str = r#"
$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Security
$inputData=[Console]::In.ReadToEnd()|ConvertFrom-Json
function ProtectDirectory($dir) {
  if ([IO.Directory]::Exists($dir) -and (([IO.File]::GetAttributes($dir) -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { throw 'invalid-vault-directory' }
  [IO.Directory]::CreateDirectory($dir)|Out-Null
  $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl=[Security.AccessControl.DirectorySecurity]::new(); $acl.SetAccessRuleProtection($true,$false); $acl.SetOwner($sid)
  $inherit=[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl',$inherit,'None','Allow'))
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-18'),'FullControl',$inherit,'None','Allow'))
  [IO.Directory]::SetAccessControl($dir,$acl)
}
function SaveVault($record) {
  ProtectDirectory $inputData.directory
  $bytes=[Text.Encoding]::UTF8.GetBytes(($record|ConvertTo-Json -Compress -Depth 8))
  $sealed=[Security.Cryptography.ProtectedData]::Protect($bytes,[Text.Encoding]::UTF8.GetBytes('PromptCut-account-v1'),[Security.Cryptography.DataProtectionScope]::CurrentUser)
  $tmp=$file+'.tmp-'+[Guid]::NewGuid().ToString('N')
  try { $stream=[IO.FileStream]::new($tmp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try { $stream.Write($sealed,0,$sealed.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    if ([IO.File]::Exists($file)) { [IO.File]::Replace($tmp,$file,[NullString]::Value) } else { [IO.File]::Move($tmp,$file) }
  } finally { if ([IO.File]::Exists($tmp)) { [IO.File]::Delete($tmp) } }
}
function ReadVault {
  if (![IO.File]::Exists($file)) { return $null }
  $bytes=[Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($file),[Text.Encoding]::UTF8.GetBytes('PromptCut-account-v1'),[Security.Cryptography.DataProtectionScope]::CurrentUser)
  return ([Text.Encoding]::UTF8.GetString($bytes)|ConvertFrom-Json)
}
function Http($path,$body,$token) {
  Add-Type -AssemblyName System.Net.Http
  $handler=[Net.Http.HttpClientHandler]::new(); $handler.AllowAutoRedirect=$false; $handler.UseCookies=$false
  $client=[Net.Http.HttpClient]::new($handler); $client.Timeout=[TimeSpan]::FromSeconds(20)
  $request=[Net.Http.HttpRequestMessage]::new(); $request.RequestUri=[Uri]('https://visuhive.com'+$path)
  $request.Method=if ($null -eq $body) { [Net.Http.HttpMethod]::Get } else { [Net.Http.HttpMethod]::Post }
  if ($null -ne $body) { $request.Content=[Net.Http.StringContent]::new(($body|ConvertTo-Json -Depth 80 -Compress),[Text.Encoding]::UTF8,'application/json') }
  if ($token) { $request.Headers.Authorization=[Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer',$token) }
  try { $response=$client.SendAsync($request,[Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
    try { if ($response.Content.Headers.ContentLength -gt 2097152) { throw 'too-large' }
      $stream=$response.Content.ReadAsStreamAsync().GetAwaiter().GetResult(); $memory=[IO.MemoryStream]::new(); $buffer=New-Object byte[] 8192
      try { while (($read=$stream.Read($buffer,0,$buffer.Length)) -gt 0) { if ($memory.Length+$read -gt 2097152) { throw 'too-large' }; $memory.Write($buffer,0,$read) }
        $value=[Text.UTF8Encoding]::new($false,$true).GetString($memory.ToArray())|ConvertFrom-Json
      } finally { $stream.Dispose(); $memory.Dispose() }
      if (!$response.IsSuccessStatusCode -or !$value.ok) { return @{ok=$false;status=[int]$response.StatusCode;code=if ($value.code) {$value.code} else {'cloud-request-failed'}} }
      return $value
    } finally { $response.Dispose() }
  } finally { $request.Dispose(); $client.Dispose(); $handler.Dispose() }
}
try {
 $file=[IO.Path]::Combine($inputData.directory,'credential.dpapi'); $argsData=$inputData.args
 switch ($inputData.operation) {
  'login' { $value=Http '/api/account/editor/login' $argsData $null
    if ($value.ok) { SaveVault @{version=1;deviceId=$argsData.deviceId;recoveryToken=$value.recoveryToken;requestId=$null} }; $result=$value }
  'recover' { $saved=ReadVault
    if ($null -eq $saved) { $result=$null; break }
    if ($saved.version -ne 1 -or $saved.deviceId -ne $argsData.deviceId -or !$saved.recoveryToken) { throw 'invalid-vault' }
    if (!$saved.requestId) { $saved.requestId=[Guid]::NewGuid().ToString(); SaveVault $saved }
    $value=Http '/api/account/editor/recover' @{recoveryToken=$saved.recoveryToken;deviceId=$saved.deviceId;requestId=$saved.requestId} $null
    if ($value.ok) { SaveVault @{version=1;deviceId=$saved.deviceId;recoveryToken=$value.recoveryToken;requestId=$null} }; $result=$value }
  'logout' { $value=Http '/api/account/editor/logout' @{} $argsData.accessToken
    if ($value.ok -or $value.status -eq 401) { if ([IO.File]::Exists($file)) { [IO.File]::Delete($file) } }; $result=$value }
  'request' { $path=$argsData.path
    if ($path -notin @('/hosted/shared/account/create','/hosted/shared/account/join','/hosted/shared/account/session')) { throw 'bad-path' }
    if (!$argsData.accessToken -or $null -eq $argsData.body) { throw 'bad-request' }
    $result=Http $path $argsData.body $argsData.accessToken }
  default { throw 'bad-operation' }
 }
 [Console]::Write(($result|ConvertTo-Json -Compress -Depth 80))
} catch { [Console]::Write('{"ok":false,"status":503,"code":"desktop-account-bridge"}') }
"#;

#[tauri::command]
pub async fn account_bridge(window: tauri::WebviewWindow, operation: String, args: serde_json::Value) -> Result<serde_json::Value, String> {
    let url = window.url().map_err(|_| "desktop-account-bridge")?;
    if window.label() != "main" || url.scheme() != "http" || url.host_str() != Some("127.0.0.1") || url.port() != Some(5210) || url.path() != "/" {
        return Err("desktop-account-forbidden".into());
    }
    if !["login", "recover", "logout", "request"].contains(&operation.as_str()) || !args.is_object() { return Err("desktop-account-request".into()); }
    let directory = window.app_handle().path().app_data_dir().map_err(|_| "desktop-account-storage")?.join("account-v1");
    let input = serde_json::to_vec(&serde_json::json!({"operation":operation,"args":args,"directory":directory})).map_err(|_| "desktop-account-request")?;
    if input.len() > 1024 * 1024 { return Err("desktop-account-request-too-large".into()); }
    tauri::async_runtime::spawn_blocking(move || execute(input)).await.map_err(|_| "desktop-account-bridge".to_string())?
}

#[cfg(windows)]
fn execute(input: Vec<u8>) -> Result<serde_json::Value, String> {
    use std::os::windows::process::CommandExt;
    static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = SERIAL.lock().map_err(|_| "desktop-account-bridge")?;
    let mut child = Command::new("powershell.exe").args(["-NoProfile", "-NonInteractive", "-Command", SCRIPT])
        .creation_flags(0x08000000).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|_| "desktop-account-bridge")?;
    let write = child.stdin.take().ok_or("desktop-account-bridge")?.write_all(&input);
    if write.is_err() { let _ = child.kill(); let _ = child.wait(); return Err("desktop-account-bridge".into()); }
    let output = child.wait_with_output().map_err(|_| "desktop-account-bridge")?;
    if !output.status.success() || output.stdout.len() > 2 * 1024 * 1024 { return Err("desktop-account-bridge".into()); }
    serde_json::from_slice(&output.stdout).map_err(|_| "desktop-account-bridge".into())
}
#[cfg(not(windows))]
fn execute(_: Vec<u8>) -> Result<serde_json::Value, String> { Err("desktop-account-vault-unavailable".into()) }
