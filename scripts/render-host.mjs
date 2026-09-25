#!/usr/bin/env node
/**
 * 独立渲染主机的入口(M6b,契约 `docs/plan/render-host-contract.md` 第 2 节)。
 *
 * 起一个不带页面的编辑器 vite(它会拉起预渲染进程),只绑回环。预渲染进程按下面的环境变量以
 * 主机形态起队列节点:每个共享项目一条 `render` 连接、一个 `profile: 'host'` 的节点,只认领细任务,
 * 产物推到各项目文档服务下发的素材服务(编排在 `server/render-node/host.mjs`,接线在
 * `server/vite-plugin-frames.ts` 的 `startHostNode`)。
 *
 *   node scripts/render-host.mjs --config <文件> [--port 5400] [--data <目录>] [--max-concurrent N]
 *        [--streams] [--verbose] [--json-status]
 *
 *   --config          共享项目配置(M6a 契约第 11 节的形状:一项或数组,每项
 *                     `{ url, projectId, username, deviceId, deviceName, as: 'member', password | key, role: 'render' }`,
 *                     另可给 `maxConcurrent`)。不给就用环境变量 `PROMPTCUT_SHARED_CONFIG`。
 *   --port            编辑器端口,缺省 5400。编辑器另占「端口 +1」「端口 +2」当舞台端口(没有页面也照样起)。
 *   --data            这个实例的数据目录(帧库、编辑器数据、临时目录),缺省 `<系统临时目录>/promptcut-render-host-<端口>`。
 *                     每个实例要各用一份:帧库和临时目录不能共用。
 *   --max-concurrent  并发总数(1～4),覆盖配置里的 `maxConcurrent`。
 *   --streams         `PROMPTCUT_STREAMS=1`(缺省 0:流任务在 M6c 之前不走队列)。
 *   --verbose         把编辑器与预渲染进程的输出原样转出来(缺省只转 `[queue-node]` 与报错行)。
 *
 * 给子进程设的环境变量(契约第 2 节):`PROMPTCUT_QUEUE_NODE=1`、`PROMPTCUT_NODE_PROFILE=host`、
 * `PROMPTCUT_SHARED_CONFIG=<配置文件的绝对路径>`、`PROMPTCUT_STREAMS`;另外:
 *   - `PROMPTCUT_EXPORT_DIR` / `PROMPTCUT_DATA_DIR` 指到 `--data` 下,不碰工作副本的 `out/` 与用户数据目录;
 *   - `TEMP` / `TMP` / `TMPDIR` 指到 `--data/tmp`:编辑器 vite 会往系统临时目录写 `promptcut/port.json`
 *     (给没指定端口的 MCP 兜底),主机若写到公共的那一份,会把同一台机器上用户自己编辑器的 AI 面板指错;
 *   - 删掉 `PROMPTCUT_DOCSERVICE_URL`、`PROMPTCUT_CLUSTER_TOKEN`、`PROMPTCUT_HEADLESS`、`PROMPTCUT_PUSH`:主机只凭项目凭证
 *     连配置里的文档服务,集群令牌不进数据面。
 *
 * 起来之后打一行 `[render-host] ready {…}`(`GET /api/frames/queue` 的结果,不含凭证)。
 *
 * 退出:SIGINT、SIGTERM、SIGBREAK,或经 IPC 收到 `{ type: 'shutdown' }`(探针用;Windows 上别的进程发不了真信号):
 *   1. `POST /api/frames/queue/release`:各节点 `task.release` 手里的认领、停节点、关连接;
 *   2. 打一行 `[render-host] exit {…}`(最后一次诊断);
 *   3. 结束编辑器进程树(含预渲染进程和它的 Chrome)。退出码 0。
 * 编辑器进程自己挂了:退出码 1。
 *
 * 编辑器进程以独立进程组起(Windows 上 `detached` + `windowsHide`):控制台里的 Ctrl+C 只到本进程,由本进程按上面的顺序收尾,
 * 不会先把预渲染进程打死、来不及放回认领。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { renderHostArgs as parseArgs, renderHostEnv as hostEnv } from '../server/render-node/host.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 工作副本没有自己的 node_modules(往上走到主仓库那一份),所以按模块解析 vite 的 bin */
