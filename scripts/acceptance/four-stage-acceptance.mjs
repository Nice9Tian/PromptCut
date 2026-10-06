/**
 * 四段连做的最终验收:可断点续跑的清单式运行器(只用 Node 内置模块,加仓库里已有的 scripts/lib)。
 *
 *   node scripts/acceptance/four-stage-acceptance.mjs --list [--json]
 *   node scripts/acceptance/four-stage-acceptance.mjs [--only G0,G0-R,GR-*] [--from <编号>] [--out <目录>] [--resume]
 *        [--flaky-rerun 2] [--main-ref main] [--dev-port 5690] [--dev-main-port 5693] [--include-optional] [--dry-run]
 *   node scripts/acceptance/four-stage-acceptance.mjs --check-coverage
 *
 * 清单是数据(`four-stage-manifest.mjs`):每项有编号、名字、类别、命令、工作目录、前置服务、通过标准、
 * 是否带耗时门槛(只在笔记本上作数)、是否只能在新节点上验(脚本不跑)、对应任务书哪一条。选项见 `--help`。
 *
 * 输出目录 <out>:
 *   results.json   每项:命令、起止时间、退出码、判定、结果行原文、日志路径(每跑完一项就整份重写,可随时看)
 *   summary.txt    可以直接贴进对话的文本小结(结束或被中断时写)
 *   logs/<编号>.log  每项各自的标准输出与标准错误(并行的几个实例各占一个文件)
 *   services/      dev server、在线构建的日志
 *   dist-online/   在线构建产物(多项探针共用,带 .built-from 标记)
 *
 * 服务与端口(都在分给本脚本的 5690～5699 里):共享 dev server 占 --dev-port 起 3 个(缺省 5690～5692),
 * main 基准树的 dev server 占 --dev-main-port 起 3 个(缺省 5693～5695)。不需要 dev 的项开始前,上一台 dev 先停掉,
 * 把 5690～5699 让给探针自己起的东西。5190～5192、5210～5212 是用户在跑的,脚本不碰。
 *
 * main 基准树(像素比对用):`git worktree add --detach <主工作区>/.worktrees/acceptance-main-baseline <main-ref>`,
 * 依赖往上解析到主工作区的 node_modules,不建 junction、不 npm ci。结束时按 `verification.md`「会造成真实损失的操作」删除:
 * 先扫一遍里面有没有链接(junction / 符号链接),有就用 PowerShell 的 [System.IO.Directory]::Delete 只拆链接、
 * Test-Path 确认没了才继续,确认失败就中止、不删;之后 `git worktree remove --force`,并核对主工作区的 node_modules 还在。
 * 不是本脚本建的(上次遗留、已存在且就在 main-ref 上)就复用、不删;加 --keep-main-worktree 也不删。
 *
 * 子进程一律 windowsHide(并预载 scripts/lib/test-silent-processes.mjs,孙进程也静默);脚本结束(含 Ctrl-C、被 kill 前的信号)
 * 时把自己起的进程树清掉,只按 pid。不碰不是自己起的进程。
 *
 * 退出码:本次选中的、会跑的项里有 fail / ref-fail / flaky / blocked / missing → 1;否则 0(ref-pass 与 manual / remote 不算失败)。
 */
import '../lib/test-silent-processes.mjs'; // 第一个 import:之后起的命令行孙进程也不弹窗
import '../lib/no-user-dirs.mjs'; // 不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR,并设 PROMPTCUT_NO_PORT_FILE=1
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { REPO, killTree, portFree, tripleFree, viteBin, waitHttp, startDevServer, sleep } from '../lib/dev-server.mjs';
import {
  parseArgs, USAGE, validateManifest, selectItems, planResume, expandCmd, expandPlaceholders, judge, combineAttempts,
  listText, summaryText, commandText, describeItem, coverageReport, DONE_VERDICTS, matrixText,
} from './acceptance-lib.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));

