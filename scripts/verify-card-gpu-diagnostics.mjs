/** Actual LPAC + browser + vision HTTP error transport, not a mocked shader. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'vite';
import {saveCardDefinition,applyCardDefinition} from '../src/kernel/cardAuthoring.mjs';
process.env.PROMPTCUT_ROLE='prerender';
const server=await createServer({configFile:'vite.prerender.config.ts',server:{host:'127.0.0.1',port:5199,strictPort:true}});
const base={id:'shader-error-'+randomUUID(),width:64,height:64,fps:10,duration:1,themeId:'default',media:[],tracks:[{id:'main',kind:'video',clips:[]}]};
const definition={id:'broken-shader',language:'python',entry:'Card',kind:'animation',need_prerendering:false,compositing:'independent',source:`class Card:
 need_prerendering=False
 def __init__(self,style=None): self.shader=GLSL('void main(){outColor=vec4(missing_uniform,0.,0.,1.);}')
 def card(self,source,time): return self.shader(time=time)
`};
const project=applyCardDefinition(saveCardDefinition(base,definition),{cardId:definition.id,trackId:'main',start:0,end:1,newClipId:'broken-clip',nodeId:'broken-node'}).project;
try{
 await server.listen();
 const response=await fetch('http://127.0.0.1:5199/api/vision/snapshot',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({project,t:0,clipId:'broken-clip'}),signal:AbortSignal.timeout(120000)});
 const result=await response.json();
 assert.ok(!response.ok,'Invalid GLSL unexpectedly produced a successful frame');
 assert.match(result.error,/GLSL compilation failed/);
 assert.match(result.error,/missing_uniform/,'Compiler symbol diagnostic was dropped by see_frames transport');
 assert.match(result.error,/undeclared|not declared/i,'Compiler cause was dropped by see_frames transport');
 console.log('PASS actual see_frames compiler diagnostic',JSON.stringify({status:response.status,error:result.error}));
}finally{await server.close();}
