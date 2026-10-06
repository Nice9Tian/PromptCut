/**
 * C10a 在线构建与 `/api` 静态检查（`docs/plan/c10a-contract.md` 第 2 节，第 12 节「`/api` 守卫：在线构建里没有 `/api/` 请求」）。
 * 跑：node --test server/test/c10a-online-build.test.mjs
 *
 *   C10A-API-01 `src/online/mode.ts` 与契约第 2 节逐字节相同（两个实现分支各建一份，集成时不冲突）；
 *   C10A-API-02 `vite build --mode online` 成功：`base: '/editor/'`，index.html 只引 `/editor/assets/…`；
 *   C10A-API-03 产物里没有以 `/api/` 开头的地址字面量（守卫本身判前缀用的 `"/api/"` 不算：后面紧跟地址的才算请求）；
 *   C10A-API-04 桌面构建照旧（缺省 base `/`），不受在线模式影响；
 *   C10-MERGE-01 顶栏「⋯ → 合并 Skill 结果…」在线构建里置灰（C10 契约第 10 节〔裁〕，2026-09-28）：在线产物里这一项
 *                `disabled` 为真、悬停说明是「在线浏览器模式暂不支持合并 Skill 结果…」，桌面说明不在产物里；桌面产物照旧。
 *                这一项的开关是编译期常量（`TopBar.tsx` 的 `ONLINE_BUILD`），Node 里渲染不出在线态，所以就对产物核。
 *   C10-CATALOG-01/02 在线构建的 `catalog/` 与 `server/catalog/<kind>/index.json` 登记的 Lottie、粒子条目一一对应、逐字节相同；桌面构建不带。
 *   C10A-API-05 云端 Agent 服务（`docs/plan/cloud-agent-contract.md` 10.3 节）：在线产物里以 `/agent/` 开头的地址字面量只有 `/agent/v1` 一种，且确实有（AI 栏打它）；
 *   C10A-API-07 在线产物里没有桌面专用的标识：`/api/mcp/events`、`/api/ai/setup`、`/api/chats/`、`PROMPTCUT_AGENT`（03 已覆盖路径类，这一条补非路径的）；
 *   C10A-API-08 桌面产物里也带云端 AI 栏（桌面版项目放云端时多一项「云端」）：有 `/agent/v1` 以外的地址来自文档服务下发，产物里没有写死的云节点地址。
 * 运行期（真浏览器里的网络记录）见 `scripts/probes/c10a-online-probe.mjs`；守卫本身见 `src/online/c10a-api-guard.test.mjs`。
 *
 * 构建用 vite 的 JS 接口，产物写进临时目录，不碰 `dist/`、`dist-online/`。`src/online/mode.ts` 不在时整组 skip。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { exists, skipIf, repoPath, tempDir, ROOT, apiLiterals, apiPaths, ONLINE_API_RATCHET_FILE } from './c10a-kit.mjs';

const missing = !exists('src/online/mode.ts');
const skip = skipIf(missing, 'src/online/mode.ts 与在线构建');
const it = (name, opts, fn) => test(name, { skip, ...opts }, fn);

/** 契约第 2 节「判定模块」的原文（两行） */
const MODE_TS = [
  '/** 在线浏览器模式：由在线构建打开（c10a-contract.md 第 2 节）。桌面运行环境（桌面版、本机 dev server）恒为 false。 */',
  'export const ONLINE: boolean = import.meta.env.VITE_PC_ONLINE === "1";',
];

const OUT = tempDir('pc-c10a-build-');
after(() => fs.rmSync(OUT, { recursive: true, force: true }));

async function viteBuild(mode, outDir) {
  const { build } = await import('vite');
  const prevCwd = process.cwd();
  process.chdir(ROOT);
  try {
    await build({ root: ROOT, mode, logLevel: 'error', build: { outDir, emptyOutDir: true, reportCompressedSize: false } });
  } finally {
    process.chdir(prevCwd);
  }
}