// 清单模块可以用环境变量 PC_ACCEPTANCE_MANIFEST 换成别的(单测用一份假清单跑真的子进程流程)
const MANIFEST_FILE = process.env.PC_ACCEPTANCE_MANIFEST ? path.resolve(process.env.PC_ACCEPTANCE_MANIFEST) : path.join(HERE, 'four-stage-manifest.mjs');
const { ITEMS, EXCLUDED_PROBE_FILES = {}, TASK_ACCEPTANCE = { R: [], C: [], U: [] } } = await import(pathToFileURL(MANIFEST_FILE).href);

/* ------------------------------------------------------------------ 小工具 */

const nowIso = () => new Date().toISOString();
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
const log = (...a) => console.log(`[${new Date().toTimeString().slice(0, 8)}]`, ...a);

function git(args, cwd = REPO, opts = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, ...opts });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

/** 主工作区:worktree 的 git-common-dir 的上一级 */
function mainWorkspaceOf(repo) {
  const r = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], repo);
  if (r.code === 0 && r.out) return path.dirname(r.out);
  return repo;
}

/** tsc 的入口:worktree 没有自己的 node_modules,从仓库往上解析 */
function resolvePackageBin(pkg, rel) {
  const req = createRequire(path.join(REPO, 'package.json'));
  const pj = req.resolve(`${pkg}/package.json`);
  return path.join(path.dirname(pj), rel);
}

/* ------------------------------------------------------------------ 进程登记与清理 */

const activePids = new Set();
let cleaningUp = false;
function killAllSync() {
  for (const pid of [...activePids]) { killTree(pid); activePids.delete(pid); }
}

/* ------------------------------------------------------------------ 起一条命令 */

const OUTPUT_CAP = 8 * 1024 * 1024;

/**
 * 跑一步:cmd 已展开。返回 { exitCode, output, timedOut, idleKilled, spawnError, logFile }。
 * 输出同时写日志文件、留在内存里(上限 OUTPUT_CAP,超出丢最早的)。
 */
