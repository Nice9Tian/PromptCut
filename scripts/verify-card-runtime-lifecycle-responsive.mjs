/** Actual lifecycle responsiveness regression. Uses the real named ACL mutex to
 * make B's open pending; A's worker traffic must not wait behind it. */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
const root=process.cwd(), base=path.join(root,'work','card-runtime-lifecycle-responsive');
const runner=process.argv[2] ?? path.join(root,'tools','card-runtime','target','release','promptcut-card-runtime.exe');
const runtime=process.argv[3] ?? path.join(root,'desktop','src-tauri','runtime','python');
await rm(base,{recursive:true,force:true}); for(const d of ['a','b','c','d','e','eof'].flatMap(x=>[`${x}-input`,`${x}-output`,`${x}-temp`])) await mkdir(path.join(base,d),{recursive:true});
const proc=spawn(runner,[],{cwd:path.dirname(runner),windowsHide:true,stdio:['pipe','pipe','pipe']}); let buffer=''; const pending=new Map();
proc.stderr.on('data',d=>process.stderr.write(`RUNNER STDERR ${d}`));
proc.stdout.on('data',d=>{buffer+=d;for(;;){const n=buffer.indexOf('\n');if(n<0)return;const line=buffer.slice(0,n);buffer=buffer.slice(n+1);const m=JSON.parse(line);const p=pending.get(m.id);if(!p)throw new Error(`unexpected ${line}`);pending.delete(m.id);p.resolve(m)}});
function request(id,op,scope,payload={}) { return new Promise((resolve,reject)=>{const t=setTimeout(()=>{pending.delete(id);reject(new Error(`timeout ${id}`))},120000); pending.set(id,{resolve:m=>{clearTimeout(t);resolve(m)}});proc.stdin.write(JSON.stringify({id,op,scope,revision:'lifecycle',payload})+'\n',e=>e&&reject(e));}); }
const graph={nodes:[{id:'n',adapter:'python',definitionId:'ok',params:{},inputs:{}}]};
const okay={id:'ok',entry:'Card',need_prerendering:false,source:`class Card:\n def __init__(self,style=None): pass\n def card(self,source,time): return GLSL('void main(){outColor=vec4(0.,1.,0.,1.);}')()`};
const open=(id,scope,prefix)=>request(id,'open',scope,{runtimeDir:runtime,inputDirs:[path.join(base,`${prefix}-input`)],outputDir:path.join(base,`${prefix}-output`),tempDir:path.join(base,`${prefix}-temp`),workers:1});
const evaluate=(id,scope)=>request(id,'evaluate',scope,{graph,definitions:[okay],style:{},nodeId:'n',time:0,outputDir:path.join(base,'a-output')});
function mutexHolder(){ const code="$m=[System.Threading.Mutex]::new($false,'Local\\PromptCut.CardRuntime.AclTransaction.v1'); if(!$m.WaitOne(5000)){exit 2}; Write-Output READY; Start-Sleep -Seconds 5; $m.ReleaseMutex(); $m.Dispose()"; const p=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',code],{windowsHide:true,stdio:['ignore','pipe','pipe']}); const exit=new Promise(resolve=>p.on('exit',resolve)); return new Promise((resolve,reject)=>{let out='';p.stdout.on('data',d=>{out+=d;if(out.includes('READY'))resolve({p,exit})});p.on('exit',c=>{if(!out.includes('READY'))reject(new Error(`mutex holder exit ${c}`))});}); }
try {
 assert.equal((await open('open-a','a','a')).ok,true); assert.equal((await evaluate('a-before','a')).ok,true);
 const holder=await mutexHolder();
 const pendingOpen=open('open-b','b','b');
 await new Promise(r=>setTimeout(r,150));
 let t=performance.now(); const duplicate=await open('open-b-duplicate','b','b'); const duplicateMs=Math.round(performance.now()-t);
 assert.equal(duplicate.ok,false,JSON.stringify(duplicate)); assert.equal(duplicate.error?.code,'scope_exists',JSON.stringify(duplicate)); assert(duplicateMs<2000,`duplicate open took ${duplicateMs}ms`);
 t=performance.now(); const busyClose=await request('close-b-while-opening','close','b'); const busyCloseMs=Math.round(performance.now()-t);
 assert.equal(busyClose.ok,false,JSON.stringify(busyClose)); assert.equal(busyClose.error?.code,'scope_busy',JSON.stringify(busyClose)); assert(busyCloseMs<2000,`pending close took ${busyCloseMs}ms`);
 const pendingC=open('open-c','c','c'); const pendingD=open('open-d','d','d');
 t=performance.now(); const overCap=await open('open-e-over-capacity','e','e'); const capMs=Math.round(performance.now()-t);
 assert.equal(overCap.ok,false,JSON.stringify(overCap)); assert.equal(overCap.error?.code,'scope_capacity',JSON.stringify(overCap)); assert(capMs<2000,`capacity rejection took ${capMs}ms`);
 t=performance.now(); const during=await evaluate('a-during-b-open','a'); const duringMs=Math.round(performance.now()-t);
 assert.equal(during.ok,true,JSON.stringify(during)); assert(duringMs<2000,`A evaluate took ${duringMs}ms while B open waited`);
 const openedB=await pendingOpen; assert.equal(openedB.ok,true,JSON.stringify(openedB)); assert.equal((await pendingC).ok,true); assert.equal((await pendingD).ok,true); await holder.exit;
 let closeComplete=false; const pendingClose=request('close-b','close','b').then(value=>{closeComplete=true;return value}); await new Promise(r=>setTimeout(r,20)); assert.equal(closeComplete,false,'B close completed before A overlap probe');
 t=performance.now(); const after=await evaluate('a-during-b-close','a'); const closeOverlapMs=Math.round(performance.now()-t);
 assert.equal(after.ok,true,JSON.stringify(after)); assert(closeOverlapMs<2000,`A evaluate took ${closeOverlapMs}ms while B close ran`);
 assert.equal((await pendingClose).ok,true); for(const scope of ['a','c','d']) assert.equal((await request(`close-${scope}`,'close',scope)).ok,true);
 console.log(`LPAC_LIFECYCLE_RESPONSIVE_SUCCESS ${JSON.stringify({duringBOpenMs:duringMs,duringBCloseMs:closeOverlapMs,duplicateMs,busyCloseMs,capMs})}`);
} finally { proc.stdin.end(); }
const exit=await new Promise(resolve=>proc.on('exit',(code,signal)=>resolve({code,signal}))); assert.equal(exit.code,0,JSON.stringify(exit));
// An EOF during an admitted-but-not-yet-open scope must drain lifecycle work,
// clean it, and leave no Python child of this runner.
const eofHolder=await mutexHolder(); const eof=spawn(runner,[],{cwd:path.dirname(runner),windowsHide:true,stdio:['pipe','pipe','pipe']}); let eofOut='',eofErr='';
eof.stdout.on('data',d=>eofOut+=d); eof.stderr.on('data',d=>eofErr+=d);
eof.stdin.write(JSON.stringify({id:'eof-open',op:'open',scope:'eof',revision:'lifecycle',payload:{runtimeDir:runtime,inputDirs:[path.join(base,'eof-input')],outputDir:path.join(base,'eof-output'),tempDir:path.join(base,'eof-temp'),workers:1}})+'\n'); eof.stdin.end();
const eofExit=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('EOF pending open exceeded 120s')),120000); eof.on('exit',(code,signal)=>{clearTimeout(timer);resolve({code,signal})})}); await eofHolder.exit;
assert.equal(eofExit.code,0,JSON.stringify({eofExit,eofOut,eofErr}));
const childPython=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`@(Get-CimInstance Win32_Process -Filter \"ParentProcessId = ${eof.pid}\" | Where-Object { $_.Name -match '^python' }).Count`],{encoding:'utf8',windowsHide:true}).trim();
assert.equal(childPython,'0',`Python child survived EOF cleanup for runner ${eof.pid}`);
console.log(`LPAC_LIFECYCLE_EOF_SUCCESS ${JSON.stringify({runnerPid:eof.pid,childPython})}`);
