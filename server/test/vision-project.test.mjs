import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolateClip } from '../vision-project.mjs';
import { projectCardGraph } from '../../src/kernel/cardGraph.mjs';

const project = {
  width: 64, height: 64, fps: 30, duration: 2,
  media: [{ id: 'a', kind: 'image', url: 'a.png' }, { id: 'b', kind: 'image', url: 'b.png' }],
  cardDefinitions: [{ id: 'mix', language: 'python', entry: 'Card', kind: 'transition', source: 'class Card: pass', compositing: 'independent' }],
  cardNodes: [{ id: 'mix-node', adapter: 'python', definitionId: 'mix', inputs: { A: { nodeId: '@clip/a/source' }, B: { nodeId: '@clip/b/source' } } }],
  tracks: [
    { id: 'top', clips: [{ id: 'a', mediaId: 'a', start: 0, end: 2 }, { id: 'target', nodeId: 'mix-node', start: 0, end: 2 }] },
    { id: 'bottom', clips: [{ id: 'b', mediaId: 'b', start: 0, end: 2 }] },
  ],
};
test('clip-only vision retains same-track and cross-track graph inputs in a legacy project', () => {
  const original = structuredClone(project);
  const isolated = isolateClip(project, 'target', { preserveContext: true });
  const graph = projectCardGraph(isolated.project);
  assert.ok(graph.nodes.some(node => node.id === '@clip/a/source'));
  assert.ok(graph.nodes.some(node => node.id === '@clip/b/source'));
  assert.deepEqual(isolated.project.tracks.filter(track => !track.hidden).flatMap(track => track.clips.map(clip => clip.id)), ['target']);
  assert.deepEqual(isolated.project.media, project.media);
  assert.equal(new Set(isolated.project.tracks.map(track => track.id)).size, isolated.project.tracks.length);
  assert.deepEqual(project, original);
});
test('context-dependent vision retains the lower scene while hiding upper outputs', () => {
  const input = structuredClone(project);
  input.cardDefinitions[0].compositing = 'context';
  input.tracks.unshift({ id: 'above', clips: [{ id: 'cover', start: 0, end: 2 }] });
  const isolated = isolateClip(input, 'target', { preserveContext: true });
  assert.equal(isolated.context, true);
  assert.deepEqual(isolated.project.tracks.filter(track => !track.hidden).flatMap(track => track.clips.map(clip => clip.id)), ['a', 'target', 'b']);
  assert.equal(isolateClip(input, 'missing'), null);
});
