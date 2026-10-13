/**
 * 0.7.18 逐项验收「非过期与坏文件」(account-binding-task.md「逐项验收」表,编号 2.1-9)里「各类损坏细节」的一组:
 * 截断、旧格式、未知版本、坏关联、部分可读(缺卡/缺素材)、落盘中断、本机存储不可用。预期原文:「错误保留原文件,不以空项目覆盖」。
 *
 * 用真的 `src/editor/io/proc.ts`、`procp.ts`、`recoveryAssociation.ts`、`server/recovery/coordinator.mjs` 和真的草稿落盘/按路径打开的服务端插件
 * (`server/vite-plugin-projects.ts`、`server/vite-plugin-skill.ts`),不连网、不起服务。
 *
 * 通过的几条锁住「不以空项目覆盖、原文件不动」;带 `todo` 的几条是 main 上**目前不成立**的预期(产品问题,见地图「产品问题」),
 * 修好之后它们会转绿,届时把 todo 去掉即可。todo 失败不让 `npm test` 变红。
 *
 * 跑:npm test -- server/test/accept-018-files-proc-damage.test.mjs
 */
import { srcUrl } from '../../src/testing/registerTs.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { RecoveryCoordinator } from '../recovery/coordinator.mjs';

const proc = await import(srcUrl('editor/io/proc.ts'));
const procp = await import(srcUrl('editor/io/procp.ts'));
const { actions, getState } = await import(srcUrl('store/project.ts'));
const ai = await import(srcUrl('ai/projectAi.ts'));
const assoc = await import(srcUrl('editor/sync/recoveryAssociation.ts'));
const { projectsPlugin } = await import('../vite-plugin-projects.ts');
const { skillPlugin } = await import('../vite-plugin-skill.ts');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pc-accept-018-damage-'));
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const wrap = (project, extra = {}) => JSON.stringify({ format: proc.PROC_FORMAT, version: proc.PROC_VERSION, project, ...extra });
const GOOD = wrap({ tracks: [], name: 'good-file' });

/** 当前会话里「别的项目」的状态:剧本+对话(AI 栏)与项目本身 */
function seedCurrent() {
  actions.loadProject({ ...proc.parseProc(wrap({ tracks: [], name: 'current-open-project' })), id: 'current-project-id' }, 'current.proc');
  ai.applyProjectAi({ script: 'CURRENT-SCRIPT', messages: [{ role: 'user', content: 'current chat' }] });
  return { project: getState().project, ai: JSON.stringify(ai.collectProjectAi()) };
}
const unchanged = (before) => {
  assert.equal(getState().project, before.project, '当前项目对象没被换');
  assert.equal(JSON.stringify(ai.collectProjectAi()), before.ai, '当前项目的剧本和对话没被动');
};

// ------------------------------------------------------------------ .proc 解析

test('ACC018-DMG-1 截断 / 空文件 / 不是项目:读取一律抛错,当前项目、剧本、对话原样不动', () => {
  const before = seedCurrent();
  const cuts = [0, 1, 20, Math.floor(GOOD.length / 2), GOOD.length - 2];
  for (const n of cuts) assert.throws(() => proc.loadProc(GOOD.slice(0, n)), SyntaxError, `截断到 ${n} 字符`);
  for (const text of ['', '   ', 'null', '[]', '"project"', '{}', wrap({}), wrap({ tracks: 'nope' }), '{"format":"promptcut-project"}'])
    assert.throws(() => proc.loadProc(text), Error, JSON.stringify(text).slice(0, 40));
  unchanged(before);
});

test('ACC018-DMG-2 旧格式:没有外壳的裸 Project JSON 照样能读,并带上调用方给的旧 id', () => {
  const bare = JSON.stringify({ tracks: [], name: 'bare-old-project' });
  const p = proc.loadProc(bare, { legacyId: 'draft-legacy-id' });
  assert.equal(p.name, 'bare-old-project');
  assert.equal(p.id, 'draft-legacy-id');
  assert.ok(Array.isArray(p.tracks));
});

