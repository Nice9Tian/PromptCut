/**
 * 开始页「存储」一块与标题栏「存储…」的界面探针(存储占用计划 `docs/plan/storage-plan.md` 第 6 节「界面」)。
 * 在 worktree 根目录跑:
 *
 *   node scripts/probes/storage-ui-probe.mjs [--port 5720] [--out <截图目录>]
 *
 * 起的东西(都由本探针起、跑完关掉):一台编辑器 dev server(`--port`,另占 +1、+2 当舞台端口;它自己再起一个预渲染进程),
 * 无头 Chrome。导出目录、数据目录都在系统临时目录里,里面预先造 3 份导出(一份完整、一份同秒重名且没有 project.json、
 * 一份未完成)和一份 `export-vision-*`;不碰桌面版的 `Videos\PromptCut`,不写公共的 port.json。
 *
 * 断言:
 *   U1 「存储」一块在;导出列表 3 条(`export-vision-*` 不列),新的在前;`/api/storage` 还没有(storage-cap 未合入)时缓存那一行是「暂时取不到」,页面没有报错;
 *   U2 「只删中间文件」后那一份的大小变小、中间文件那一栏没了,磁盘上只剩成片、透明层与 project.json;
 *   U3 「删除」(确认框)后少一份,磁盘上那个目录没了;
 *   U4 开始页上点标题栏「文件 → 存储…」滚到「存储」;从编辑器(`?editor`)点也回到开始页并滚到「存储」;
 *   U5 用拦截模拟 `/api/storage*`:显示占用与上限,「清理缓存」后显示腾出多少、数字变小,改上限发出的请求与回显对;
 *   U6 接口的路径校验:`..`、`export-vision-*` 回 400(不点真的「打开所在目录」,那会在桌面上弹资源管理器)。
 * 结果最后一行是一行 JSON(`ok`、`fails`),截图在 --out。
 */
import '../lib/no-user-dirs.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const PORT = Number(arg('--port', 5720));
const OUT = path.resolve(arg('--out', path.join(os.tmpdir(), 'storage-ui-shots')));
const ORIGIN = `http://127.0.0.1:${PORT}`;
fs.mkdirSync(OUT, { recursive: true });

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-storage-ui-'));
const EXPORTS = path.join(TMP, 'exports');
const DATA = path.join(TMP, 'data');
fs.mkdirSync(DATA, { recursive: true });

const fails = [];
const out = { ok: false, out: OUT, tmp: TMP };
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 400))); return !!cond; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = 20_000, every = 150) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`等不到:${what}`);
    await sleep(every);
  }
}

function put(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(bytes, 7));
}
const MB = 1024 * 1024;
function makeExport(id, { preview = 0, overlay = 0, frames = 0, parts = 0, project = null }) {
  const dir = path.join(EXPORTS, id);
  fs.mkdirSync(dir, { recursive: true });
  if (preview) put(path.join(dir, 'preview.mp4'), preview);
  if (overlay) put(path.join(dir, 'overlay.mov'), overlay);
  for (let i = 0; i < frames; i++) put(path.join(dir, 'frames', `${String(i).padStart(5, '0')}.png`), MB);
  if (parts) put(path.join(dir, 'parts', 'part-0.mov'), parts);
  if (project) fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(project));
  return dir;
}
// 完整的一份(有中间文件)、同秒重名且没有 project.json 的一份、未完成的一份(取消或失败留下的)、视觉工具的临时目录
const FULL = 'export-20260920-101500';
const DUP = 'export-20260920-101500-2';
const HALF = 'export-20260921-080000';
makeExport(FULL, { preview: 3 * MB, overlay: 20 * MB, frames: 12, parts: 8 * MB, project: { name: '探针项目甲', id: 'p-probe-a' } });
makeExport(DUP, { preview: 2 * MB, overlay: 5 * MB, frames: 3 });
makeExport(HALF, { frames: 6, parts: 4 * MB, project: { name: '探针项目乙', id: 'p-probe-b' } });
makeExport('export-vision-probe-1', { preview: MB, project: { name: '不该出现' } });

