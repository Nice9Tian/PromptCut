import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCardDefinition, selectedCardStyle, validateCardGraph, projectCardGraph } from './cardGraph.mjs';

const definition = () => ({ id: 'tint', language: 'python', kind: 'filter', entry: 'Tint', source: 'class Tint: pass', need_prerendering: false });
test('definitions retain executable source as data and style use remains optional', () => {
  const def = normalizeCardDefinition(definition());
  assert.equal(def.source, definition().source);
  assert.equal(def.compositing, 'unknown');
  const style = { color: '#fff', font: 'sans' };
  assert.deepEqual(selectedCardStyle(def, style), style);
  assert.deepEqual(selectedCardStyle({ ...def, styleKeys: [] }, style), {});
  assert.deepEqual(selectedCardStyle({ ...def, styleKeys: ['color'] }, style), { color: '#fff' });
  assert.throws(() => normalizeCardDefinition({ ...def, entry: '../escape' }), /class name/);
});
test('multi-input graph batches independent work and rejects cycles and missing inputs', () => {
  const nodes = [
    { id: 'a', adapter: 'media' }, { id: 'b', adapter: 'media' },
    { id: 'mix', adapter: 'python', inputs: { A: { nodeId: 'a', offset: 2 }, B: 'b' } },
  ];
  const graph = validateCardGraph({ nodes, outputs: ['mix'] });
  assert.deepEqual(graph.levels, [['a', 'b'], ['mix']]);
  assert.deepEqual(graph.nodes[2].inputs.A, { nodeId: 'a', offset: 2, rate: 1 });
  assert.deepEqual(nodes[2].inputs.A, { nodeId: 'a', offset: 2 });
  assert.throws(() => validateCardGraph({ nodes: [{ id: 'a', adapter: 'python', inputs: { source: 'b' } }], outputs: ['a'] }), /missing input/);
  assert.throws(() => validateCardGraph({ nodes: nodes.map(n => n.id === 'a' ? { ...n, inputs: { source: 'mix' } } : n), outputs: ['mix'] }), /cycle/);
});
test('old effects and new Python cards appear in one graph with ordered outputs', () => {
  const project = { cardDefinitions: [definition()], cardNodes: [{ id: 'py', adapter: 'python', definitionId: 'tint', inputs: { source: '@clip/media/source' } }],
    media: [{ id: 'm', url: 'image.png' }], filters: [{ id: 'f', ops: [{ kind: 'blur', value: 2 }] }],
    tracks: [
      { id: 'top', clips: [{ id: 'custom', nodeId: 'py', start: 5, end: 6 }] },
      { id: 'bottom', clips: [{ id: 'media', mediaId: 'm', start: 0, end: 10, filter: { id: 'f' }, emphasis: { shadow: true } }] },
    ] };
  const graph = projectCardGraph(project);
  assert.deepEqual(graph.outputs.map(out => out.clipId), ['media', 'custom']);
  assert.ok(graph.nodes.some(n => n.adapter === 'filter'));
  assert.ok(graph.nodes.some(n => n.adapter === 'emphasis'));
  assert.ok(graph.nodes.some(n => n.adapter === 'python'));
  assert.equal(graph.nodes.find(n => n.id === 'py').inputs.source.nodeId, '@clip/media/source');
});
