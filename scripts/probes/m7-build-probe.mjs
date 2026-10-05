/**
 * M7 契约第 8 节 P6(`docs/plan/m7-contract.md`):页面引渲染节点的会话状态机 `server/render-node/session.mjs` 之后,
 * `vite build --mode online` 能不能构建、构建产物在页面里能不能跑。报告:docs/archive/agent-reports/AGENT-m7-probe.md。
 *
 *   node scripts/probes/m7-build-probe.mjs --root <检出目录> [--skip-build] [--port 5713] [--global __m7CreateNodeSession]
 *   node scripts/probes/m7-build-probe.mjs --url http://127.0.0.1:5714/?stage=1     只做第 3 步:打开现成的页面(如开发服务器)
 *
 * 做法:
 *   1. 在 `--root` 里跑 `npx vite build --mode online`(`--skip-build` 跳过,直接用现成的 `dist-online/`),
 *      记退出码、耗时、构建日志里所有提到 `node:` 内置模块的行(externalized / not exported / 解析失败);
 *   2. 在 `--port` 起静态服务,把 `dist-online/` 挂在 `/editor/`(与托管端同形),用 puppeteer 自带的 Chrome 打开
 *      `/editor/?stage=1`(舞台页最轻,不连文档服务),收 pageerror 与 console.error;
 *   3. 页面里若有 `window[--global]`(实验分支 `claude/m7-probe-exp` 的 `src/online/m7NodeProbe.ts` 把
 *      `createNodeSession` 挂在这里),就真的建一个会话:`start()` 应发 `node.hello` + `queue.watch`;
 *      喂 `node.welcome`、带一个浏览器可做的快照任务的 `queue.snapshot`,`tick()` 应发 `task.claim`。
 *
 * 要测的变体由调用方在 `--root` 那份检出里改好(见报告 P6 一节的三步)。
 * 输出:过程写 stderr,最后一行 stdout 是一行 JSON `{ build: { exit, ms, nodeLines }, runtime: {...} }`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { flagArg, serve, closeAll } from './probe-connect.mjs';

const ROOT = path.resolve(flagArg('root', process.cwd()));
const PORT = Number(flagArg('port', '5713'));
const GLOBAL = flagArg('global', '__m7CreateNodeSession');
const URL_ARG = flagArg('url', null);
const SKIP = process.argv.includes('--skip-build') || !!URL_ARG;
const err = (...a) => console.error(...a);

const out = { root: ROOT, build: null, runtime: null };
if (!SKIP) {
  const t0 = Date.now();
  const r = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vite', 'build', '--mode', 'online'], { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 64 << 20 });
  const log = `${r.stdout || ''}\n${r.stderr || ''}`.replace(/\x1b\[[0-9;]*m/g, '');
  const nodeLines = [...new Set(log.split(/\r?\n/).filter((l) => /node:[a-z_]+/.test(l) && /externalized|not exported|resolve|Error|error/i.test(l)).map((l) => l.trim().replace(ROOT.replace(/\\/g, '/'), '<root>').slice(0, 300)))];
  out.build = { exit: r.status, ms: Date.now() - t0, nodeLines, errorLines: log.split(/\r?\n/).filter((l) => /\berror\b/i.test(l) && !/warn/i.test(l)).slice(0, 10).map((l) => l.slice(0, 300)) };
  err(`build exit=${r.status} ${out.build.ms}ms node-lines=${nodeLines.length}`);
  for (const l of nodeLines) err('  ' + l);
}

const DIST = path.join(ROOT, 'dist-online');
if (URL_ARG || fs.existsSync(path.join(DIST, 'index.html'))) {
  const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };
  const server = URL_ARG ? null : await serve(PORT, (req, res) => {
    const u = new URL(req.url, 'http://x');
    let p = u.pathname.startsWith('/editor/') ? u.pathname.slice('/editor/'.length) : null;
    if (p === null) { res.statusCode = 404; return res.end(); }
    if (!p) p = 'index.html';
    const file = path.join(DIST, decodeURIComponent(p));
    if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; return res.end(); }
    res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
    res.setHeader('Origin-Agent-Cluster', '?1');
    res.end(fs.readFileSync(file));
  }, '127.0.0.1');
  const browser = await puppeteer.launch({ headless: true, args: [...PROBE_CHROME_ARGS, '--disable-gpu'] });
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    const consoleErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e.message || e).slice(0, 300)));
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
    await page.goto(URL_ARG || `http://127.0.0.1:${PORT}/editor/?stage=1`, { waitUntil: 'load', timeout: 60000 });
    await new Promise((r) => setTimeout(r, 1500));
    const rt = await page.evaluate(async (G) => {
      const f = window[G];
      if (typeof f !== 'function') return { hasGlobal: false };
      const sent = [];
      let t = 0;
      const s = f({ nodeId: 'm7-probe-node', node: { profile: 'browser', userId: 'u@d', envFingerprint: 'fp-browser', capabilities: {}, codeVersions: ['cv1'] },
        send: (m) => sent.push(m), now: () => t, projects: ['p1'], onTask: (task) => sent.push({ type: '(onTask)', id: task?.id }) });
      s.start([]);
      s.receive({ type: 'node.welcome', epoch: 'e1', lost: [] });
      const task = { id: 't1', kind: 'snapshot', state: 'open', tier: 'shared', weight: { class: 'medium' }, priority: 10,
        source: { projectId: 'p1', userId: 'u@d', projectRev: 1 }, requires: { envFingerprint: 'fp-browser', codeVersion: 'cv1', cardSources: {} }, input: {} };
      s.receive({ type: 'queue.snapshot', projectId: 'p1', tasks: [task] });
      t = 1000; s.tick();
      return { hasGlobal: true, sent: sent.map((m) => m.type), known: s.known().length };
    }, GLOBAL).catch((e) => ({ evalError: String(e.message || e).slice(0, 300) }));
    out.runtime = { pageErrors, consoleErrors: consoleErrors.slice(0, 8), ...rt };
    err(`runtime ${JSON.stringify(out.runtime)}`);
  } finally {
    await browser.close().catch(() => {});
    if (server) await closeAll([server]);
  }
} else out.runtime = { skipped: 'no dist-online/index.html' };
console.log(JSON.stringify(out));