async function portFree(p) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(p, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

let vite = null;
async function stopTree(child) {
  if (!child?.pid || child.exitCode !== null) return;
  await new Promise((resolve) => {
    const k = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    k.once('error', resolve);
    k.once('exit', resolve);
  });
}

let browser = null;
try {
  for (const p of [PORT, PORT + 1, PORT + 2]) if (!(await portFree(p))) throw new Error(`端口 ${p} 被占`);
  // vite 的 exports 不导出 bin/,按包目录找(同 server/vite-plugin-prerender.ts 的 viteBin);依赖向上解析到主仓库
  const viteBin = path.join(path.dirname(createRequire(path.join(ROOT, 'package.json')).resolve('vite/package.json')), 'bin', 'vite.js');
  const log = [];
  vite = spawn(process.execPath, [viteBin, '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
    cwd: ROOT,
    env: { ...process.env, PROMPTCUT_NO_PORT_FILE: '1', PROMPTCUT_EXPORT_DIR: EXPORTS, PROMPTCUT_DATA_DIR: DATA },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  vite.stdout.on('data', (b) => { log.push(String(b)); if (log.length > 40) log.shift(); });
  vite.stderr.on('data', (b) => { log.push(String(b)); if (log.length > 40) log.shift(); });
  await until('dev server 回 200', async () => {
    if (vite.exitCode !== null) throw new Error(log.join(''));
    const r = await fetch(ORIGIN + '/', { signal: AbortSignal.timeout(2000) });
    await r.body?.cancel();
    return r.status === 200;
  }, 120_000, 300);

  browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const pageErrors = [];
  const newPage = async () => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 860 });
    page.on('pageerror', (e) => pageErrors.push(String(e?.message || e)));
    page.on('dialog', (d) => { void d.accept(); });
    return page;
  };
  const rows = (page) => page.$$eval('[data-pc="storage-export"]', (els) => els.map((el) => ({
    id: el.getAttribute('data-export-id'),
    text: el.textContent,
    bytes: el.querySelector('[data-pc="storage-export-bytes"]')?.textContent ?? '',
    mid: el.querySelector('[data-pc="storage-export-mid"]')?.textContent ?? '',
    prune: !!el.querySelector('[data-pc="storage-export-prune"]'),
  })));
  const inView = (page) => page.$eval('[data-pc="start-storage"]', (el) => {
    // 滚到了:标题贴到视野上半,或者「存储」是最后一块、容器已经滚到底(再也滚不上去)
    const r = el.getBoundingClientRect();
    const main = el.closest('.sp-main');
    const atBottom = !!main && main.scrollTop > 0 && main.scrollTop + main.clientHeight >= main.scrollHeight - 2;
    return r.top >= 0 && r.top < window.innerHeight && (r.top < window.innerHeight * 0.5 || atBottom);
  });

  // ── U1 ──
  const page = await newPage();
  await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded' });
  await until('「存储」一块', () => page.$('[data-pc="start-storage"]'));
  await until('导出列表', async () => (await rows(page)).length > 0);
  await until('缓存那一行', () => page.$('[data-pc="storage-cache-unavailable"], [data-pc="storage-cache-bytes"]'));
  const r1 = await rows(page);
  out.U1 = { rows: r1.map((r) => r.id) };
  check(JSON.stringify(r1.map((r) => r.id)) === JSON.stringify([HALF, DUP, FULL]), 'U1 列表 3 条、新的在前、vision 不列', r1.map((r) => r.id));
  check(!r1.some((r) => r.text.includes('不该出现')), 'U1 vision 不列');
  check(r1[0].text.includes('未完成') && r1[0].text.includes('探针项目乙'), 'U1 未完成的那份标「未完成」', r1[0].text);
  check(r1[1].text.includes('未知项目'), 'U1 没有 project.json 的列为未知项目', r1[1].text);
  check(r1[2].text.includes('成片') && r1[2].text.includes('透明层') && r1[2].text.includes('中间文件'), 'U1 完整的那份列出成片、透明层、中间文件', r1[2].text);
  const unavailable = await page.$('[data-pc="storage-cache-unavailable"]');
  out.U1.storageApi = unavailable ? 'unavailable' : 'present';
  if (unavailable) {
    check(await page.$eval('[data-pc="storage-clear-cache"]', (b) => b.disabled), 'U1 取不到时「清理缓存」置灰');
  }
  check(!(await page.$('[data-pc="storage-error"]')), 'U1 页面上没有报错条');
  await page.$eval('[data-pc="start-storage"]', (el) => el.scrollIntoView());
  await page.screenshot({ path: path.join(OUT, 'u1-storage.png') });

  // ── U2 只删中间文件 ──
  const beforeFull = r1.find((r) => r.id === FULL);
  await page.click(`[data-export-id="${FULL}"] [data-pc="storage-export-prune"]`);
  await until('只删中间文件的提示', () => page.$eval('[data-pc="storage-notice"]', (el) => el.textContent.includes('已删中间文件')));
  const r2 = await rows(page);
  const afterFull = r2.find((r) => r.id === FULL);
  out.U2 = { before: beforeFull.bytes, after: afterFull?.bytes, notice: await page.$eval('[data-pc="storage-notice"]', (el) => el.textContent) };
  check(afterFull && afterFull.bytes !== beforeFull.bytes && afterFull.mid === '' && !afterFull.prune, 'U2 大小变小、中间文件那栏没了', out.U2);
  check(JSON.stringify(fs.readdirSync(path.join(EXPORTS, FULL)).sort()) === JSON.stringify(['overlay.mov', 'preview.mp4', 'project.json']), 'U2 磁盘上只剩成片、透明层、project.json', fs.readdirSync(path.join(EXPORTS, FULL)));
  await page.screenshot({ path: path.join(OUT, 'u2-pruned.png') });

  // ── U3 删除 ──
  await page.click(`[data-export-id="${HALF}"] [data-pc="storage-export-delete"]`);
  await until('删除后少一份', async () => (await rows(page)).length === 2);
  out.U3 = { rows: (await rows(page)).map((r) => r.id) };
  check(!fs.existsSync(path.join(EXPORTS, HALF)), 'U3 磁盘上那一份没了');
  check(fs.existsSync(path.join(EXPORTS, 'export-vision-probe-1')), 'U3 vision 目录不动');
  await page.screenshot({ path: path.join(OUT, 'u3-deleted.png') });

  // ── U4 标题栏「存储…」──
  await page.$eval('.sp-main', (el) => { el.scrollTop = 0; });
  await sleep(100);
  check(!(await inView(page)), 'U4 前提:滚回顶上后「存储」不在视野上半');
  const openStorageFromMenu = async (p) => {
    await p.click('.pc-titlebar-menu-button');
    await until('菜单项「存储…」', () => p.$('[data-pc="titlebar-open-storage"]'));
    await p.click('[data-pc="titlebar-open-storage"]');
  };
  await openStorageFromMenu(page);
  out.U4 = { fromStart: await until('开始页上滚到「存储」', () => inView(page), 5000).catch(() => false) };
  check(out.U4.fromStart, 'U4 开始页上点「存储…」滚到「存储」');
  await page.screenshot({ path: path.join(OUT, 'u4-menu-from-start.png') });

  const ed = await newPage();
  await ed.goto(ORIGIN + '/?editor', { waitUntil: 'domcontentloaded' });
  await until('编辑器', () => ed.$('.pc-bar--main'), 60_000);
  await sleep(1500);
  await openStorageFromMenu(ed);
  await until('回到开始页', () => ed.$('[data-pc="start-storage"]'), 15_000);
  out.U4.fromEditor = await until('从编辑器回来滚到「存储」', () => inView(ed), 8000).catch(() => false);
  check(out.U4.fromEditor, 'U4 从编辑器点「存储…」回到开始页并滚到「存储」');
  await sleep(1700); // 跟滚的 1.5 s 过去之后还在
  out.U4.fromEditorSettled = await inView(ed);
  check(out.U4.fromEditorSettled, 'U4 上面几块读完之后「存储」仍在视野里');
  await ed.screenshot({ path: path.join(OUT, 'u4-menu-from-editor.png') });
  await ed.close();

  // ── U5 模拟 /api/storage* ──
  const GB = 1024 ** 3;
  const mock = { bytes: 12 * GB, capBytes: 50 * GB, capSource: 'default', diskBytes: 931 * GB };
  const sent = [];
  const mp = await newPage();
  await mp.setRequestInterception(true);
  mp.on('request', (req) => {
    const u = new URL(req.url());
    const json = (body) => req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (u.pathname === '/api/storage' && req.method() === 'GET') {
      return json({ ok: true, frameLibrary: { ...mock, pinnedBytes: GB, scannedAt: Date.now(), lastEvict: { at: Date.now() - 3600_000, freedBytes: 2 * GB, removed: 3, skipped: 0 } }, exports: { bytes: 0, count: 0, intermediateBytes: 0 }, leftovers: { bytes: 0 } });
    }
    if (u.pathname === '/api/storage/clear-cache' && req.method() === 'POST') {
      sent.push({ path: u.pathname });
      const freed = 9 * GB;
      mock.bytes -= freed;
      return json({ ok: true, freedBytes: freed, removed: 40, skipped: 0 });
    }
    if (u.pathname === '/api/storage/cap' && req.method() === 'POST') {
      const body = JSON.parse(req.postData() || '{}');
      sent.push({ path: u.pathname, body, type: req.headers()['content-type'] });
      mock.capBytes = body.bytes;
      mock.capSource = 'user';
      return json({ ok: true, capBytes: body.bytes });
    }
    return req.continue();
  });
  await mp.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded' });
  await until('缓存占用', () => mp.$('[data-pc="storage-cache-bytes"]'));
  const fig0 = await mp.$eval('[data-pc="storage-cache-bytes"]', (el) => el.textContent);
  await mp.$eval('[data-pc="start-storage"]', (el) => el.scrollIntoView());
  await mp.screenshot({ path: path.join(OUT, 'u5-storage-mocked.png') });
  await mp.click('[data-pc="storage-clear-cache"]');
  await until('清理缓存的提示', () => mp.$eval('[data-pc="storage-notice"]', (el) => el.textContent.includes('腾出')));
  const notice = await mp.$eval('[data-pc="storage-notice"]', (el) => el.textContent);
  const fig1 = await until('数字变小', async () => {
    const t = await mp.$eval('[data-pc="storage-cache-bytes"]', (el) => el.textContent);
    return t !== fig0 ? t : null;
  });
  await mp.screenshot({ path: path.join(OUT, 'u5-cleared.png') });
  await mp.$eval('[data-pc="storage-cap-input"]', (el) => { el.select(); });
  await mp.type('[data-pc="storage-cap-input"]', '20');
  await mp.click('[data-pc="storage-cap-save"]');
  await until('改上限的提示', () => mp.$eval('[data-pc="storage-notice"]', (el) => el.textContent.includes('上限已改')));
  const fig2 = await mp.$eval('[data-pc="storage-cache-bytes"]', (el) => el.textContent);
  // 低于 5 GB 的不发
  await mp.$eval('[data-pc="storage-cap-input"]', (el) => { el.select(); });
  await mp.type('[data-pc="storage-cap-input"]', '2');
  await mp.click('[data-pc="storage-cap-save"]');
  await until('范围提示', () => mp.$eval('[data-pc="storage-error"]', (el) => el.textContent.includes('5 GB')));
  out.U5 = { fig0, notice, fig1, fig2, sent };
  check(fig0.includes('12.0G') && fig0.includes('50.0G') && fig0.includes('缺省'), 'U5 显示占用与上限', fig0);
  check(notice.includes('9.0G'), 'U5 清理后显示腾出多少', notice);
  check(fig1.includes('3.0G'), 'U5 清理后数字变小', fig1);
  check(fig2.includes('20.0G') && !fig2.includes('缺省'), 'U5 改上限后回显', fig2);
  const capReqs = sent.filter((s) => s.path === '/api/storage/cap');
  check(capReqs.length === 1 && capReqs[0].body.bytes === 20 * GB && /application\/json/.test(capReqs[0].type || ''), 'U5 改上限只发一次、字节数与类型对', capReqs);
  await mp.screenshot({ path: path.join(OUT, 'u5-cap.png') });
  await mp.close();

  // ── U6 接口路径校验 ──
  const post = (p) => page.evaluate(async (u) => { const r = await fetch(u, { method: 'POST' }); return r.status; }, p);
  out.U6 = {
    dotdot: await post('/api/exports/..%2F..%2Fdata/delete'),
    vision: await post('/api/exports/export-vision-probe-1/delete'),
    visionReveal: await post('/api/exports/export-vision-probe-1/reveal'),
    missing: await post('/api/exports/export-20200101-000000/prune'),
  };
  check(out.U6.dotdot === 400 && out.U6.vision === 400 && out.U6.visionReveal === 400 && out.U6.missing === 404, 'U6 路径校验', out.U6);
  check(fs.existsSync(path.join(EXPORTS, 'export-vision-probe-1')), 'U6 vision 目录不动');

  out.pageErrors = pageErrors;
  check(pageErrors.length === 0, '页面没有未捕获的错误', pageErrors);
} catch (e) {
  fails.push(`探针自己出错:${e?.stack || e}`);
} finally {
  await browser?.close().catch(() => {});
  await stopTree(vite);
  await sleep(500);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 留着也在临时目录里 */ }
}
out.fails = fails;
out.ok = fails.length === 0;
console.log(JSON.stringify(out));
process.exit(out.ok ? 0 : 1);