function runCommand({ cmd, cwd, env, logFile, timeoutMin, idleKillMin, label }) {
  return new Promise((resolve) => {
    const stream = fs.createWriteStream(logFile, { flags: 'w' });
    stream.write(`# ${label}\n# cwd ${cwd}\n# $ ${cmd.join(' ')}\n# 开始 ${nowIso()}\n\n`);
    const file = cmd[0] === 'node' ? process.execPath : cmd[0];
    let child;
    try {
      child = spawn(file, cmd.slice(1), { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      stream.end(`起不来:${e.message}\n`);
      resolve({ exitCode: null, output: '', spawnError: e.message, logFile });
      return;
    }
    activePids.add(child.pid);
    let buf = '';
    let timedOut = false, idleKilled = null, done = false;
    let lastData = Date.now();
    const onData = (chunk) => {
      lastData = Date.now();
      const s = chunk.toString('utf8');
      stream.write(s);
      buf += s;
      if (buf.length > OUTPUT_CAP) buf = buf.slice(buf.length - OUTPUT_CAP);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, (timeoutMin || 30) * 60_000);
    const idle = idleKillMin
      ? setInterval(() => { if (Date.now() - lastData > idleKillMin * 60_000) { idleKilled = idleKillMin; killTree(child.pid); } }, Math.min(15_000, Math.max(200, idleKillMin * 15_000)))
      : null;
    const finish = (exitCode, signal, spawnError) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (idle) clearInterval(idle);
      activePids.delete(child.pid);
      // 命令自己退出了也可能留下孙进程(vite、Chrome):按 pid 再扫一遍这棵树
      killTree(child.pid);
      stream.end(`\n# 结束 ${nowIso()} 退出码 ${exitCode}${signal ? ` 信号 ${signal}` : ''}${timedOut ? ' (超时)' : ''}${idleKilled ? ' (空闲被杀)' : ''}\n`);
      resolve({ exitCode, output: buf, timedOut, idleKilled, spawnError, logFile });
    };
    child.once('error', (e) => finish(null, null, e.message));
    child.once('close', (code, signal) => finish(code, signal));
  });
}

/* ------------------------------------------------------------------ 服务 */

class Services {
  constructor(ctx) { this.ctx = ctx; this.live = new Map(); }

  async ensure(name) {
    if (this.live.has(name)) return this.live.get(name).vars;
    const svc = await this.start(name);
    this.live.set(name, svc);
    return svc.vars;
  }

  async start(name) {
    const { ctx } = this;
    const svcDir = path.join(ctx.out, 'services');
    fs.mkdirSync(svcDir, { recursive: true });
    if (name === 'dev') {
      log(`起共享 dev server(${ctx.opts.devPort}～${ctx.opts.devPort + 2})`);
      const s = await startDevServer({ port: ctx.opts.devPort, logFile: path.join(svcDir, 'dev.log'), log });
      activePids.add(s.pid);
      return { vars: { 'dev.origin': s.origin, 'dev.port': s.port }, stop: () => { activePids.delete(s.pid); s.stop(); } };
    }
    if (name === 'main-worktree') return this.startMainWorktree();
    if (name === 'dev-main') {
      const mv = await this.ensure('main-worktree');
      const port = ctx.opts.devMainPort;
      if (!(await tripleFree(port))) throw new Error(`端口 ${port}～${port + 2} 没有全空着`);
      log(`起 main 基准树的 dev server(${port}～${port + 2})`);
      const logFile = path.join(svcDir, 'dev-main.log');
      const stream = fs.createWriteStream(logFile, { flags: 'a' });
      const child = spawn(process.execPath, [viteBin(), '--port', String(port), '--strictPort', '--host', '127.0.0.1'], {
        cwd: mv.main, env: { ...process.env, BROWSER: 'none' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      });
      activePids.add(child.pid);
      let exited = false;
      child.stdout.on('data', (c) => stream.write(c));
      child.stderr.on('data', (c) => stream.write(c));
      child.once('exit', () => { exited = true; stream.end(); });
      const origin = `http://127.0.0.1:${port}`;
      const stop = () => { if (!exited) killTree(child.pid); activePids.delete(child.pid); };
      try {
        await Promise.race([
          waitHttp(`${origin}/api/mcp/status`, (d) => d && typeof d.port === 'number', 120_000, '等 main 基准树的 dev server 起来'),
          new Promise((_, rej) => child.once('exit', (c) => rej(new Error(`vite 提前退出(code ${c}),看 ${logFile}`)))),
        ]);
      } catch (e) { stop(); throw e; }
      return { vars: { 'dev-main.origin': origin, 'dev-main.port': port }, stop };
    }
    if (name === 'online-build') return this.buildOnline();
    throw new Error(`没有这个服务:${name}`);
  }

  async buildOnline() {
    const { ctx } = this;
    const dist = ctx.vars.dist;
    const marker = path.join(dist, '.built-from');
    const head = git(['rev-parse', 'HEAD']).out;
    let fresh = false;
    try { fresh = fs.existsSync(path.join(dist, 'index.html')) && fs.readFileSync(marker, 'utf8').trim() === head; } catch { /* 重建 */ }
    if (!fresh) {
      log('在线构建(vite build --mode online)');
      const r = await runCommand({
        cmd: ['node', viteBin(), 'build', '--mode', 'online', '--outDir', dist], cwd: REPO, env: { ...process.env },
        logFile: path.join(ctx.out, 'services', 'online-build.log'), timeoutMin: 15, label: '在线构建',
      });
      if (r.exitCode !== 0 || !fs.existsSync(path.join(dist, 'index.html'))) throw new Error(`在线构建失败(退出码 ${r.exitCode}),看 services/online-build.log`);
      fs.writeFileSync(marker, head);
    }
    return { vars: {}, stop: () => {} };
  }

  async startMainWorktree() {
    const { ctx } = this;
    const dir = ctx.mainDir;
    const ref = ctx.opts.mainRef;
    const want = git(['rev-parse', '--verify', `${ref}^{commit}`]);
    if (want.code !== 0) throw new Error(`解析不了 --main-ref ${ref}:${want.err}`);
    let created = false;
    if (fs.existsSync(dir)) {
      const have = git(['rev-parse', 'HEAD'], dir);
      const registered = git(['worktree', 'list', '--porcelain']).out.split(/\r?\n/).some((l) => l.startsWith('worktree ') && path.resolve(l.slice(9)) === path.resolve(dir));
      if (!registered || have.out !== want.out) throw new Error(`${dir} 已存在但不是 ${ref}(${want.out.slice(0, 8)})上登记过的 worktree;不动它,换位置或手工处理`);
      log(`复用已有的 main 基准树 ${dir}`);
    } else {
      log(`建 main 基准树:git worktree add --detach ${dir} ${ref}(${want.out.slice(0, 8)})`);
      const r = git(['worktree', 'add', '--detach', dir, ref]);
      if (r.code !== 0) throw new Error(`git worktree add 失败:${r.err}`);
      created = true;
    }
    ctx.mainCommit = want.out;
    const stop = () => {
      if (!created) return;
      if (ctx.opts.keepMainWorktree) { log(`保留 main 基准树 ${dir}`); return; }
      removeWorktreeSafely(dir);
    };
    return { vars: { main: dir }, stop };
  }

  stopDevs() {
    for (const name of ['dev', 'dev-main']) {
      const svc = this.live.get(name);
      if (svc) { log(`停 ${name} dev server`); try { svc.stop(); } catch { /* 已退出 */ } this.live.delete(name); }
    }
  }

  stopAll() {
    this.stopDevs();
    for (const [name, svc] of [...this.live]) { try { svc.stop(); } catch (e) { log(`停 ${name} 出错:${e.message}`); } this.live.delete(name); }
  }
}

/** 扫目录里的链接(不跟随),最多 depth 层、最多 limit 个条目 */
export function findLinks(dir, depth = 3, limit = 20000) {
  const links = [];
  let seen = 0;
  const walk = (d, left) => {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (++seen > limit) return;
      const p = path.join(d, e.name);
      let st;
      try { st = fs.lstatSync(p); } catch { continue; }
      if (st.isSymbolicLink()) { links.push(p); continue; }
      if (st.isDirectory() && left > 0 && e.name !== '.git') walk(p, left - 1);
    }
  };
  walk(dir, depth);
  return links;
}

/** 按 verification.md 删带(可能的)junction 的 worktree:先只拆链接并确认,再 git worktree remove */
function removeWorktreeSafely(dir) {
  const nm = path.join(mainWorkspaceOf(REPO), 'node_modules');
  const nmBefore = fs.existsSync(nm);
  const links = findLinks(dir);
  for (const l of links) {
    const ps = `[System.IO.Directory]::Delete('${l.replace(/'/g, "''")}'); if (Test-Path -LiteralPath '${l.replace(/'/g, "''")}') { exit 3 } else { exit 0 }`;
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, encoding: 'utf8' });
    if (r.status !== 0) { log(`⚠ 拆链接 ${l} 失败,中止,不删 ${dir}`); return false; }
    log(`拆了链接 ${l}`);
  }
  const r = git(['worktree', 'remove', '--force', dir]);
  if (r.code !== 0) { log(`⚠ git worktree remove 失败:${r.err}`); return false; }
  if (nmBefore && !fs.existsSync(nm)) log('‼ 主工作区的 node_modules 不见了!');
  log(`已删 main 基准树 ${dir}`);
  return true;
}