test('ACC018-DMG-3 部分可读:缺素材的项目照样打开,缺的素材条目(哈希、名字、地址)一条不丢,缺卡定义不拖垮其余内容', () => {
  const miss = 'a'.repeat(64);
  const text = wrap({ tracks: [{ id: 't1', clips: [] }], name: 'partial', media: [
    { id: 'm1', name: 'gone.mp4', kind: 'video', hash: miss, url: `/@media/${miss}`, duration: 3 },
    { id: 'm2', name: 'also-gone.wav', kind: 'audio', hash: 'b'.repeat(64), url: `/@media/${'b'.repeat(64)}`, duration: 1 },
  ] }, { cardDefinitions: { 'user-card-that-does-not-exist': { source: 'x' } } });
  const warn = console.warn; console.warn = () => {};
  let p; try { p = proc.loadProc(text); } finally { console.warn = warn; }
  assert.equal(p.name, 'partial');
  assert.deepEqual(p.media.map(m => [m.id, m.name, m.hash]), [['m1', 'gone.mp4', miss], ['m2', 'also-gone.wav', 'b'.repeat(64)]], '素材条目与哈希原样保留,可事后找回');
});

test('ACC018-DMG-4 未知的协作关联版本:项目内容照常读出,关联原样保留,恢复协调器报「不支持」且不去动身份', () => {
  const future = { version: 2, roomId: 'whatever-future-shape', hostile: { a: 1 } };
  const p = proc.loadProc(wrap({ tracks: [], name: 'future-assoc', id: 'future-id' }, { collaboration: future }));
  assert.equal(p.name, 'future-assoc');
  const taken = assoc.takeLoadedAssociation(p);
  assert.deepEqual(taken, future, '未知版本的关联原样保留,不丢字段');
  const states = []; let identityCalls = 0;
  const c = new RecoveryCoordinator({ state: (k) => states.push(k), identity: async () => { identityCalls++; return {}; }, host: async () => ({}), discover: async () => ({}), enter: async () => ({ ok: true }) });
  c.start(taken, p.id);
  assert.deepEqual(states, ['unsupported']);
  assert.equal(identityCalls, 0, '未知版本不访问身份后端');
  assoc.setAssociation(null);
});

// ------------------------------------------------------------------ 产品问题(todo):现在不成立

test('ACC018-DMG-5 坏关联(房间号不合法):读取失败时不能先把当前项目的剧本和对话换掉', { todo: '产品问题:loadProc 在 applyProjectAi 之后才解析关联,关联坏就抛错,但当前会话的剧本/对话已被文件里的覆盖(见地图「产品问题」1)' }, () => {
  const before = seedCurrent();
  const bad = wrap({ tracks: [], name: 'bad-assoc' }, { ai: { script: 'FILE-SCRIPT', messages: [] }, collaboration: { version: 1, roomId: 'bad-room', where: 'hosted', service: 'https://x.example' } });
  assert.throws(() => proc.loadProc(bad), /协作房间关联无效/);
  unchanged(before);
});

test('ACC018-DMG-6 未知的 .proc 文件版本:不能当 v1 静默读入再按 v1 存回(会丢掉不认识的字段)', { todo: '产品问题:version 99 被当 v1 载入,重存成 version 1 并丢掉未知的顶层字段(见地图「产品问题」2)' }, () => {
  seedCurrent();
  const doc = { format: proc.PROC_FORMAT, version: 99, futureTopLevel: { keep: 'me' }, project: { tracks: [], name: 'v99-file' } };
  let outcome = 'refused';
  try {
    const p = proc.loadProc(JSON.stringify(doc));
    actions.loadProject(p, 'v99.proc');
    const out = JSON.parse(proc.serializeProc());
    outcome = out.version >= 99 || out.futureTopLevel?.keep === 'me' ? 'preserved' : `silently-downgraded(version=${out.version}, futureTopLevel=${JSON.stringify(out.futureTopLevel)})`;
  } catch { /* 拒绝打开也算守住 */ }
  assert.ok(outcome === 'refused' || outcome === 'preserved', outcome);
});

test('ACC018-DMG-7 .procp 里某个条目的字节被改坏(CRC 对不上):必须报包损坏,不能当好文件读', async () => {
  const text = wrap({ tracks: [], name: 'AAAA-original' });
  const zip = await procp.writeZip([{ name: 'project.proc', blob: new Blob([text]) }]);
  const buf = new Uint8Array(await zip.arrayBuffer());
  const at = Buffer.from(buf).indexOf('AAAA-original');
  buf[at] = 'B'.charCodeAt(0);
  await assert.rejects(procp.loadProcpFile(new Blob([buf])), (e) => e.message === procp.PROCP_DAMAGED_MESSAGE, '改坏的包应报「包损坏」');
});

