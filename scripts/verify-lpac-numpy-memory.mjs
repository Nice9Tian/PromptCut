import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
const root=process.cwd();
const base=path.join(root,'work','card-runtime-smoke','lpac-numpy-memory');
await rm(base,{recursive:true,force:true});
for(const d of ['input','output','temp']) await mkdir(path.join(base,d),{recursive:true});
const runner=path.resolve(process.argv[2]||path.join(root,'tools','card-runtime','target','release','promptcut-card-runtime.exe'));
const runtime=path.resolve(process.argv[3]||path.join(root,'desktop','src-tauri','runtime','python'));
const p=spawn(runner,[],{cwd:path.dirname(runner),windowsHide:true,stdio:['pipe','pipe','pipe']});
let buf='', done=false; const send=x=>p.stdin.write(JSON.stringify(x)+'\n');
const finish=(code=0)=>{if(done)return;done=true;p.stdin.end();process.exitCode=code;};
p.stderr.on('data',d=>process.stderr.write('RUNNER STDERR '+d));
p.stdout.on('data',d=>{buf+=d;for(;;){const n=buf.indexOf('\n');if(n<0)return;const line=buf.slice(0,n);buf=buf.slice(n+1);let m;try{m=JSON.parse(line)}catch(e){console.error(line);finish(1);return}console.log('RUNNER',JSON.stringify(m));if(m.id==='open'){assert.equal(m.ok,true,JSON.stringify(m));const source=`import os, ctypes, threading, numpy as np
class Card:
 def __init__(self, style=None): pass
 def private_mib(self):
  class PMC(ctypes.Structure):
   _fields_=[('cb',ctypes.c_ulong),('PageFaultCount',ctypes.c_ulong),('PeakWorkingSetSize',ctypes.c_size_t),('WorkingSetSize',ctypes.c_size_t),('QuotaPeakPagedPoolUsage',ctypes.c_size_t),('QuotaPagedPoolUsage',ctypes.c_size_t),('QuotaPeakNonPagedPoolUsage',ctypes.c_size_t),('QuotaNonPagedPoolUsage',ctypes.c_size_t),('PagefileUsage',ctypes.c_size_t),('PeakPagefileUsage',ctypes.c_size_t),('PrivateUsage',ctypes.c_size_t)]
  psapi=ctypes.WinDLL('psapi'); kernel=ctypes.WinDLL('kernel32'); kernel.GetCurrentProcess.restype=ctypes.c_void_p; psapi.GetProcessMemoryInfo.argtypes=(ctypes.c_void_p,ctypes.POINTER(PMC),ctypes.c_ulong); psapi.GetProcessMemoryInfo.restype=ctypes.c_int; x=PMC(); x.cb=ctypes.sizeof(x); ok=psapi.GetProcessMemoryInfo(kernel.GetCurrentProcess(),ctypes.byref(x),x.cb); return x.PrivateUsage//(1024*1024) if ok else -1
 def card(self, source, time):
  before=self.private_mib(); threads_before=threading.active_count()
  a=np.ones((1080,1920,4),dtype=np.float32); b=np.full_like(a,2.0); c=a+b
  value=float(c[17,23,2]); after=self.private_mib(); threads_after=threading.active_count()
  keys=('OPENBLAS_NUM_THREADS','OMP_NUM_THREADS','MKL_NUM_THREADS','NUMEXPR_NUM_THREADS','VECLIB_MAXIMUM_THREADS','BLIS_NUM_THREADS')
  return {'privateMiBBefore':before,'privateMiBAfter':after,'pythonThreadsBefore':threads_before,'pythonThreadsAfter':threads_after,'threadEnvAllOne':all(os.environ.get(k)=='1' for k in keys),'sumValue':value,'arrayBytes':int(a.nbytes+b.nbytes+c.nbytes)}
`;send({id:'evaluate',op:'evaluate',scope:'numpy-memory',revision:'r1',payload:{graph:{nodes:[{id:'memory-node',adapter:'python',definitionId:'memory',params:{},inputs:{}}]},definitions:[{id:'memory',entry:'Card',source,need_prerendering:false}],style:{},nodeId:'memory-node',time:0,fps:30,outputDir:path.join(base,'output')}})}else if(m.id==='evaluate'){assert.equal(m.ok,true,JSON.stringify(m));const v=m.result;assert.equal(v.threadEnvAllOne,true,JSON.stringify(v));assert.equal(v.sumValue,3,JSON.stringify(v));assert.equal(v.arrayBytes,1920*1080*4*4*3,JSON.stringify(v));assert.ok(v.privateMiBAfter>=v.privateMiBBefore,JSON.stringify(v));console.log('LPAC_NUMPY_MEMORY_SUCCESS',JSON.stringify(v));send({id:'close',op:'close',scope:'numpy-memory',revision:'r1',payload:{}})}else if(m.id==='close'){assert.equal(m.ok,true,JSON.stringify(m));finish();}}});
p.on('exit',(code,signal)=>{console.log('RUNNER_EXIT',code,signal);if(!done||code!==0)process.exitCode=1;});
send({id:'open',op:'open',scope:'numpy-memory',revision:'r1',payload:{runtimeDir:runtime,inputDirs:[path.join(base,'input')],outputDir:path.join(base,'output'),tempDir:path.join(base,'temp'),workers:1}});
setTimeout(()=>{if(!done){console.error('TIMEOUT');finish(1);p.kill();}},90000).unref();

