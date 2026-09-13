import test from 'node:test';
import assert from 'node:assert/strict';
import { saveCardDefinition, applyCardDefinition, patchCardDefinition, cloneCardClipInstance } from './cardAuthoring.mjs';
import { projectCardGraph } from './cardGraph.mjs';
const base={width:64,height:64,fps:10,duration:2,media:[{id:'media',url:'/@media/a.png'}],
  tracks:[{id:'track',clips:[{id:'a',mediaId:'media',start:0,end:1},{id:'b',mediaId:'media',start:1,end:2}]}]};
const definition={id:'custom',language:'python',kind:'filter',entry:'Card',source:'class Card:\n def card(self,source,time): return source.time(time)',defaults:{gain:1}};
test('one definition has independent instances and survives a project round trip',()=>{
  const saved=saveCardDefinition(base,definition);
  const a=applyCardDefinition(saved,{cardId:'custom',clipId:'a',nodeId:'a-effect',params:{gain:.25}}).project;
  const b=applyCardDefinition(a,{cardId:'custom',clipId:'b',nodeId:'b-effect',params:{gain:.75}}).project;
  const reopened=JSON.parse(JSON.stringify(b));const graph=projectCardGraph(reopened);
  assert.equal(reopened.cardDefinitions.length,1);assert.equal(reopened.cardNodes.length,2);
  assert.deepEqual(reopened.cardNodes.map(n=>n.params.gain),[.25,.75]);
  assert.equal(graph.nodes.find(n=>n.id==='a-effect').inputs.source.nodeId,'@clip/a/source');
  assert.equal(graph.nodes.find(n=>n.id==='b-effect').inputs.source.nodeId,'@clip/b/source');
  assert.equal(base.cardNodes,undefined);assert.equal(base.tracks[0].clips[0].nodeId,undefined);
});
test('source editing is literal, retains definition identity and rejects stale/cyclic input',()=>{
  const edited=patchCardDefinition(definition,{find:'source.time(time)',replace:'"$&"'});
  assert.match(edited.source,/"\$&"/);assert.equal(edited.id,definition.id);
  assert.throws(()=>patchCardDefinition(definition,{find:'missing',replace:'x'}),/matched 0/);
  const saved=saveCardDefinition(base,definition);
  assert.throws(()=>applyCardDefinition(saved,{cardId:'custom',clipId:'a',nodeId:'loop',inputs:{source:{nodeId:'loop'}}}),/cycle/);
  assert.equal(saved.cardNodes,undefined);
});
test('split clone continues card time and compensates its own media edge',()=>{
  const project={cardNodes:[{id:'old',adapter:'python',definitionId:'custom',params:{gain:1},inputs:{source:{nodeId:'@clip/a/source'},external:{nodeId:'@clip/b/source',offset:2}}}]};
  const cloned=cloneCardClipInstance(project,'a','copy','old',2);
  assert.notEqual(cloned.nodeId,'old');
  const node=cloned.project.cardNodes[1];
  assert.equal(node.definitionId,'custom');assert.equal(node.timeOffset,2);assert.equal(node.inputs.source.nodeId,'@clip/copy/source');assert.equal(node.inputs.source.offset,-2);
  assert.equal(node.inputs.external.nodeId,'@clip/b/source');assert.equal(project.cardNodes.length,1);
});