it('C10A-API-01 src/online/mode.ts 与契约第 2 节逐字节相同（换行符不计）', {}, () => {
  const text = fs.readFileSync(repoPath('src/online/mode.ts'), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(text.replace(/\n+$/, ''), MODE_TS.join('\n'));
});

const onlineDir = path.join(OUT, 'dist-online');
let built = null;
const buildOnline = () => (built ??= viteBuild('online', onlineDir));

it('C10A-API-02 vite build --mode online 成功：base 是 /editor/，index.html 只引 /editor/assets/', { timeout: 240_000 }, async () => {
  await buildOnline();
  const html = fs.readFileSync(path.join(onlineDir, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]).filter((u) => !/^(https?:|data:|#)/.test(u));
  assert.ok(refs.length > 0, 'index.html 没有引用任何资源');
  for (const u of refs) assert.ok(u.startsWith('/editor/'), `index.html 引用了 /editor/ 之外的地址：${u}`);
  assert.ok(refs.some((u) => u.startsWith('/editor/assets/') && u.endsWith('.js')), `入口脚本在 /editor/assets/ 下：${refs.join(', ')}`);
  assert.ok(fs.existsSync(path.join(onlineDir, 'assets')), '产物里有 assets/');
});

/*
 * 〔裁，主会话 2026-09-27〕原断言「0 处」改成棘轮：集成时产物里已有的 `/api/` 路径进清单（`c10a-kit.mjs` 的
 * `ONLINE_API_RATCHET_FILE`），这里断言产物里的路径 ⊆ 清单，新出现的判红。这些路径在运行时都被守卫拦下
 * （`c10a-api-guard.test.mjs`、探针的网络记录 0 条）；逐个置灰或换在线替代归 C10 其余，做掉一个就从清单删一个。
 * M8 遗留 L24（2026-09-28）起清单与产物须逐条一致：产物里已经没有的路径留在清单里同样判红，清单不会悄悄变宽。
 */
it('C10A-API-03 在线构建的产物里的 /api/ 路径与棘轮清单逐条一致（新出现的、清单里多余的都判红）', { timeout: 240_000 }, async () => {
  await buildOnline();
  const ratchet = JSON.parse(fs.readFileSync(repoPath(ONLINE_API_RATCHET_FILE), 'utf8'));
  const allowed = new Set(ratchet.paths);
  const found = apiPaths(onlineDir);
  const fresh = found.filter((p) => !allowed.has(p));
  const hits = apiLiterals(onlineDir).filter((h) => fresh.some((p) => h.context.includes(p)));
  assert.deepEqual(fresh, [], `在线构建里新出现了 ${fresh.length} 个 /api/ 路径（清单 ${ONLINE_API_RATCHET_FILE} 之外）：${JSON.stringify(hits.slice(0, 10), null, 1)}`);
  const gone = ratchet.paths.filter((p) => !found.includes(p));
  assert.deepEqual(gone, [], `清单里有 ${gone.length} 个路径产物里已经没有了，从 ${ONLINE_API_RATCHET_FILE} 删掉：${gone.join(', ')}`);
});

const desktopDir = path.join(OUT, 'dist-desktop');
let builtDesktop = null;
const buildDesktop = () => (builtDesktop ??= viteBuild('production', desktopDir));

it('C10A-API-04 桌面构建照旧：base 是 /，不受在线模式影响', { timeout: 240_000 }, async () => {
  const dir = desktopDir;
  await buildDesktop();
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  assert.match(html, /(?:src|href)="\/assets\/[^"]+\.js"/, '桌面构建的入口脚本在 /assets/ 下');
  assert.equal(html.includes('/editor/'), false);
});

const walkBundle = (dir) => fs.readdirSync(path.join(dir, 'assets')).filter((f) => f.endsWith('.js')).map((f) => path.join(dir, 'assets', f));

it('C10-MERGE-01 「合并 Skill 结果…」随 SKILL 的三方合并归档(计划 agent-workflow-plan.md A4):在线、桌面两份产物里都没有这一项', { timeout: 240_000 }, async () => {
  await buildOnline();
  await buildDesktop();
  for (const dir of [onlineDir, desktopDir]) {
    const hit = walkBundle(dir).find((f) => /menu-merge-skill|合并 Skill 结果/.test(fs.readFileSync(f, 'utf8')));
    assert.equal(hit, undefined, `${dir} 的产物里还有「合并 Skill 结果」:${hit}`);
  }
});

/*
 * C10-TITLEBAR-01 标题栏菜单同顶栏（C10 契约第 10 节〔裁〕，2026-09-28）：`src/ui/WindowTitleBar.tsx` 在线页面上照样渲染，
 * 桌面才有的项在线构建里置灰（disabled 看 `desktopOnly`）、悬停说明用 `onlineUnsupported`、点了不动作，桌面壳命令那一支剪掉；
 * 桌面构建照旧。开关是编译期常量，就对产物核。
 */
const TITLEBAR_DESKTOP_ONLY = ['new-project', 'open-project', 'save-project', 'open-export', 'open-data', 'quit', 'open-voice', 'open-pylibs', 'open-models', 'reset-pylibs', 'open-logs'];
const TITLEBAR_ALWAYS = ['export-video', 'go-home', 'undo', 'redo', 'open-skin', 'shortcuts', 'about'];

/** 产物里标题栏菜单项按钮的属性段（`titlebar-${…}` 那个元素，到它的 children 为止） */
function titlebarItemProps(dir) {
  for (const file of walkBundle(dir)) {
    const text = fs.readFileSync(file, 'utf8');
    const at = text.indexOf('titlebar-${');
    if (at < 0) continue;
    return { text, props: text.slice(Math.max(0, text.lastIndexOf('{', at)), text.indexOf('children', at)) };
  }
  return null;
}
const menuEntry = (text, cmd) => text.match(new RegExp(`command:[\`"']${cmd}[\`"'][^}]*}`))?.[0] ?? null;
const bundleText = (dir) => walkBundle(dir).map((f) => fs.readFileSync(f, 'utf8')).join('\n');

it('C10-TITLEBAR-01 在线构建里标题栏菜单的桌面项置灰、点了不动作、桌面壳命令剪掉；桌面构建照旧', { timeout: 240_000 }, async () => {
  await buildOnline();
  const on = titlebarItemProps(onlineDir);
  assert.ok(on, '在线产物里找不到标题栏菜单项（titlebar-${…}）');
  assert.match(on.props, /disabled:[^,]*desktopOnly/, `在线产物里 disabled 应看 desktopOnly:${on.props}`);
  assert.match(on.props, /title:[^,]*desktopOnly[^,]*onlineUnsupported|title:[^,]*onlineUnsupported/, `悬停说明应走 onlineUnsupported:${on.props}`);
  assert.match(on.props, /onClick:[^}]*desktopOnly/, `点了应先看 desktopOnly、不动作:${on.props}`);
  for (const cmd of TITLEBAR_DESKTOP_ONLY) assert.match(menuEntry(on.text, cmd) ?? '', /desktopOnly:/, `${cmd} 在线应置灰`);
  for (const cmd of TITLEBAR_ALWAYS) {
    const e = menuEntry(on.text, cmd);
    assert.ok(e, `找不到 ${cmd}`);
    assert.equal(/desktopOnly:/.test(e), false, `${cmd} 在线照常可点:${e}`);
  }
  assert.equal(bundleText(onlineDir).includes('desktop_titlebar_command'), false, '在线产物里不该还有桌面壳命令');

  await buildDesktop();
  const desk = titlebarItemProps(desktopDir);
  assert.ok(desk, '桌面产物里找不到标题栏菜单项');
  const d = desk.props.match(/disabled:([A-Za-z_$][\w$]*|!0|!1|true|false)(?=[,}])/);
  assert.ok(d, `桌面产物里 disabled 应是常量假:${desk.props}`);
  const falsy = d[1] === '!1' || d[1] === 'false' || new RegExp(`(^|[^\\w$])${d[1].replace(/\$/g, '\\$')}=(!1|false)(?![\\w$])`).test(desk.text);
  assert.ok(falsy, `桌面产物里标题栏菜单项不该置灰:${d[1]}`);
  assert.equal(desk.props.includes('onlineUnsupported'), false, `桌面产物里不该有在线的悬停说明:${desk.props}`);
  assert.ok(bundleText(desktopDir).includes('desktop_titlebar_command'), '桌面产物里桌面壳命令照旧');
});

/*
 * C10-CATALOG-01 在线构建带上动效素材目录（`server/online-catalog.mjs`）：卡片参数里的 `/catalog/<kind>/<name>.json` 在桌面由开发服务器的
 * 中间件提供，在线由构建产出到 `dist-online/catalog/`、托管端 nginx 在 `/catalog/` 下提供。产物里的文件与 index.json 登记的条目一一对应
 * （不多不少、逐字节相同），登记的 url 就是产物里的路径；index.json 本身不产出（页面在构建时 import 它，运行时不读）。
 * 桌面构建照旧不带 catalog/（桌面由中间件按 index.json 放行）。
 */
const CATALOG_KINDS = ['lottie', 'particles'];
const catalogIndex = (kind) => JSON.parse(fs.readFileSync(repoPath(`server/catalog/${kind}/index.json`), 'utf8'));
const listFiles = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).map((d) => path.relative(dir, path.join(d.parentPath ?? d.path, d.name)).split(path.sep).join('/')).sort() : []);

