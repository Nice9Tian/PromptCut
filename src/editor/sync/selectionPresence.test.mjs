import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setSelectionLink, selectionPresenceStatus } from './selectionPresence.ts';
import { createServer } from 'vite';

test('018 account selection publisher: empty first, multi-select revisions, detach and legacy isolation', async () => {
  const sent = [];
  const link = { request: async message => { sent.push(message); return { type: 'selection.ok' }; } };
  let selection = [];
  const listeners = new Set();
  const source = { readSelection: () => selection, subscribe: listener => {
    listeners.add(listener); return () => listeners.delete(listener);
  } };
  const select = ids => { selection = ids; for (const listener of listeners) listener(); };
  try {
    setSelectionLink(link, 'p1', source);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].selection.clipIds, []);
    assert.equal(sent[0].revision, 1);
    assert.equal(sent[0].projectId, 'p1');
    const pageId = sent[0].pageId;
    assert.equal(typeof pageId, 'string');
    select(['c1', 'c2']);
    assert.deepEqual(sent.at(-1).selection.clipIds, ['c1', 'c2']);
    assert.equal(sent.at(-1).revision, 2);
    select(['c1', 'c2']);
    assert.equal(sent.length, 2, 'same selection does not republish');
    select([]);
    assert.deepEqual(sent.at(-1).selection.clipIds, []);
    assert.equal(sent.at(-1).revision, 3);
    setSelectionLink(null, null);
    assert.equal(selectionPresenceStatus().linked, false);
    setSelectionLink(link, 'p2', source);
    assert.notEqual(sent.at(-1).pageId, pageId, 'new page binding gets a distinct page ID');
    assert.equal(sent.at(-1).projectId, 'p2');
  } finally { setSelectionLink(null, null); }
});

test('018 browser module binding reads the real editor store through Vite', async () => {
  const vite = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    const publisher = await vite.ssrLoadModule('/src/editor/sync/selectionPresence.ts');
    const { actions } = await vite.ssrLoadModule('/src/store/project.ts');
    const sent = [];
    const link = { request: async message => { sent.push(message); return { type: 'selection.ok' }; } };
    publisher.setSelectionLink(link, 'p1');
    for (let i = 0; i < 20 && !sent.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(sent[0]?.selection.clipIds, []);
    actions.select(['c1', 'c2']);
    assert.deepEqual(sent.at(-1).selection.clipIds, ['c1', 'c2']);
    publisher.setSelectionLink(null, null);
    actions.select([]);
  } finally { await vite.close(); }
});
