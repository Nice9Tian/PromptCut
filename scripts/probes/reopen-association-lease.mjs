/** Temporary open-command lease. Registry writes require an explicit caller opt-in.
 * --self-test uses a unique owned registry key, never the .proc association.
 * A separate hidden watchdog restores the original value on timeout/owner exit.
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadNativeFixture, nativeTestEnv } from './reopen-native-fixture.mjs';

const moduleFile = fileURLToPath(import.meta.url), script = path.join(path.dirname(moduleFile), 'reopen-association-lease.ps1');
const shellDir = path.join(process.env.SystemRoot || '', 'System32/WindowsPowerShell/v1.0');
const psExe = path.join(shellDir, 'powershell.exe');
const shaText = text => createHash('sha256').update(text).digest('hex');
function psEnv() {
  const env = nativeTestEnv();
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'PSMODULEPATH') delete env[key];
  return { ...env, PSModulePath: path.join(shellDir, 'Modules') };
}
function run(control, mode, allowFailure = false) {
  try {
    const output = execFileSync(psExe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-ControlFile', control, '-Mode', mode], {
      windowsHide: true, env: psEnv(), encoding: 'utf8', stdio: ['ignore','pipe','pipe'],
    }).trim();
    return { code: 0, result: output ? JSON.parse(output) : null };
  } catch (e) {
    if (!allowFailure) throw new Error(`association ${mode} failed (${e.status})`);
    return { code: e.status, result: e.stdout?.trim() ? JSON.parse(e.stdout) : null };
  }
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function startAssociationLease(fixtureFile, entry, runRoot, { allowDefault = false, ttlMs = 30000, testKey } = {}) {
  const fixture = loadNativeFixture(fixtureFile);
  assert(fixture.standaloneLaunch, 'standalone fixture required');
  assert(fixture.copies.some(c => c.exe === entry.exe && c.runtime === entry.runtime));
  const rel = path.relative(fixture.root, fs.realpathSync(runRoot));
  assert(rel && !rel.startsWith('..') && !path.isAbsolute(rel));
  assert(testKey || allowDefault, 'temporary default open-command change requires explicit opt-in');
  assert(ttlMs > 0 && ttlMs <= 30000);
  const nonce = randomBytes(16).toString('hex');
  const control = path.join(runRoot, `association-${nonce}.json`);
  const c = { kind: 'promptcut-association-lease-v1', ownerPid: process.pid, expiresAt: Date.now()+ttlMs,
    key: testKey || 'Software\\Classes\\PromptCut Project\\shell\\open\\command', command: `"${entry.exe}" "%1"` };
  const persist = () => fs.writeFileSync(control, JSON.stringify(c)); persist();
  if (testKey) run(control, 'init-test');
  c.original = run(control, 'read').result; c.expiresAt=Date.now()+ttlMs; persist();
  const watchdog = spawn(process.execPath, [moduleFile, '--watch', control], {windowsHide:true,detached:true,env:psEnv(),stdio:'ignore'});
  const readyFile=control+'.watchdog-ready.json';
  const ended = new Promise((resolve,reject) => {watchdog.once('error',reject);watchdog.once('close',code=>resolve(code));});
  for(let i=0;!fs.existsSync(readyFile)&&i<100;i++){assert.equal(watchdog.exitCode,null);await sleep(20);}
  assert(fs.existsSync(readyFile),'watchdog ready required before changing a value');
  assert.equal(JSON.parse(fs.readFileSync(readyFile,'utf8')).pid,watchdog.pid);
  const armed = run(control,'arm',true);
  if(armed.code!==0){fs.writeFileSync(control+'.stop','stop');await ended;throw new Error(`association arm refused (${armed.code})`);}
  let restored;
  return {control, watchdog, ended, originalCommandSha256:shaText(c.original.value),
    commandSha256:shaText(c.command), temporaryDefaultChanged:!testKey,
    async restore(){
      restored=run(control,'restore',true);
      fs.writeFileSync(control+'.stop','stop');
      const watchdogCode=await ended;
      assert.equal(restored.code,0,'restore must preserve original value');
      assert.equal(watchdogCode,0,'watchdog must verify restoration');
      assert.deepEqual(run(control,'read').result,c.original);
      return {restored:true,watchdogCode,originalCommandSha256:shaText(c.original.value),commandSha256:shaText(c.command)};
    },
    async expired(){const code=await ended;return {code,restored:run(control,'read').result.value===c.original.value};},
    cleanupTest(){assert(testKey);run(control,'delete-test');},
  };
}

async function watch(control) {
  process.stdout.on('error', e => {if(e.code!=='EPIPE') throw e;});
  const c=JSON.parse(fs.readFileSync(control,'utf8'));
  assert.equal(c.kind,'promptcut-association-lease-v1');
  assert(Number.isInteger(c.ownerPid)&&c.ownerPid>0&&Number.isFinite(c.expiresAt));
  assert(c.expiresAt-Date.now()<=30000);
  fs.writeFileSync(control+'.watchdog-ready.json',JSON.stringify({pid:process.pid}));
  while(Date.now()<c.expiresAt&&!fs.existsSync(control+'.stop')) {
    try {process.kill(c.ownerPid,0);} catch {break;}
    await sleep(100);
  }
  const result=run(control,'restore',true);
  fs.writeFileSync(control+'.watchdog-result.json',JSON.stringify({code:result.code,...result.result}));
  console.log(JSON.stringify({code:result.code,...result.result}));
  process.exitCode=result.code;
}
async function selfTest(fixtureFile) {
  const f=loadNativeFixture(fixtureFile), root=fs.mkdtempSync(path.join(f.root,'lease-test-'));
  const key=()=>`Software\\PromptCut\\ReopenTests\\${randomBytes(16).toString('hex')}\\command`;
  const explicit=await startAssociationLease(fixtureFile,f.copies[1],root,{testKey:key(),ttlMs:15000});
  const normal=await explicit.restore();explicit.cleanupTest();
  const timed=await startAssociationLease(fixtureFile,f.copies[1],root,{testKey:key(),ttlMs:1500});
  const expired=await timed.expired();assert.equal(expired.code,0);assert(expired.restored);timed.cleanupTest();
  const changed=await startAssociationLease(fixtureFile,f.copies[1],root,{testKey:key(),ttlMs:1500});
  run(changed.control,'edit-test');
  const refused=await changed.expired();assert.equal(refused.code,71);assert.equal(run(changed.control,'read').result.value,'owned-external-change');changed.cleanupTest();
  const owner=spawn(process.execPath,[moduleFile,'--owner-exit-test',fixtureFile],{windowsHide:true,env:psEnv(),stdio:['ignore','pipe','pipe']});
  let ownerOutput='';owner.stdout.on('data',b=>{ownerOutput+=b;});owner.stderr.resume();
  assert.equal(await new Promise((resolve,reject)=>{owner.once('error',reject);owner.once('close',resolve);}),0);
  const ownerReceipt=JSON.parse(ownerOutput.trim());
  const ownerDeadline=Date.now()+10000;
  while(!fs.existsSync(ownerReceipt.control+'.watchdog-result.json')&&Date.now()<ownerDeadline) await sleep(100);
  const restoredOwner=JSON.parse(fs.readFileSync(ownerReceipt.control+'.watchdog-result.json','utf8'));
  assert.equal(restoredOwner.code,0);assert(restoredOwner.restored);
  assert.equal(run(ownerReceipt.control,'read').result.value,'owned-original');run(ownerReceipt.control,'delete-test');
  const result={ok:true,normal,timeoutRestored:expired.restored,timeoutWatchdogCode:expired.code,externalChangePreserved:true,
    ownerExitRestored:true,ownerExitWatchdogCode:restoredOwner.code,defaultAssociationChanged:false,evidenceDirectory:root};
  fs.writeFileSync(path.join(root,'self-test.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}
if (path.resolve(process.argv[1]||'')===moduleFile) {
  if(process.argv[2]==='--watch') await watch(process.argv[3]);
  else if(process.argv[2]==='--owner-exit-test') {
    const f=loadNativeFixture(process.argv[3]), root=fs.mkdtempSync(path.join(f.root,'lease-owner-exit-'));
    const lease=await startAssociationLease(process.argv[3],f.copies[1],root,{testKey:`Software\\PromptCut\\ReopenTests\\${randomBytes(16).toString('hex')}\\command`,ttlMs:30000});
    console.log(JSON.stringify({control:lease.control}));process.exit(0);
  }
  else {assert.equal(process.argv[2],'--self-test');await selfTest(process.argv[3]);}
}