test('ACC018-DMG-7b .procp 里素材条目被改坏:整包不读,不向内容库落任何素材,也不读出编排', async () => {
  const text = wrap({ tracks: [], name: 'packed-ok' });
  const media = new TextEncoder().encode('MEDIA-BYTES-0123456789');
  const zip = await procp.writeZip([{ name: 'project.proc', blob: new Blob([text]) }, { name: 'media/' + 'd'.repeat(64) + '.bin', blob: new Blob([media]) }, { name: 'media/' + 'e'.repeat(64) + '.bin', blob: new Blob([media]) }]);
  const buf = new Uint8Array(await zip.arrayBuffer());
  const first = Buffer.from(buf).indexOf('MEDIA-BYTES');
  buf[Buffer.from(buf).indexOf('MEDIA-BYTES', first + 1) + 3] ^= 0xff; // 第二份素材的一个字节
  const before = seedCurrent();
  const realFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('{}', { status: 200 }); };
  try {
    await assert.rejects(procp.loadProcpFile(new Blob([buf])), (e) => e.message === procp.PROCP_DAMAGED_MESSAGE);
    assert.equal(calls, 0, '核对在落库之前:好的那份素材也不落');
  } finally { globalThis.fetch = realFetch; }
  unchanged(before);
  // 没改坏的同一个包照常能读
  const okZip = await procp.writeZip([{ name: 'project.proc', blob: new Blob([text]) }]);
  assert.equal((await procp.loadProcpFile(okZip)).name, 'packed-ok');
});

// ------------------------------------------------------------------ .procp

test('ACC018-DMG-8 .procp 截断 / 空包 / 没有编排条目:报错,不去落任何素材', async () => {
  const text = wrap({ tracks: [], name: 'packed' });
  const zip = await procp.writeZip([{ name: 'project.proc', blob: new Blob([text]) }, { name: 'media/' + 'c'.repeat(64) + '.bin', blob: new Blob([new Uint8Array(100)]) }]);
  const buf = new Uint8Array(await zip.arrayBuffer());
  const realFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('{}', { status: 200 }); };
  try {
    for (const cut of [0, 10, Math.floor(buf.length / 2), buf.length - 5]) await assert.rejects(procp.loadProcpFile(new Blob([buf.slice(0, cut)])), Error, `截断到 ${cut}`);
    await assert.rejects(procp.loadProcpFile(new Blob([])), /不是一个 \.procp 包/);
    const emptyZip = await procp.writeZip([]);
    await assert.rejects(procp.loadProcpFile(emptyZip), /空的|不是一个 \.procp 包/);
    assert.equal(calls, 0, '坏包不触发任何素材落库请求');
  } finally { globalThis.fetch = realFetch; }
});

// ------------------------------------------------------------------ 落盘(本机草稿、按路径打开)

function fakeRes() {
  const res = { statusCode: 0, headers: {}, body: '', headersSent: false, setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = String(b ?? ''); this.headersSent = true; } };
  return res;
}
function request(handler, method, url, body) {
  const req = Readable.from(body === undefined ? [] : [body]);
  req.url = url; req.method = method;
  const res = fakeRes();
  return handler(req, res).then(() => res);
}
function pluginHandlers(plugin, root) {
  const handlers = new Map();
  plugin.configureServer({ config: { root }, middlewares: { use(p, f) { handlers.set(p, f); } } });
  return handlers;
}

test('ACC018-DMG-9 本机存储不可用(草稿文件只读):保存失败报错,原草稿内容一字不动', async (t) => {
  const dir = tmp(); process.env.PROMPTCUT_PROJECTS_DIR = dir;
  t.after(() => { delete process.env.PROMPTCUT_PROJECTS_DIR; try { fs.chmodSync(path.join(dir, 'locked.proc'), 0o666); } catch { /* 无 */ } fs.rmSync(dir, { recursive: true, force: true }); });
  const handler = pluginHandlers(projectsPlugin(), dir).get('/api/projects');
  const file = path.join(dir, 'locked.proc');
  assert.equal((await request(handler, 'PUT', '/locked', GOOD)).statusCode, 200);
  fs.chmodSync(file, 0o444);
  const before = fs.readFileSync(file);
  const res = await request(handler, 'PUT', '/locked', wrap({ tracks: [], name: 'overwrite-attempt' }));
  assert.ok(res.statusCode >= 400, `只读时保存应报错:${res.statusCode}`);
  assert.deepEqual(fs.readFileSync(file), before, '原草稿内容没被改');
  // 坏 JSON 不会被写成草稿
  fs.chmodSync(file, 0o666);
  const bad = await request(handler, 'PUT', '/locked', '{"format":"promptcut-project","project":{"tracks":[');
  assert.ok(bad.statusCode >= 400);
  assert.deepEqual(fs.readFileSync(file), before, '坏 JSON 没覆盖原草稿');
});

