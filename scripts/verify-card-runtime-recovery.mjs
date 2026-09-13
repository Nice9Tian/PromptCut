/** Actual LPAC regression: a dead Python worker fails once, is replaced, and never strands its FIFO. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
const root=process.cwd(), base=path.join(root,'work','card-runtime-recovery');
await rm(base,{recursive:true,force:true}); for(const d of ['input','output','temp']) await mkdir(path.join(base,d),{recursive:true});
// Optional positional paths allow the same actual regression to target a
// packaged runner/runtime without changing the installed files.
const runner=process.argv[2] ?? path.join(root,'tools','card-runtime','target','release','promptcut-card-runtime.exe');
const runtime=process.argv[3] ?? path.join(root,'desktop','src-tauri','runtime','python');
const proc=spawn(runner,[],{cwd:path.dirname(runner),windowsHide:true,stdio:['pipe','pipe','pipe']});
const common={scope:'recovery',revision:'r1'}; let buffer='', phase='open', closed=false, timer;
const send=v=>proc.stdin.write(JSON.stringify(v)+'\n');
const graph=(id,def)=>({nodes:[{id,adapter:'python',definitionId:def,params:{},inputs:{}}]});
const crash={id:'crash',entry:'Card',need_prerendering:false,source:`import os
class Card:
 def __init__(self,style=None):pass
 def card(self,source,time): os.write(2,b'forced-worker-exit\\n'); os._exit(23)`};
const healthy={id:'healthy',entry:'Card',need_prerendering:false,source:`class Card:
 def __init__(self,style=None):pass
 def card(self,source,time): return GLSL('void main(){outColor=vec4(0.,1.,0.,1.);}')()`};
const slow={id:'slow',entry:'Card',need_prerendering:false,source:`import time as clock
class Card:
 def __init__(self,style=None):pass
 def card(self,source,time): clock.sleep(8); return GLSL('void main(){}')()`};
const evaluate=(id,node,def)=>send({id,op:'evaluate',...common,payload:{graph:graph(node,def.id),definitions:[def],style:{},nodeId:node,time:0,outputDir:path.join(base,'output')}});
function close(){if(closed)return;closed=true;send({id:'close',op:'close',...common,payload:{}})}
proc.stderr.on('data',d=>process.stderr.write('RUNNER STDERR '+d));
proc.stdout.on('data',d=>{buffer+=d;for(;;){const n=buffer.indexOf('\n');if(n<0)return;const line=buffer.slice(0,n);buffer=buffer.slice(n+1);const m=JSON.parse(line);console.log('RUNNER',JSON.stringify(m));
 if(m.id==='open'){assert.equal(m.ok,true,JSON.stringify(m));phase='crash';evaluate('crash-eval','crash-node',crash);evaluate('healthy-queued-after-crash','healthy-node',healthy);continue}
 if(phase==='crash'&&m.id==='crash-eval'){assert.equal(m.ok,false,JSON.stringify(m));assert.equal(m.error?.code,'worker_exited',JSON.stringify(m));assert.match(m.error?.message||'',/forced-worker-exit/,JSON.stringify(m));continue}
 if(phase==='crash'&&m.id==='healthy-queued-after-crash'){assert.equal(m.ok,true,JSON.stringify(m));assert.equal(m.result?.type,'glsl',JSON.stringify(m));phase='cancel';evaluate('slow-active','slow-node',slow);evaluate('slow-queued','slow-node',slow);setTimeout(()=>send({id:'cancel-slow',op:'cancel',...common,payload:{id:'slow-active',requestId:'slow-active'}}),300);continue}
 if(phase==='cancel'&&(m.id==='slow-active'||m.id==='slow-queued')){assert.equal(m.ok,false,JSON.stringify(m));assert.equal(m.error?.code,'card_cancelled',JSON.stringify(m));if(!globalThis.cancelSeen)globalThis.cancelSeen=new Set();globalThis.cancelSeen.add(m.id);if(globalThis.cancelSeen.size===2)phase='healthy-after-cancel';continue}
 if(phase==='cancel'&&m.id==='cancel-slow'){assert.equal(m.ok,true,JSON.stringify(m));if(globalThis.cancelSeen?.size===2){phase='healthy-after-cancel';}continue}
 if(phase==='healthy-after-cancel'){evaluate('healthy-after-cancel','healthy-node',healthy);phase='await-final';continue}
 if(phase==='await-final'&&m.id==='healthy-after-cancel'){assert.equal(m.ok,true,JSON.stringify(m));console.log('LPAC_RECOVERY_SUCCESS');close();continue}
 if(m.id==='close'){assert.equal(m.ok,true,JSON.stringify(m));clearTimeout(timer);proc.stdin.end();}
}});
proc.on('exit',(code,signal)=>{console.log('RUNNER_EXIT',code,signal);if(code!==0||!closed)process.exitCode=1;});
send({id:'open',op:'open',...common,payload:{runtimeDir:runtime,inputDirs:[path.join(base,'input')],outputDir:path.join(base,'output'),tempDir:path.join(base,'temp'),workers:1}});
timer=setTimeout(()=>{console.error('TIMEOUT phase='+phase);proc.kill();process.exitCode=1},45000);timer.unref();