it('C10-CATALOG-01 在线构建的 catalog/ 与 index.json 登记的 Lottie、粒子条目一一对应、逐字节相同', { timeout: 240_000 }, async () => {
  await buildOnline();
  const want = [];
  for (const kind of CATALOG_KINDS) {
    const items = catalogIndex(kind).items;
    assert.ok(items.length > 0, `${kind}/index.json 没有条目`);
    for (const it of items) {
      assert.equal(it.url, `/catalog/${kind}/${it.name}.json`, `${kind}/${it.name} 登记的 url 与产物路径不一致`);
      want.push(`${kind}/${it.name}.json`);
    }
  }
  const got = listFiles(path.join(onlineDir, 'catalog'));
  assert.deepEqual(got, [...want].sort(), 'dist-online/catalog/ 里的文件应与 index.json 登记的条目一一对应');
  for (const rel of want) {
    const a = fs.readFileSync(path.join(onlineDir, 'catalog', rel));
    const b = fs.readFileSync(repoPath(`server/catalog/${rel}`));
    assert.ok(a.equals(b), `catalog/${rel} 与 server/catalog/${rel} 不是逐字节相同`);
  }
});

it('C10-CATALOG-02 桌面构建照旧不带 catalog/（桌面由开发服务器的 /catalog 中间件提供）', { timeout: 240_000 }, async () => {
  await buildDesktop();
  assert.equal(fs.existsSync(path.join(desktopDir, 'catalog')), false);
});

