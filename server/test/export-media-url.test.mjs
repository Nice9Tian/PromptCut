// 导出页拿到的素材地址:有哈希按哈希、没哈希才按路径(`server/vite-plugin-export.ts` 的 normalizeExportMedia)。
// 跑:node --test server/test/export-media-url.test.mjs
//
//   MP-E1  有合法哈希:一律 `/@media/<哈希>`,不看 path(换了机器,path 指着别人的目录)
//   MP-E2  没有哈希:照旧按 path 走 `/api/media/file?path=…`(素材目录里、文件在的用解析后的绝对路径)
//   MP-E3  没有哈希、没有 path、浏览器上传进暂存区的:换成这次导出目录里的地址;别的原样
//
// 导出插件用 node 的类型剥离直接 import(同 c66-integ.test.mjs)。
import '../../src/testing/registerTs.mjs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const { normalizeExportMedia } = await import(pathToFileURL(path.join(ROOT, 'server', 'vite-plugin-export.ts')).href);

const H = (c) => c.repeat(64);
const ROOTS = [path.resolve('/pc-test/media')];
const inMedia = path.join(ROOTS[0], 'voice.mp3');
const elsewhere = 'C:\\Users\\admin\\Videos\\PromptCut\\media\\clip.mp4';

test('MP-E1 有合法哈希的素材导出时走按哈希地址,不按 path 读(另一台机器的路径)', async () => {
  const project = { media: [
    { id: 'v', kind: 'video', url: `/@media/${H('a')}`, hash: H('a'), path: elsewhere },
    { id: 'v2', kind: 'video', url: `/api/media/file?path=${encodeURIComponent(elsewhere)}`, hash: H('b'), path: elsewhere },
    { id: 'a', kind: 'audio', url: `/@media/${H('c')}.mp3`, hash: H('c'), path: inMedia },
    { id: 't', kind: 'video', url: '', hash: H('d'), tiers: { original: H('e'), small: H('f') } },
    { id: 'x', kind: 'image', url: '/@export/media/pic.png', hash: H('1') },
    { id: 'u', kind: 'video', url: `/@media/${H('2').toUpperCase()}`, hash: H('2').toUpperCase() },
  ] };
  let asked = 0;
  await normalizeExportMedia(project, ROOT, 'job1', { roots: ROOTS, exists: async () => { asked++; return true; } });
  const url = (id) => project.media.find((m) => m.id === id).url;
  assert.equal(url('v'), `/@media/${H('a')}`, '地址本来就是这份哈希的:原样');
  assert.equal(url('v2'), `/@media/${H('b')}`, '带哈希、地址却是按路径的:改成按哈希');
  assert.equal(url('a'), `/@media/${H('c')}.mp3`, '带扩展名的哈希地址也认');
  assert.equal(url('t'), `/@media/${H('e')}`, '两档素材按素材原尺寸的哈希');
  assert.equal(url('x'), `/@media/${H('1')}`, '有哈希就不用暂存区的地址');
  assert.equal(url('u'), `/@media/${H('2')}`, '大写哈希按小写认');
  assert.equal(asked, 0, '带哈希的素材一次都不去看 path 那个文件在不在');
});

test('MP-E2 没有哈希的素材才按路径读:素材目录里、文件在的用解析后的路径;不在素材目录或文件不在的照旧用原路径', async () => {
  const missingInMedia = path.join(ROOTS[0], 'gone.mp3');
  const project = { media: [
    { id: 'p1', kind: 'audio', url: '/@media/voice.mp3', path: inMedia },
    { id: 'p2', kind: 'video', url: '/@media/clip.mp4', path: elsewhere },
    { id: 'p3', kind: 'audio', url: '', path: missingInMedia },
    { id: 'bad', kind: 'audio', url: '/@media/x.mp3', hash: 'not-a-hash', path: inMedia },
  ] };
  await normalizeExportMedia(project, ROOT, 'job2', { roots: ROOTS, exists: async (f) => f === path.resolve(inMedia) });
  const url = (id) => project.media.find((m) => m.id === id).url;
  assert.equal(url('p1'), `/api/media/file?path=${encodeURIComponent(path.resolve(inMedia))}`);
  assert.equal(url('p2'), `/api/media/file?path=${encodeURIComponent(elsewhere)}`);
  assert.equal(url('p3'), `/api/media/file?path=${encodeURIComponent(missingInMedia)}`);
  assert.equal(url('bad'), `/api/media/file?path=${encodeURIComponent(path.resolve(inMedia))}`, '哈希不合法按没有哈希办');
});

test('MP-E3 没有哈希也没有 path:暂存区地址换成这次导出目录里的,其余原样', async () => {
  const project = { media: [
    { id: 's', kind: 'video', url: '/@export/media/up.mp4' },
    { id: 'n', kind: 'image', url: 'https://example.com/a.png' },
    { id: 'e', kind: 'audio', url: '' },
  ] };
  await normalizeExportMedia(project, ROOT, 'job3', { roots: ROOTS, exists: async () => true });
  assert.deepEqual(project.media.map((m) => m.url), ['/@export/job3/media/up.mp4', 'https://example.com/a.png', '']);
  await normalizeExportMedia({}, ROOT, 'job3');
  await normalizeExportMedia({ media: null }, ROOT, 'job3');
});