/* ------------------------------------------------------------------ 主流程 */

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message + '\n\n' + USAGE); process.exit(2); }
  if (opts.help) { console.log(USAGE); return 0; }

  const errs = validateManifest(ITEMS);
  if (errs.length) { console.error('清单不合格:\n  ' + errs.join('\n  ')); return 2; }

  if (opts.list) {
    let items;
    try { items = selectItems(ITEMS, { only: opts.only, from: opts.from, includeOptional: true }); } catch (e) { console.error(e.message); return 2; }
    console.log(opts.json ? JSON.stringify(items, null, 2) : listText(items));
    if (!opts.json) console.log(`\n共 ${items.length} 项`);
    return 0;
  }
  if (opts.matrix) {
    console.log(matrixText(ITEMS, { '任务书一 sound-online-render-task.md 编号验收': TASK_ACCEPTANCE.R, '任务书二 cloud-agent-task.md 完成条件': TASK_ACCEPTANCE.C, '任务书二「用户体验验收」六条': TASK_ACCEPTANCE.U }));
    return 0;
  }
  if (opts.checkCoverage) {
    const names = fs.readdirSync(path.join(REPO, 'scripts', 'probes'), { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
    const rep = coverageReport(names, ITEMS, EXCLUDED_PROBE_FILES);
    console.log(`scripts/probes 下 ${names.length} 个文件`);
    console.log(rep.unlisted.length ? `清单没登记也没写排除原因(${rep.unlisted.length}):\n  ${rep.unlisted.join('\n  ')}` : '都登记了或写明了排除原因');
    if (rep.staleExcluded.length) console.log(`排除表里有、本检出没有的(多半在后三段分支上):${rep.staleExcluded.join(', ')}`);
    if (rep.staleCovers.length) console.log(`清单 covers 里有、本检出没有的(多半在后三段分支上):${rep.staleCovers.join(', ')}`);
    return rep.unlisted.length ? 1 : 0;
  }

  let selected;
  try { selected = selectItems(ITEMS, { only: opts.only, from: opts.from, includeOptional: opts.includeOptional }); } catch (e) { console.error(e.message); return 2; }

  const mainWorkspace = mainWorkspaceOf(REPO);
  const out = path.resolve(opts.out || path.join(mainWorkspace, 'work', 'four-stage', 'final-prep', stamp()));
  const resultsFile = path.join(out, 'results.json');
  fs.mkdirSync(path.join(out, 'logs'), { recursive: true });

  const head = git(['rev-parse', 'HEAD']).out;
  const dirty = git(['status', '--porcelain']).out.split(/\r?\n/).filter(Boolean).length;

  let previous = null;
  if (opts.resume) {
    try {
      const prev = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
      if (prev.meta.commit !== head && !opts.forceResume) {
        console.error(`上次是在 ${prev.meta.commit.slice(0, 8)} 上跑的,现在是 ${head.slice(0, 8)};结果不能混。要续跑加 --force-resume,或换个 --out 重来。`);
        return 2;
      }
      previous = prev.items;
    } catch { console.error(`--resume:读不到 ${resultsFile},按全新一次开始`); }
  }
  const plan = planResume(selected, previous, { resume: opts.resume });

  const vars = {
    node: process.execPath, repo: REPO, out, tsc: resolvePackageBin('typescript', path.join('bin', 'tsc')), vite: viteBin(),
    dist: path.join(out, 'dist-online'), main: path.join(mainWorkspace, '.worktrees', 'acceptance-main-baseline'),
    mainWorkspace,
  };
  const ctx = { opts, out, vars, mainDir: vars.main, mainCommit: null };

  const meta = {
    startedAt: nowIso(), finishedAt: null, commit: head, dirtyFiles: dirty, host: os.hostname(), node: process.version,
    platform: `${process.platform} ${os.release()}`, cpus: os.cpus().length, mainRef: opts.mainRef, mainCommit: null, out,
    args: process.argv.slice(2), manifestItems: ITEMS.length,
  };
  const results = []; // 本次的全部记录(含续跑沿用的)
  for (const { item, previous: prev } of plan.skip) results.push({ ...prev, carried: true });
  const byId = () => new Map(results.map((r) => [r.id, r]));

  const save = (finished) => {
    if (finished) meta.finishedAt = nowIso();
    meta.mainCommit = ctx.mainCommit;
    const order = new Map(ITEMS.map((it, i) => [it.id, i]));
    const sorted = results.slice().sort((a, b) => order.get(a.id) - order.get(b.id));
    const tmp = resultsFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ meta, items: sorted }, null, 2));
    fs.renameSync(tmp, resultsFile);
    fs.writeFileSync(path.join(out, 'summary.txt'), summaryText({ meta, items: sorted }) + '\n');
  };

  if (opts.dryRun) {
    console.log(`将跑 ${plan.run.length} 项(续跑跳过 ${plan.skip.length} 项),输出目录 ${out}`);
    for (const it of plan.run) console.log(`${it.id}\t${it.name}\t${it.manual ? '[人工]' : it.remoteOnly ? '[新节点]' : commandText(it)}`);
    return 0;
  }

  const services = new Services(ctx);
  const cleanup = () => {
    if (cleaningUp) return;
    cleaningUp = true;
    try { services.stopAll(); } catch { /* 尽力 */ }
    killAllSync();
  };
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    process.on(sig, () => {
      log(`收到 ${sig},清理自己起的进程树后退出`);
      try { save(false); } catch { /* 尽力 */ }
      cleanup();
      process.exit(130);
    });
  }

  log(`验收运行:提交 ${head.slice(0, 8)}${dirty ? `(工作区有 ${dirty} 个未提交改动)` : ''},选中 ${selected.length} 项,将跑 ${plan.run.length} 项,输出 ${out}`);

  const runOne = async (item, attemptNo) => {
    // attemptNo 是字符串标记:'' 首跑,'retry1'… 定稳定性的重跑,'idle' 空闲被杀后的那一次
    const tag = attemptNo ? `-${attemptNo}` : '';
    const rec = {
      id: item.id, name: item.name, category: item.category, taskRef: item.taskRef,
      timing: item.timing || false, timingNote: item.timingNote || null, known: item.known || null,
      cmd: commandText(item) || null, flags: describeItem(item),
    };
    if (item.manual) return { ...rec, verdict: 'manual', reasons: [item.manual], logs: [] };
    if (item.remoteOnly) return { ...rec, verdict: 'remote', reasons: [item.remoteOnly], logs: [] };
    const missing = (item.requires || []).filter((f) => !fs.existsSync(path.join(REPO, f)));
    for (const { file, text } of item.requiresText || []) {
      let have = '';
      try { have = fs.readFileSync(path.join(REPO, file), 'utf8'); } catch { /* 没有文件算缺 */ }
      if (!have.includes(text)) missing.push(`${file} 里没有「${text}」`);
    }
    if (missing.length) return { ...rec, verdict: 'missing', reasons: [`本检出没有:${missing.join('、')}`], logs: [] };
    const byIdNow = byId();
    for (const p of item.prereq || []) {
      const pr = byIdNow.get(p);
      if (pr && !DONE_VERDICTS.has(pr.verdict)) return { ...rec, verdict: 'blocked', reasons: [`前置 ${p} 没过(${pr.verdict})`], logs: [] };
    }
    const needs = new Set(item.needs || []);
    if (!needs.has('dev') && !needs.has('dev-main')) services.stopDevs();
    else {
      if (!needs.has('dev') && services.live.has('dev')) { services.live.get('dev').stop(); services.live.delete('dev'); }
      if (!needs.has('dev-main') && services.live.has('dev-main')) { services.live.get('dev-main').stop(); services.live.delete('dev-main'); }
    }
    const startedMs = Date.now();
    try {
      for (const n of needs) Object.assign(vars, await services.ensure(n));
    } catch (e) {
      return { ...rec, startedAt: new Date(startedMs).toISOString(), finishedAt: nowIso(), verdict: 'blocked', reasons: [`前置服务起不来:${e.message}`], logs: [] };
    }
    const itemDir = path.join(out, 'items', item.id + tag);
    fs.mkdirSync(itemDir, { recursive: true });
    vars.item = itemDir;
    const cwd = item.cwd === 'main' ? vars.main : REPO;
    const stepSpecs = (item.cmd ? [{ cmd: item.cmd }] : item.steps.map((s) => (Array.isArray(s) ? { cmd: s } : s)));
    const env = { ...process.env, PC_ACCEPTANCE: '1' };
    for (const [k, v] of Object.entries(item.env || {})) env[k] = expandPlaceholders(v, vars);
    const mk = (spec, i) => {
      const suffix = tag + (stepSpecs.length > 1 ? `-s${i + 1}` : '');
      return runCommand({
        cmd: expandCmd(spec.cmd, vars), cwd: spec.cwd === 'main' ? vars.main : cwd, env: { ...env, ...Object.fromEntries(Object.entries(spec.env || {}).map(([k, v]) => [k, expandPlaceholders(v, vars)])) },
        logFile: path.join(out, 'logs', `${item.id}${suffix}.log`), timeoutMin: item.timeoutMin, idleKillMin: item.idleKillMin,
        label: `${item.id} ${item.name}${stepSpecs.length > 1 ? ` 第 ${i + 1} 步` : ''}`,
      });
    };
    let steps;
    if (item.parallel) steps = await Promise.all(stepSpecs.map(mk));
    else {
      steps = [];
      for (let i = 0; i < stepSpecs.length; i++) {
        const r = await mk(stepSpecs[i], i);
        steps.push(r);
        if (r.exitCode !== 0 && !(item.pass?.exit && [].concat(item.pass.exit).includes(r.exitCode)) && !stepSpecs[i].continueOnFail) break;
      }
    }
    // 空闲被杀且允许重试一次(npm test 偶发卡死)
    if (steps.some((s) => s.idleKilled) && item.retryOnIdle && !attemptNo) {
      log(`${item.id} 空闲被杀,按清单重跑一次`);
      const second = await runOne({ ...item, retryOnIdle: 0 }, 'idle');
      second.idleRetried = true;
      return second;
    }
    const j = judge(item, steps);
    return {
      ...rec, cmd: steps.map((s, i) => expandCmd(stepSpecs[i].cmd, vars).join(' ')).join(item.parallel ? ' ‖ ' : ' && '),
      startedAt: new Date(startedMs).toISOString(), finishedAt: nowIso(), durationSec: Math.round((Date.now() - startedMs) / 1000),
      exitCodes: steps.map((s) => s.exitCode), verdict: j.verdict, reasons: j.reasons, resultLine: j.resultLine, metrics: j.metrics,
      logs: steps.map((s) => path.relative(out, s.logFile)),
    };
  };

  for (const item of plan.run) {
    log(`▶ ${item.id}  ${item.name}`);
    let rec;
    try { rec = await runOne(item, ''); } catch (e) {
      rec = { id: item.id, name: item.name, category: item.category, taskRef: item.taskRef, verdict: 'fail', reasons: [`运行器出错:${e.stack || e.message}`], logs: [], known: item.known || null };
    }
    rec.attempts = [{ verdict: rec.verdict, exitCodes: rec.exitCodes, durationSec: rec.durationSec, logs: rec.logs }];
    results.push(rec);
    log(`  ${rec.verdict}${rec.reasons?.length ? ' — ' + rec.reasons.join(';').slice(0, 200) : ''}${rec.durationSec != null ? `  (${rec.durationSec}s)` : ''}`);
    save(false);
  }

  if (opts.flakyRerun > 0) {
    const failing = results.filter((r) => ['fail', 'ref-fail'].includes(r.verdict) && !r.carried);
    for (const rec of failing) {
      const item = ITEMS.find((it) => it.id === rec.id);
      for (let n = 1; n <= opts.flakyRerun; n++) {
        log(`↻ ${item.id} 定稳定性,重跑 ${n}/${opts.flakyRerun}`);
        let r2;
        try { r2 = await runOne(item, `retry${n}`); } catch (e) { r2 = { verdict: 'fail', reasons: [e.message], logs: [] }; }
        rec.attempts.push({ verdict: r2.verdict, exitCodes: r2.exitCodes, durationSec: r2.durationSec, logs: r2.logs, reasons: r2.reasons });
        save(false);
      }
      const c = combineAttempts(rec.attempts);
      rec.verdict = c.verdict;
      rec.stability = c.stability;
      save(false);
    }
  }

  services.stopAll();
  save(true);
  const final = [...results].sort((a, b) => ITEMS.findIndex((i) => i.id === a.id) - ITEMS.findIndex((i) => i.id === b.id));
  console.log('\n' + summaryText({ meta, items: final }));
  console.log(`\nresults.json:${resultsFile}`);
  const bad = results.filter((r) => ['fail', 'ref-fail', 'flaky', 'blocked', 'missing'].includes(r.verdict));
  return bad.length ? 1 : 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().then((code) => { process.exitCode = code; }, (e) => { console.error(e); process.exitCode = 2; });
}
