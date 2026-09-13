import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { cardMediaPath } from '../card-media-path.mjs';

test('frame media stamping resolves durable path, guarded endpoint, library and export URLs', () => {
  const root = path.join('C:', 'work', 'out', 'frame-library');
  assert.equal(cardMediaPath({ path: 'C:/source/a.mp4' }, root), 'C:/source/a.mp4');
  assert.equal(cardMediaPath({ url: '/api/media/file?path=C%3A%2Fsource%2Fb.mp4' }, root), 'C:/source/b.mp4');
  assert.equal(cardMediaPath({ url: '/@media/clip%20one.mp4' }, root), path.join('C:', 'work', 'out', 'media', 'clip one.mp4'));
  assert.equal(cardMediaPath({ url: '/@export/job-7/media/replaced.png' }, root), path.join('C:', 'work', 'out', 'export-job-7', 'media', 'replaced.png'));
  assert.equal(cardMediaPath({ url: '/@export/job-7/media/../escape.png' }, root), null);
});