/*
 * 云端 Agent 服务的通道（`docs/plan/cloud-agent-contract.md` 10.1～10.3 节）：在线页面的 AI 栏打同源的 `/agent/v1/*`，不是编辑器进程的 `/api/*`。
 * 守卫与棘轮清单一条不加（C10A-API-03 已守）；这里补「/agent/ 只有一种前缀」与「桌面专用的非路径标识不进在线产物」。
 */
const agentLiterals = (text) => [...new Set([...text.matchAll(/["'`](\/agent\/[^"'`\s]*)["'`]/g)].map((m) => m[1]))];

it('C10A-API-05 在线产物里以 /agent/ 开头的地址字面量只有 /agent/v1 一种', { timeout: 240_000 }, async () => {
  await buildOnline();
  const lits = agentLiterals(bundleText(onlineDir));
  assert.deepEqual(lits, ['/agent/v1'], `在线产物里 /agent/ 开头的地址：${lits.join(', ')}`);
});

it('C10A-API-07 在线产物里没有桌面专用的标识', { timeout: 240_000 }, async () => {
  await buildOnline();
  const text = bundleText(onlineDir);
  for (const id of ['/api/mcp/events', '/api/ai/setup', '/api/chats/', 'PROMPTCUT_AGENT']) assert.equal(text.includes(id), false, `在线产物里不该有 ${id}`);
});

it('C10A-API-08 桌面产物里没有写死的云节点地址：云端 Agent 的地址由文档服务下发', { timeout: 240_000 }, async () => {
  await buildDesktop();
  const text = bundleText(desktopDir);
  assert.ok(text.includes('在云端运行'), '桌面产物里带云端 AI 栏');
  assert.equal(/https?:\/\/[^"'`\s]*\/agent\/v1/.test(text), false, '桌面产物里不该写死云节点的 /agent/v1 地址');
});