function viteBin() {
  const local = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  if (fs.existsSync(local)) return local;
  const main = createRequire(import.meta.url).resolve('vite');
  const at = main.lastIndexOf(`${path.sep}vite${path.sep}`);
  return path.join(main.slice(0, at + 6), 'bin', 'vite.js');
}

const say = (tag, fields) => console.log(`[render-host] ${tag} ${JSON.stringify(fields)}`);

async function getJson(url, init) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(init?.timeoutMs ?? 5000) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); }
  catch (error) { console.error(`[render-host] ${error.message}`); process.exit(2); }
  const config = opts.config ?? process.env.PROMPTCUT_SHARED_CONFIG;
  if (!config) { console.error('[render-host] 要给 --config 或 PROMPTCUT_SHARED_CONFIG'); process.exit(2); }
  if (!fs.existsSync(config)) { console.error('[render-host] 配置文件不存在'); process.exit(2); }
  const data = path.resolve(opts.data ?? path.join(os.tmpdir(), `promptcut-render-host-${opts.port}`));
  fs.mkdirSync(path.join(data, 'tmp'), { recursive: true });
  fs.mkdirSync(path.join(data, 'data'), { recursive: true });

  const editorUrl = `http://127.0.0.1:${opts.port}`;
  const env = hostEnv(process.env, { config, data, streams: opts.streams, maxConcurrent: opts.maxConcurrent });
  const child = spawn(process.execPath, [viteBin(), '--port', String(opts.port), '--strictPort', '--host', '127.0.0.1'], {
    cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: true,
  });
  let tail = '';
  const forward = (chunk) => {
    const text = tail + chunk.toString();
    const lines = text.split('\n');
    tail = lines.pop() ?? '';
    for (const line of lines) {
      if (opts.verbose || /\[queue-node\]|\[render-host\]|error|Error|ERR_/.test(line)) process.stdout.write(`${line}\n`);
    }
  };
  child.stdout.on('data', forward);
  child.stderr.on('data', forward);

  let stopping = false;
  const killTree = () => {
    if (child.exitCode !== null || !child.pid) return;
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else { try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* 已经没了 */ } } }
  };
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  child.once('exit', (code) => {
    if (stopping) return;
    say('editor-exit', { code });
    process.exit(1);
  });

  const shutdown = async (why) => {
    if (stopping) return;
    stopping = true;
    say('stopping', { why });
    let released = null;
    try { released = (await getJson(`${editorUrl}/api/frames/queue/release`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', timeoutMs: 15000 })).body?.released ?? null; }
    catch { /* 编辑器已经不在了:队列按断线回收 */ }
    let last = null;
    try { last = (await getJson(`${editorUrl}/api/frames/queue`)).body; } catch { /* 同上 */ }
    say('exit', { released, queue: last });
    killTree();
    await Promise.race([exited, delay(15000)]);
    process.exit(0);
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
    try { process.on(signal, () => { void shutdown(signal); }); } catch { /* 这个平台没有这个信号 */ }
  }
  process.on('message', (message) => { if (message?.type === 'shutdown') void shutdown('ipc'); });
  process.on('disconnect', () => { void shutdown('ipc-disconnect'); });

  // 等编辑器、预渲染进程起来,再打一下 /api/frames/queue 让预渲染进程建管线、起节点
  const deadline = Date.now() + 240_000;
  let ready = false;
  while (!stopping && Date.now() < deadline) {
    try {
      const info = await getJson(`${editorUrl}/api/prerender/info`);
      if (info.body?.ready) { ready = true; break; }
    } catch { /* 还没起来 */ }
    await delay(500);
  }
  if (stopping) return;
  if (!ready) { say('not-ready', { port: opts.port }); stopping = true; killTree(); await Promise.race([exited, delay(15000)]); process.exit(1); }
  let summary = null;
  while (!stopping && Date.now() < deadline) {
    try {
      const q = await getJson(`${editorUrl}/api/frames/queue`, { timeoutMs: 40000 });
      summary = q.body;
      if (Array.isArray(summary?.nodes) && summary.nodes.length > 0) break;
    } catch { /* 预渲染进程还在开 Chrome */ }
    await delay(1000);
  }
  if (stopping) return;
  say('ready', { port: opts.port, data, queue: summary });
  if (process.send) process.send({ type: 'ready', port: opts.port, queue: summary });
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) void main();
