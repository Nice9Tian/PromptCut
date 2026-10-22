/**
 * 在线浏览器里云端项目的地址(`projectAddress.ts`;`docs/semantics/product/platforms.md`「项目直达地址」「分享链接」,
 * 形式见 `mechanism/platforms.md`「项目地址」):直达地址、分享链接、旧的 `?project=` 怎么拼、怎么读,什么样的不认。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectPath, readProjectAddress, sharePath } from './projectAddress.ts';

const id = 'sp_' + 'a'.repeat(26);
const token = 'AbCdEfGhIjKlMnOpQrStUv';
const read = (href, base) => readProjectAddress(new URL(href, 'https://visuhive.com'), base);

test('direct address and share link are built under the editor base, without any version', () => {
  assert.equal(projectPath(id), `/editor/p/${id}`);
  assert.equal(sharePath(id, token), `/editor/s/${id}/${token}`);
  assert.equal(projectPath(id, '/editor'), `/editor/p/${id}`);
  assert.equal(projectPath(id, '/'), `/p/${id}`);
});

test('reads the direct address, the share link and the old query form', () => {
  assert.deepEqual(read(`/editor/p/${id}`), { kind: 'project', projectId: id });
  assert.deepEqual(read(`/editor/p/${id}/`), { kind: 'project', projectId: id });
  assert.deepEqual(read(`/editor/p/${id}?gates=1#x`), { kind: 'project', projectId: id });
  assert.deepEqual(read(`/editor/s/${id}/${token}`), { kind: 'share', projectId: id, token });
  assert.deepEqual(read(`/editor?project=${id}`), { kind: 'project', projectId: id });
  assert.deepEqual(read(`/editor/?project=${id}&token=${token}`), { kind: 'share', projectId: id, token });
  assert.deepEqual(read(`/editor?project=${id}&linkToken=${token}`), { kind: 'share', projectId: id, token });
  assert.deepEqual(read('/editor/p/abcdefgh'), { kind: 'project', projectId: 'abcdefgh' });
});

test('anything else is not a project address', () => {
  for (const href of [
    '/editor/', '/editor', '/', `/other/p/${id}`, `/editor/p/${id}/more`, `/editor/x/${id}`,
    '/editor/p/short', `/editor/p/${id}%2F..`, `/editor/s/${id}`, `/editor/s/${id}/bad.token`, `/editor/s/${id}/${token}/more`,
    `/editor/stage.html?project=${id}`, '/editor?project=../../etc', `/editor?project=${id}&token=bad.token`,
  ]) {
    const got = read(href);
    // 旧形式里令牌形状不对时只当没带令牌(直达),不让坏令牌进分享链接
    if (href.endsWith('token=bad.token')) assert.deepEqual(got, { kind: 'project', projectId: id }, href);
    else assert.equal(got, null, href);
  }
});

test('the desktop page (base "/") reads the old query only at its root', () => {
  assert.deepEqual(read(`/?project=${id}`, '/'), { kind: 'project', projectId: id });
  assert.equal(read(`/index.html?project=${id}`, '/'), null);
});
