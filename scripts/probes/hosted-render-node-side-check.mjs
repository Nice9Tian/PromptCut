#!/usr/bin/env node
/**
 * 对照实验：同步来的样式与脚本**不过预检**时，工作进程里的 Vite 与 Tailwind 在 Node 一侧会不会读到工作目录以外的文件、
 * 会不会把同步来的脚本当构建插件执行（契约 `docs/plan/hosted-render-contract.md` 第 7.5 节「同步文件预检」要堵的缺口）。
 * 它回答的是「这个缺口在不在」，所以**故意不经过预检**；预检本身的验收在隔离探针（`hosted-render-isolation-probe.mjs` 的 G2）与单测 HR32。
 *
 *   node scripts/probes/hosted-render-node-side-check.mjs
 *
 * 做法：在临时目录里放一个最小的项目（`src/` 下一份样式、一份脚本）和项目根以外的一个文件（里面是只属于测试的假凭证
 * `PROBE-FAKE-…`），用与预渲染进程相同的两个插件（React、Tailwind）起一台 Vite 开发服务器（不监听端口），让它在 Node 一侧
 * 转换这几份文件，看转换结果与报错里有没有那个假凭证、那个「插件」有没有被执行。只读：不写、不删项目根以外的任何东西；
 * 被当作插件的那份脚本只打一行「被执行过」。不连任何网络。
 *
 * 输出：每种写法一行「读到了 / 没读到」；最后一行 JSON `{ ok: true, gaps: [...], closedBy: … }`。`gaps` 非空说明缺口确实存在
 * （这是本脚本预期看到的现状，不是失败）；每一项都对应预检里的一条拒绝规则（脚本末尾逐项核对预检确实拒掉了同一份输入）。
 * 退出码：0 = 实验做完且每个缺口都被预检覆盖；1 = 有预检没覆盖的缺口。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkSyncedSource } from '../../server/hosted-render/source-gate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-node-side-'));
const FAKE = `PROBE-FAKE-NODE-SIDE-${randomBytes(8).toString('hex')}`;
const posix = (p) => p.replace(/\\/g, '/');
const project = path.join(TMP, 'project');
const outsideDir = path.join(TMP, 'outside');
fs.mkdirSync(path.join(project, 'src', 'cards', 'user'), { recursive: true });
fs.mkdirSync(outsideDir, { recursive: true });
const outsideCss = path.join(outsideDir, 'secret.css');
const outsideTxt = path.join(outsideDir, 'secret.txt');
const outsideSvg = path.join(outsideDir, 'secret.svg');
fs.writeFileSync(outsideCss, `.leaked::after { content: "${FAKE}"; }\n`);
fs.writeFileSync(outsideTxt, `${FAKE}\n`);
fs.writeFileSync(outsideSvg, `<svg xmlns="http://www.w3.org/2000/svg"><text>${FAKE}</text></svg>\n`);
const execMark = path.join(TMP, 'plugin-executed.txt');
// 被样式当作构建插件点名的脚本：只留一个「被执行过」的记号文件（在本实验自己的临时目录里）
fs.writeFileSync(path.join(project, 'src', 'cards', 'user', 'as-plugin.js'),
  `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(posix(execMark))}, 'executed in node');\nexport default function plugin() { return { handler() {} }; }\n`);
const rel = posix(path.relative(path.join(project, 'src', 'cards', 'user'), outsideDir));

/** 每种写法：文件名、内容、怎么判「读到了」 */
const cases = [
  { name: '样式 @import 项目根以外的文件', file: 'import.css', source: `@import "${posix(outsideCss)}";\n.a { color: red; }\n` },
  { name: '样式 @import 相对路径走出项目根', file: 'import-rel.css', source: `@import "${rel}/secret.css";\n.a { color: red; }\n` },
  { name: '样式 url(…?inline) 项目根以外的文件', file: 'inline.css', source: `.a { background: url("${posix(outsideTxt)}?inline"); }\n` },
  { name: '样式 url(…) 项目根以外的 .svg（小文件在开发服务器里也会内联）', file: 'svg.css', source: `.a { background: url("${rel}/secret.svg"); }\n` },
  { name: '样式 @plugin 把同步来的脚本当构建插件执行', file: 'plugin.css', source: `@plugin "./as-plugin.js";\n.a { color: red; }\n`, executed: true },
  { name: '样式 @config 把同步来的脚本当配置执行', file: 'config.css', source: `@config "./as-plugin.js";\n.b { color: red; }\n`, executed: true },
  { name: '脚本 import.meta.glob 列项目根以外的文件名', file: 'glob.ts', source: `export const names = Object.keys(import.meta.glob("${rel}/*"));\n`, expect: 'secret.txt' },
  { name: '脚本 ?raw 导入项目根以外的文件（Node 一侧只改写地址，内容要浏览器再来取）', file: 'raw.ts', source: `import text from "${rel}/secret.txt?raw";\nexport default text;\n` },
];

const { createServer } = await import(pathToFileURL(path.join(ROOT, 'node_modules', 'vite', 'dist', 'node', 'index.js')).href).catch(() => import('vite'));
const tailwind = (await import('@tailwindcss/vite')).default;
const server = await createServer({
  root: project, configFile: false, logLevel: 'silent', clearScreen: false,
  cacheDir: path.join(TMP, 'vite-cache'),
  plugins: [tailwind()],
  server: { middlewareMode: true, hmr: false, watch: null },
  appType: 'custom',
});

const gaps = [];
const rows = [];
try {
  for (const c of cases) {
    const abs = path.join(project, 'src', 'cards', 'user', c.file);
    fs.writeFileSync(abs, c.source);
    let text = '';
    try {
      const out = await server.transformRequest(`/src/cards/user/${c.file}${c.file.endsWith('.css') ? '?direct' : ''}`);
      text = String(out?.code ?? '');
    } catch (err) {
      text = `ERROR ${String(err?.message ?? err)} ${String(err?.frame ?? '')}`;
    }
    const want = c.expect ?? FAKE;
    const executed = c.executed ? fs.existsSync(execMark) : false;
    const leaked = text.includes(want) || (want === FAKE && text.includes(Buffer.from(`${FAKE}\n`).toString('base64').slice(0, 24)));
    const gate = checkSyncedSource(`src/cards/user/${c.file}`, c.source, { rootHas: (p) => fs.existsSync(path.join(project, p)) });
    const hit = leaked || executed;
    rows.push({ name: c.name, nodeSideRead: leaked, executedInNode: executed, precheckRejects: !gate.ok, why: gate.errors[0] ?? null });
    console.log(`${hit ? '缺口在' : '没读到'}  ${c.name}  ——  预检${gate.ok ? '放行' : '拒掉'}${gate.errors[0] ? `（${gate.errors[0].slice(0, 70).replace(FAKE, '<假凭证>')}）` : ''}`);
    if (hit) gaps.push(c.name);
  }
} finally {
  await server.close();
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 留给系统清 */ }
}
const uncovered = rows.filter((r) => (r.nodeSideRead || r.executedInNode) && !r.precheckRejects).map((r) => r.name);
const allRejected = rows.every((r) => r.precheckRejects);
console.log(JSON.stringify({ ok: uncovered.length === 0 && allRejected, gaps, uncovered, everyCaseRejectedByPrecheck: allRejected, rows: rows.map(({ name, ...rest }) => ({ name, ...rest, why: rest.why ? String(rest.why).replace(FAKE, '<假凭证>').slice(0, 100) : null })) }));
process.exit(uncovered.length === 0 && allRejected ? 0 : 1);
