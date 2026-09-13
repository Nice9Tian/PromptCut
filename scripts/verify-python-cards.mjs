/** Integration fixture: actual packaged Python in LPAC, HTTP and Chrome capture. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PNG } from 'pngjs';
import { createServer } from 'vite';
import { openBakery, bakeFrames } from './export-frames.mjs';
import { saveCardDefinition, applyCardDefinition, patchCardDefinition } from '../src/kernel/cardAuthoring.mjs';

process.env.PROMPTCUT_ROLE = 'prerender';
const root = process.cwd(), dir = path.join(root, 'work', 'card-integration');
await fs.mkdir(dir, { recursive: true });
const server = await createServer({ configFile: path.join(root, 'vite.prerender.config.ts'),
  server: { host: '127.0.0.1', port: 5197, strictPort: true } });
const origin = 'http://127.0.0.1:5197';
const base = { id:'card-integration', width:64, height:64, fps:10, duration:1, themeId:'default',
  media:[], tracks:[{id:'main',kind:'video',clips:[]}], style:{accent:[0,1,0,1], acceptanceRun:randomUUID()} };
const definition = (id, source, more={}) => ({id, language:'python', entry:'Card', kind:'animation', source,
  need_prerendering:false, compositing:'independent', ...more});
const apply = (project, def, args={}) => applyCardDefinition(saveCardDefinition(project,def),
  {cardId:def.id,trackId:'main',start:0,end:1,newClipId:def.id+'-clip',nodeId:def.id+'-node',...args}).project;
const post = async (op, project, extra) => {
  const response=await fetch(origin+'/api/card-runtime/'+op,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({project,...extra}),signal:AbortSignal.timeout(120000)});
  const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));return result;
};
const center = png => { const p=PNG.sync.read(png);return [...p.data.subarray((32*p.width+32)*4,(32*p.width+32)*4+4)]; };
let bakery;
try {
  await server.listen();
  const shader = definition('shader',`class Card:
    need_prerendering = False
    def __init__(self, style=None): self.shader = GLSL('uniform float u_time; void main(){outColor=vec4(u_time,0.,0.,1.);}')
    def card(self, source, time): return self.shader(time=time)
`);
  const realtime=apply(base,shader);
  const registered=await post('visual',realtime,{nodeId:'shader-node',time:.7});
  assert.equal(registered.registered,true);assert.equal(registered.value.uniforms.u_time.op,'time');
  console.log('PASS isolated GLSL registration');

  const pixels=apply(base,definition('pixels',`from PIL import Image
class Card:
    need_prerendering = False
    def __init__(self, style=None): self.style=style
    def card(self, source, time): return Image.new('RGBA',(64,64),(0,int(time*100),0,255))
`));
  const frame=await post('visual',pixels,{nodeId:'pixels-node',time:.7});
  assert.equal(frame.value.type,'pixels');
  assert.deepEqual(center(Buffer.from(await (await fetch(origin+frame.value.url)).arrayBuffer())),[0,70,0,255]);
  const interval=await post('visual',pixels,{nodeId:'pixels-node',time:[.1,.4]});
  assert.equal(interval.frames.length,3);
  console.log('PASS arbitrary Python/Pillow + time interval');

  const audio=apply(base,definition('audio',`import numpy as np
class Card:
    need_prerendering = False
    def __init__(self, style=None): pass
    def card(self, source, time): return AudioBlock(np.tile([.25,.75],(time.count,1)),time.sample_rate,time.start)
`,{kind:'audio'}));
  const block=await post('audio',audio,{nodeId:'audio-node',start:123,count:100,sampleRate:48000});
  const wav=Buffer.from(await (await fetch(origin+block.url)).arrayBuffer());
  assert.equal(wav.length,844); assert.equal(wav.readFloatLE(44),.25);assert.equal(wav.readFloatLE(48),.75);
  console.log('PASS actual NumPy audio block');

  const emptyUrl=origin+'/?export=1&timeline='+encodeURIComponent('data:application/json,'+encodeURIComponent(JSON.stringify(base)));
  bakery=await openBakery({url:emptyUrl});
  const capture=async(project,frames)=>{
    await bakery.reset(project,emptyUrl,{deferCards:true});
    const pictures=new Map();
    await bakeFrames(bakery,{out:dir,targetFrames:frames,fullFrame:true,writeFrames:false,onFrame:(frame,png)=>pictures.set(frame,png)});
    return pictures;
  };
  const shots=await capture(realtime,[7,2]);
  assert.ok(Math.abs(center(shots.get(7))[0]-179)<3,JSON.stringify(center(shots.get(7))));
  assert.ok(Math.abs(center(shots.get(2))[0]-51)<3,JSON.stringify(center(shots.get(2))));
  await fs.writeFile(path.join(dir,'glsl.png'),shots.get(7));
  console.log('PASS real FrameScene GLSL out-of-order screenshot');
  const pythonShots=await capture(pixels,[7]);
  assert.deepEqual(center(pythonShots.get(7)),[0,70,0,255]);
  console.log('PASS real FrameScene Python pixel capture');

  const inputsDir=path.join(root,'out','export-card-integration','media'); await fs.mkdir(inputsDir,{recursive:true});
  for (const [name,color] of [['a',[255,0,0,255]],['b',[0,0,255,255]]]) {
    const data=Buffer.alloc(64*64*4);for(let n=0;n<data.length;n+=4)data.set(color,n);
    await fs.writeFile(path.join(inputsDir,name+'.png'),PNG.sync.write({width:64,height:64,data}));
  }
  const withMedia={...base,media:['a','b'].map(id=>({id,kind:'image',url:`/@export/card-integration/media/${id}.png`})),
    tracks:[...base.tracks,{id:'sources',hidden:true,clips:['a','b'].map(id=>({id,mediaId:id,start:0,end:1,params:{}}))}]};
  const transition=apply(withMedia,definition('transition',`class Card:
    need_prerendering = False
    def __init__(self, style=None): self.shader=GLSL('uniform sampler2D u_input0; uniform sampler2D u_input1; uniform float progress; void main(){outColor=mix(texture(u_input0,v_uv),texture(u_input1,v_uv),progress);}')
    def card(self, source, time): return self.shader(source['A'].time(time),source['B'].time(time),progress=time)
`,{kind:'transition'}),{inputs:{A:{clipId:'a'},B:{clipId:'b'}}});
  const transitionShots=await capture(transition,[2,7]);
  assert.ok(Math.abs(center(transitionShots.get(2))[0]-204)<3);assert.ok(Math.abs(center(transitionShots.get(7))[2]-179)<3);
  console.log('PASS multi-input media GPU transition');
  const algorithm=apply(withMedia,definition('algorithm',`class Card:
    need_prerendering = False
    def __init__(self, style=None): pass
    def card(self, source, time):
        image=source['A'].time(time).array().copy()
        image[:,:,1]=100
        return image
`,{kind:'filter'}),{inputs:{A:{clipId:'a'}}});
  const algorithmShot=await capture(algorithm,[3]);
  assert.deepEqual(center(algorithmShot.get(3)),[255,100,0,255]);
  console.log('PASS Python input pixel materialization and filter');

  // Exercise the exact see_frames HTTP path that failed after installation:
  // optional legacy style omitted, plus dependencies on same/other tracks and
  // an unrelated retained Python node. Hidden source clips must still exist.
  const visionProject = structuredClone(algorithm);
  delete visionProject.style;
  visionProject.cardDefinitions.push(...transition.cardDefinitions);
  visionProject.cardNodes.push(...transition.cardNodes);
  visionProject.tracks[0].clips.unshift(visionProject.tracks[1].clips.shift());
  const visionResponse = await fetch(origin+'/api/vision/snapshot', { method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify({project:visionProject,clipId:'algorithm-clip',t:.3}),signal:AbortSignal.timeout(120000) });
  const visionResult = await visionResponse.json();
  assert.equal(visionResponse.status,200,JSON.stringify(visionResult));
  assert.ok(visionResult.__image?.base64,'Actual see_frames route did not return an image');
  const visionPng=PNG.sync.read(Buffer.from(visionResult.__image.base64,'base64'));
  const offset=(Math.floor(visionPng.height/2)*visionPng.width+Math.floor(visionPng.width/2))*4;
  assert.deepEqual([...visionPng.data.subarray(offset,offset+4)],[255,100,0,255]);
  console.log('PASS real clip-scoped see_frames retains legacy project graph inputs');

  const cascade=apply(realtime,definition('cascade',`class Card:
    need_prerendering = False
    def __init__(self, style=None): pass
    def card(self, source, time):
        image=source.time(time).array().copy()
        image[:,:,1]=100
        return image
`,{kind:'filter'}),{inputs:{source:{nodeId:'shader-node'}}});
  const cascadeShot=await capture(cascade,[3]);
  assert.ok(Math.abs(center(cascadeShot.get(3))[0]-77)<3);
  assert.equal(center(cascadeShot.get(3))[1],100);
  console.log('PASS Python materializes upstream GLSL through GPU broker');

  const chromeSource={...base,tracks:[{id:'main',clips:[{id:'chrome-source',cardId:'punch-pill',start:0,end:1,params:{text:'SOURCE',position:'center'}}]}]};
  const chromeBaseline=await capture(chromeSource,[7]);
  const chromeCopy=apply(chromeSource,definition('chrome-copy',`class Card:
    need_prerendering = False
    def __init__(self, style=None): pass
    def card(self, source, time): return source.time(time).array().copy()
`,{kind:'filter'}),{clipId:'chrome-source'});
  const chromeCopyShot=await capture(chromeCopy,[7]);
  const a=PNG.sync.read(chromeBaseline.get(7)).data, b=PNG.sync.read(chromeCopyShot.get(7)).data;
  let biggestDifference=0;
  for(let i=0;i<a.length;i++) biggestDifference=Math.max(biggestDifference,Math.abs(a[i]-b[i]));
  assert.ok(biggestDifference<=3,`Chrome input materialization differs by ${biggestDifference}`);
  console.log('PASS legacy Chrome source through Python input adapter');

  const stateful=apply(base,definition('stateful',`from PIL import Image
class Card:
    need_prerendering = True
    def __init__(self, style=None): self.counter=0
    def card(self, source, time):
        self.counter+=1
        return Image.new('RGBA',(64,64),(self.counter*10,0,0,128))
`,{need_prerendering:true}));
  const actualState=await post('visual',stateful,{nodeId:'stateful-node',time:.3});
  assert.deepEqual(center(Buffer.from(await(await fetch(origin+actualState.value.url)).arrayBuffer())),[40,0,0,128]);
  const stateShot=await capture(stateful,[3]);
  assert.deepEqual(center(stateShot.get(3)),[40,0,0,128]);
  console.log('STATE screenshot',JSON.stringify(center(stateShot.get(3))));
  await fs.writeFile(path.join(dir,'stateful-direct.png'),stateShot.get(3));
  const framesPost=async(op,more={})=>{
    const response=await fetch(origin+'/api/frames/'+op,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({project:stateful,...more}),signal:AbortSignal.timeout(120000)});
    const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value;
  };
  const pending=await framesPost('see',{times:[.3],lane:'user'});
  assert.equal(pending.incomplete,true);assert.deepEqual(pending.frames[0].missing,['stateful-clip']);
  const final=await framesPost('see',{times:[.3],lane:'agent'});
  assert.equal(final.incomplete,false);assert.deepEqual(center(Buffer.from(await(await fetch(origin+final.frames[0].url)).arrayBuffer())),center(stateShot.get(3)));
  console.log('PASS pending user frame explicit, Agent frame is actual stateful pixels');
  await framesPost('preload');
  for(let n=0;n<120;n++) {
    const status=await framesPost('status');
    if(status.error)throw new Error(status.error);
    if(status.mov){console.log('PASS required -> control MOV -> full MOV cache');break;}
    if(n===119)throw new Error('Background cache did not complete');
    await new Promise(resolve=>setTimeout(resolve,500));
  }

  const styled=apply(base,definition('style',`class Card:
    need_prerendering = False
    def __init__(self, style=None): self.color=style['accent']
    def card(self, source, time): return GLSL('uniform vec4 color; void main(){outColor=color;}')(color=self.color)
`,{styleKeys:['accent']}));
  assert.deepEqual((await post('visual',styled,{nodeId:'style-node',time:0})).value.uniforms.color,[0,1,0,1]);
  styled.style.accent=[0,0,1,1];
  assert.deepEqual((await post('visual',styled,{nodeId:'style-node',time:0})).value.uniforms.color,[0,0,1,1]);
  const reopened=JSON.parse(JSON.stringify(styled));
  const edited=patchCardDefinition(reopened.cardDefinitions[0],{find:'outColor=color;',replace:'outColor=color*.5;'});
  const changed=saveCardDefinition(reopened,edited,{overwrite:true});
  assert.match((await post('visual',changed,{nodeId:'style-node',time:0})).value.fragment,/color\*\.5/);
  console.log('PASS style + create/apply/edit/save/reopen');
  console.log('PASS integration complete');
} finally { await bakery?.close(); await server.close(); }
