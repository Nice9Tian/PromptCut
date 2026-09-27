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

/** 产物里 `data-pc` 为 `menu-merge-skill` 的那个元素的属性段（到它的 children 为止）；没有回 null */
function mergeItemProps(dir) {
  for (const file of walkBundle(dir)) {
    const text = fs.readFileSync(file, 'utf8');
    const at = text.indexOf('menu-merge-skill');
    if (at < 0) continue;
    return { text, props: text.slice(Math.max(0, text.lastIndexOf('{', at)), text.indexOf('children', at)) };
  }
  return null;
}
const walkBundle = (dir) => fs.readdirSync(path.join(dir, 'assets')).filter((f) => f.endsWith('.js')).map((f) => path.join(dir, 'assets', f));
const MERGE_DESKTOP_TITLE = '挑一份 .proc,把它的改动三方合并进当前项目';

it('C10-MERGE-01 在线构建里「合并 Skill 结果…」置灰：disabled 为真，悬停说明是暂不支持；桌面构建照旧', { timeout: 240_000 }, async () => {
  await buildOnline();
  const on = mergeItemProps(onlineDir);
  assert.ok(on, '在线产物里找不到 data-pc="menu-merge-skill"');
  // disabled 的值:字面量真,或一个在产物里被赋成真的常量(rolldown 保留 `ONLINE_BUILD=!0` 这种写法)
  const d = on.props.match(/disabled:([A-Za-z_$][\w$]*|!0|!1|true|false)/);
  assert.ok(d, `找不到 disabled:${on.props}`);
  const truthy = d[1] === '!0' || d[1] === 'true' || new RegExp(`(^|[^\\w$])${d[1].replace(/\$/g, '\\$')}=(!0|true)(?![\\w$])`).test(on.text);
  assert.ok(truthy, `在线产物里这一项的 disabled 不为真:${d[1]}`);
  assert.ok(on.props.includes('合并 Skill 结果'), `悬停说明应是 onlineUnsupported("合并 Skill 结果"):${on.props}`);
  assert.ok(!walkBundle(onlineDir).some((f) => fs.readFileSync(f, 'utf8').includes(MERGE_DESKTOP_TITLE)), '在线产物里不该还有桌面的悬停说明');

  await buildDesktop();
  const desk = mergeItemProps(desktopDir);
  assert.ok(desk, '桌面产物里找不到 data-pc="menu-merge-skill"');
  assert.ok(desk.text.includes(MERGE_DESKTOP_TITLE), '桌面产物里应有原来的悬停说明');
  assert.ok(!/disabled:(!0|true)\b/.test(desk.props), `桌面产物里这一项不该置灰:${desk.props}`);
});