test('ACC018-DMG-10 按路径打开(双击文件):先复制副本再读,原文件不动;截断/不是项目的文件被拒,不产生副本', async (t) => {
  const root = tmp(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const handler = pluginHandlers(skillPlugin(), root).get('/api/skill');
  const good = path.join(root, 'good.proc'); fs.writeFileSync(good, GOOD);
  const truncated = path.join(root, 'truncated.proc'); fs.writeFileSync(truncated, GOOD.slice(0, 30));
  const notProject = path.join(root, 'secret.json'); fs.writeFileSync(notProject, JSON.stringify({ token: 'not-a-project' }));
  const shas = new Map([good, truncated, notProject].map(f => [f, sha(fs.readFileSync(f))]));
  const open = async (f) => { const r = await request(handler, 'POST', '/open-path', JSON.stringify({ path: f })); return { status: r.statusCode, json: JSON.parse(r.body) }; };
  const ok = await open(good);
  assert.equal(ok.status, 200); assert.equal(ok.json.text, GOOD); assert.ok(fs.existsSync(ok.json.copy), '有副本');
  const cut = await open(truncated); assert.equal(cut.status, 400, '截断的文件被拒');
  const other = await open(notProject); assert.equal(other.status, 400);
  assert.ok(!JSON.stringify(other.json).includes('not-a-project'), '拒绝时不把文件内容回出去');
  for (const [f, h] of shas) assert.equal(sha(fs.readFileSync(f)), h, `${path.basename(f)} 原文件字节没变`);
  assert.equal(fs.readdirSync(path.join(root, '.pc-work', 'opened')).length, 1, '只有成功的那一份有副本');
});

test('ACC018-DMG-11 落盘中断:保存写到一半进程没了,上一份完整的草稿仍然在(要求先写临时文件再改名)', async (t) => {
  const dir = tmp(); process.env.PROMPTCUT_PROJECTS_DIR = dir;
  const realWrite = fs.writeFileSync;
  t.after(() => { fs.writeFileSync = realWrite; delete process.env.PROMPTCUT_PROJECTS_DIR; fs.rmSync(dir, { recursive: true, force: true }); });
  const handler = pluginHandlers(projectsPlugin(), dir).get('/api/projects');
  assert.equal((await request(handler, 'PUT', '/atomic', GOOD)).statusCode, 200);
  const file = path.join(dir, 'atomic.proc');
  const next = wrap({ tracks: [], name: 'second-version-' + 'x'.repeat(2000) });
  // 模拟进程在写入中途消失:只写出前一半字节就抛错
  fs.writeFileSync = function (target, data, ...rest) {
    if (String(target).startsWith(file)) { realWrite.call(fs, target, String(data).slice(0, Math.floor(String(data).length / 2)), ...rest); throw new Error('process killed mid-write'); }
    return realWrite.call(fs, target, data, ...rest);
  };
  await request(handler, 'PUT', '/atomic', next);
  fs.writeFileSync = realWrite;
  const left = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  assert.doesNotThrow(() => JSON.parse(left), '中断之后草稿文件仍是完整可读的 JSON');
  assert.equal(JSON.parse(left).project.name, 'good-file', '仍是上一份完整的草稿');
  assert.deepEqual(fs.readdirSync(dir).filter(f => f.endsWith('.tmp')), [], '失败后不留临时文件');
});

test('ACC018-DMG-11b 保存成功:原子写完不留临时文件,内容是新的一份', async (t) => {
  const dir = tmp(); process.env.PROMPTCUT_PROJECTS_DIR = dir;
  t.after(() => { delete process.env.PROMPTCUT_PROJECTS_DIR; fs.rmSync(dir, { recursive: true, force: true }); });
  const handler = pluginHandlers(projectsPlugin(), dir).get('/api/projects');
  assert.equal((await request(handler, 'PUT', '/atomic2', GOOD)).statusCode, 200);
  assert.equal((await request(handler, 'PUT', '/atomic2', wrap({ tracks: [], name: 'second' }))).statusCode, 200);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'atomic2.proc'), 'utf8')).project.name, 'second');
  assert.deepEqual(fs.readdirSync(dir).filter(f => f.endsWith('.tmp')), []);
});
