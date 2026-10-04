/** Manual ComputerUse handoff for a real Explorer default-file double click.
 * No UI input is injected here. The operator opens the pending folder, writes the
 * ready sentinel, then double-clicks the observed file after the lease is armed.
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { startAssociationLease } from './reopen-association-lease.mjs';
import { loadNativeFixture, nativeTestEnv } from './reopen-native-fixture.mjs';

const script=path.join(path.dirname(fileURLToPath(import.meta.url)),'reopen-native-process-watch.ps1');
const shellDir=path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0');
const ps=path.join(shellDir,'powershell.exe');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const cleanPath=p=>p.replace(/^\\\\\?\\/,'');
const environmentKeys=['PC_REOPEN_NATIVE_ROOT','PC_REOPEN_NATIVE_BROWSER_DIR','PROMPTCUT_AI_CONFIG','PROMPTCUT_CLI_HOME',
  'PROMPTCUT_AGY_SETTINGS','PROMPTCUT_CLAUDE_CONFIG','PROMPTCUT_CODEX_CONFIG','PROMPTCUT_SKILL_DIR',
  'PROMPTCUT_PROJECTS_DIR','PROMPTCUT_RUNTIME_DIR','PROMPTCUT_AGENT_CDP','PROMPTCUT_NO_PORT_FILE',
  'PROMPTCUT_AUTO_RENDER_NODE','PROMPTCUT_PUSH','PROMPTCUT_QUEUE_NODE','PROMPTCUT_LAN_HOST'];
function watchEnv(){
  const env=nativeTestEnv();for(const k of Object.keys(env))if(k.toUpperCase()==='PSMODULEPATH')delete env[k];
  return {...env,PSModulePath:path.join(shellDir,'Modules')};
}
export function prepareStandaloneLaunch(fixtureFile, entry, file, env) {
  const f=loadNativeFixture(fixtureFile);assert(f.standaloneLaunch);
  const root=fs.realpathSync(env.PC_REOPEN_NATIVE_ROOT), rel=path.relative(f.root,root);
  assert(rel&&!rel.startsWith('..')&&!path.isAbsolute(rel));
  assert.equal(fs.realpathSync(file),file);
  assert(path.relative(root,file)&&!path.relative(root,file).startsWith('..'));
  const launchId=randomBytes(16).toString('hex');
  const privateEnv=Object.fromEntries(environmentKeys.filter(k=>env[k]!==undefined).map(k=>[k,env[k]]));
  fs.writeFileSync(path.join(f.root,'launch.json'),JSON.stringify({kind:'promptcut-fixture-launch-v1',launchId,env:privateEnv}));
  return {f,root,launchId};
}
export async function explorerNativeLaunch(fixtureFile, entry, file, env, {secondary=false}={}) {
  const isolatedDefaultProgId=process.argv.includes('--isolated-default-progid');
  assert(process.argv.includes(isolatedDefaultProgId?'--allow-temporary-default-progid':'--allow-temporary-open-command'),'explicit temporary association permission flag required');
  const {f,root,launchId}=prepareStandaloneLaunch(fixtureFile,entry,file,env);
  const pendingFile=path.resolve('work/native-association-pending.json');
  // Keep later control writes outside Explorer's displayed project directory.
  // A newly enumerated file can move the project between observation and click.
  const controlRoot=path.join(root,'association-control');
  fs.mkdirSync(controlRoot,{recursive:true});
  const readyFile=path.join(controlRoot,`association-ready-${launchId}`);
  const pending={kind:'promptcut-native-double-click-v1',stage:'waiting-for-explorer',launchId,file,folder:root,readyFile,
    fixtureFile,exe:entry.exe,secondary,createdAt:new Date().toISOString()};
  const persist=()=>fs.writeFileSync(pendingFile,JSON.stringify(pending,null,2));persist();
  console.log(JSON.stringify({phase:'waiting-for-real-explorer-double-click',pendingFile,secondary}));
  const readyDeadline=Date.now()+300000;
  while(!fs.existsSync(readyFile)&&Date.now()<readyDeadline)await pause(100);
  assert(fs.existsSync(readyFile),'operator did not prepare Explorer');
  const lease=await startAssociationLease(fixtureFile,entry,controlRoot,{allowDefault:true,isolatedDefaultProgId});
  pending.stage='armed';pending.armedAt=new Date().toISOString();persist();
  let receipt, watcher, restored;
  try {
    const deadline=Date.now()+25000, receiptFile=path.join(f.root,'launch-receipt.json');
    while(Date.now()<deadline){
      if(fs.existsSync(receiptFile)){try{const r=JSON.parse(fs.readFileSync(receiptFile,'utf8'));if(r.launchId===launchId){receipt=r;break;}}catch{}}
      await pause(50);
    }
    assert(receipt,'real Explorer launch receipt required');
    assert.equal(receipt.kind,'promptcut-fixture-launched-v1');assert.equal(cleanPath(receipt.exe),entry.exe);assert.equal(cleanPath(receipt.file),file);
    assert(Number.isInteger(receipt.pid)&&receipt.pid>0);
    // Restore immediately after the native bootstrap proves the OS passed the file.
    restored=await lease.restore();pending.stage='restored';pending.restoredAt=new Date().toISOString();persist();
    if(isolatedDefaultProgId)assert.equal(restored.ownedProgIdRemoved,true,'temporary owned ProgID must be cleaned');
    const result={launchId,nativePid:receipt.pid,secondary,osFileLaunch:true,association:restored,
      armedAt:pending.armedAt,restoredAt:pending.restoredAt,secondaryExitCodeObserved:false};
    if(!secondary){
      watcher=spawn(ps,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-NativePid',String(receipt.pid),'-ExpectedExe',entry.exe,'-Mode','watch'],{
        windowsHide:true,env:watchEnv(),stdio:['ignore','pipe','pipe'],
      });
      let output='';watcher.stdout.on('data',b=>{output+=b;});
      for(let i=0;!output.includes('\n')&&i<150;i++){assert.equal(watcher.exitCode,null,'native process watcher exited early');await pause(20);}
      const identity=JSON.parse(output.trim());assert.equal(identity.pid,receipt.pid);
      watcher.nativePid=receipt.pid;
      watcher.kill=()=>{execFileSync(ps,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-NativePid',String(receipt.pid),'-ExpectedExe',entry.exe,'-Mode','stop','-StartedTicks',identity.startedTicks],{windowsHide:true,env:watchEnv(),stdio:'pipe'});return true;};
    }
    fs.writeFileSync(path.join(controlRoot,`association-launch-${launchId}.json`),JSON.stringify(result,null,2));
    return {child:watcher,receipt:result};
  } finally {
    if(!restored){await lease.restore();pending.stage='restored-after-error';pending.restoredAt=new Date().toISOString();persist();}
  }
}
