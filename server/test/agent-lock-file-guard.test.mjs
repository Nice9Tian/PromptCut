/**
 * 守门：Agent 数据目录独占锁的那份锁文件，只许 `server/agent-service/conversation-control-client.mjs` 里拿锁的那一条 SQLite 连接碰。
 *
 * 为什么要钉死（〔裁〕H07，2026-10-22 主会话在生产节点实测）：Linux 上 POSIX fcntl 锁按「进程 + 文件」算，同一个进程里任何一个
 * 指向锁文件的文件描述符被关掉，这个进程的锁就整个没了——进程还活着、还在读，锁却放开了。后继随后就能合法拿到锁，
 * 交出「前一个已经不在了」的证据，文档服务据此把还活着的实例的读取记成已收口，退出确认就会假报「已退出」。
 * 实测：持锁进程自己用普通文件接口 open+close 一次锁文件，Windows 上锁还在，Linux（节点，内核 5.15）上锁丢了。
 * 这种依赖是悄悄长出来的（顺手加一行读文件、拷文件、算大小、做备份），不报错、平时也看不出来，只有这里拦得住。
 *
 * 拦什么：
 * 1. 锁文件名后缀（`.agent-instance-lock`）、常量名 `AGENT_DATA_DIR_LOCK_SUFFIX`、函数名 `acquireDataDirLock`，
 *    除了那个文件本身，不许出现在任何产品代码里（server、src、scripts、desktop、tools 下的非测试文件）。测试文件可以用
 *    （测试进程不是主服务进程）。
 * 2. 那个文件里：后缀字面量只出现一次（定义处）；拿锁的函数里只用 `fs.mkdirSync`、`fs.statSync` 两个文件接口
 *    （都不打开锁文件）；`lockFile` 只在参数缺省值和交给 `acquireDataDirLock` 这两处出现。
 * 静态扫描只认得出字面引用：按计算出来的路径去碰数据目录里所有文件的代码（例如把整个数据目录打包），这里拦不住，
 * 写这种代码之前先看 conversation-control-client.mjs 拿锁那一段的注释。
 *
 * 这条测试不能删、不能放宽。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('.');
const OWNER = 'server/agent-service/conversation-control-client.mjs';
const SUFFIX = '.agent-instance-lock';
const TOKENS = [SUFFIX, 'AGENT_DATA_DIR_LOCK_SUFFIX', 'acquireDataDirLock'];
const DIRS = ['server', 'src', 'scripts', 'desktop', 'tools'];
// `runtime`、`target` 是 Tauri 的构建产物（desktop/src-tauri/.gitignore 第 1、2 行），里面是整份 app 源码的副本。
// 不跳过的话，谁跑过一次发版构建、再跑全量就会被那份副本判成「第二处引用」而误红（2026-10-23 踩到）。
// 仓库里没有被 git 跟踪的同名目录，跳过它们不会漏掉真的产品代码。
const SKIP_DIRS = new Set(['node_modules', 'dist', 'out', '.worktrees', '.git', 'release', 'build', 'runtime', 'target']);
const CODE = /\.(mjs|cjs|js|jsx|ts|tsx|mts|cts|sh|ps1|py|json|service)$/;
const isTest = rel => /(^|\/)test\//.test(rel) || /\.test\.[a-z]+$/.test(rel) || /(^|\/)fixtures\//.test(rel);

function* walk(dir) {
  let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (CODE.test(entry.name)) yield full;
  }
}
/** 一份产品代码里是否引用了锁文件（回命中的词） */
export function lockReferences(rel, text) {
  if (rel === OWNER || isTest(rel)) return [];
  return TOKENS.filter(token => text.includes(token));
}

test('守门：别的产品代码不许引用 Agent 数据目录锁文件', () => {
  const hits = [];
  for (const dir of DIRS) for (const file of walk(path.join(ROOT, dir))) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    const found = lockReferences(rel, fs.readFileSync(file, 'utf8'));
    if (found.length) hits.push(`${rel}: ${found.join(', ')}`);
  }
  assert.deepEqual(hits, [], `这些文件引用了 Agent 数据目录的锁文件（Linux 上会让锁在进程活着时丢掉，见本文件头）：\n${hits.join('\n')}`);
});

test('守门：拿锁的那个文件里只有那一条 SQLite 连接碰锁文件', () => {
  const text = fs.readFileSync(path.join(ROOT, OWNER), 'utf8');
  assert.equal(text.split(`'${SUFFIX}'`).length - 1, 1, '后缀字面量只在定义处出现一次');
  const start = text.indexOf('export function acquireDataDirLock(');
  assert.ok(start >= 0);
  const body = text.slice(start, text.indexOf('\n}\n', start) >= 0 ? text.indexOf('\n}\n', start) : text.indexOf('\r\n}\r\n', start));
  assert.ok(body.length > 200, '取到了拿锁函数的函数体');
  const calls = [...new Set([...body.matchAll(/\bfs\.(\w+)/g)].map(m => m[1]))].sort();
  assert.deepEqual(calls, ['mkdirSync', 'statSync'], `拿锁那一段只许用 mkdirSync、statSync：实际 ${calls.join(', ')}`);
  const lockFileLines = text.split(/\r?\n/).filter(line => /\blockFile\b/.test(line));
  assert.equal(lockFileLines.length, 2, `lockFile 只许出现在参数缺省值与 acquireDataDirLock(lockFile)：\n${lockFileLines.join('\n')}`);
  assert.ok(lockFileLines.some(line => line.includes('lockFile = receiptFile ? `${receiptFile}${AGENT_DATA_DIR_LOCK_SUFFIX}`')));
  assert.ok(lockFileLines.some(line => /acquireDataDirLock\(lockFile\)/.test(line)));
});

test('守门本身认得出违规（别让扫描悄悄失效）', () => {
  assert.deepEqual(lockReferences('server/agent-service/backup.mjs', "fs.copyFileSync(dir + '/x.sqlite.agent-instance-lock', to)"), [SUFFIX]);
  assert.deepEqual(lockReferences('server/agent-service/diag.mjs', "import { AGENT_DATA_DIR_LOCK_SUFFIX } from './conversation-control-client.mjs'"), ['AGENT_DATA_DIR_LOCK_SUFFIX']);
  assert.deepEqual(lockReferences('server/agent-service/main.mjs', 'acquireDataDirLock(file)'), ['acquireDataDirLock']);
  assert.deepEqual(lockReferences(OWNER, SUFFIX), []);
  assert.deepEqual(lockReferences('server/test/agent-data-dir-lock.test.mjs', 'acquireDataDirLock'), []);
});
