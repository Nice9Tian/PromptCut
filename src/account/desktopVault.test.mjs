import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

test('native vault script parses and actual Windows DPAPI/ACL/atomic replacement roundtrips only recovery', { skip: process.platform !== 'win32' }, async () => {
  const source = await fs.readFile(new URL('../../desktop/src-tauri/src/account_vault.rs', import.meta.url), 'utf8');
  const script = /const SCRIPT: &str = r#"([\s\S]*?)"#;/.exec(source)?.[1]?.replace(/\r\n/g, '\n');
  assert.ok(script);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-account-vault-test-'));
  const program = String.raw`
$ErrorActionPreference='Stop'; $fixture=[Console]::In.ReadToEnd()|ConvertFrom-Json
$tokens=$null; $errors=$null; [Management.Automation.Language.Parser]::ParseInput($fixture.script,[ref]$tokens,[ref]$errors)|Out-Null
if ($errors.Count) { throw 'native script syntax' }
$prefix=$fixture.script.Substring(0,$fixture.script.IndexOf('try {'+[char]10+' $file='))
$prefix=$prefix.Replace('$inputData=[Console]::In.ReadToEnd()|ConvertFrom-Json','$inputData=$fixture')
Invoke-Expression $prefix
$file=[IO.Path]::Combine($fixture.directory,'credential.dpapi')
SaveVault @{version=1;deviceId='fixture';recoveryToken='fixture-recovery-first';requestId=$null}
$first=ReadVault; if ($first.recoveryToken -ne 'fixture-recovery-first') { throw 'first-open' }
SaveVault @{version=1;deviceId='fixture';recoveryToken='fixture-recovery-rotated';requestId='fixture-request'}
$second=ReadVault; if ($second.recoveryToken -ne 'fixture-recovery-rotated' -or $second.requestId -ne 'fixture-request') { throw 'replace-open' }
$raw=[Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($file)); if ($raw.Contains('fixture-recovery') -or $raw.Contains('password') -or $raw.Contains('accessToken')) { throw 'plaintext' }
$acl=[IO.Directory]::GetAccessControl($fixture.directory); if (!$acl.AreAccessRulesProtected) { throw 'unprotected-acl' }
$current=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) { if ($rule.IdentityReference.Value -notin @($current,'S-1-5-18')) { throw 'foreign-acl' } }
if ((Get-ChildItem -LiteralPath $fixture.directory).Count -ne 1) { throw 'temporary-leftover' }
[Console]::Write('vault-ok')`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', program], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', c => stdout += c); child.stderr.on('data', c => stderr += c);
  child.stdin.end(JSON.stringify({ script, directory }));
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.equal(code, 0, stderr); assert.equal(stdout, 'vault-ok');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
