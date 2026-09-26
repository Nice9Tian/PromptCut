/*
 * 依赖方向的守门测试。
 *
 * 渲染引擎从 `scripts/export-frames.mjs` 搬进 `server/bakery/` 之前,`server/` 与 `scripts/`
 * 互相 import(`server/frame-pipeline.mjs` → `scripts/export-frames.mjs` → `server/export-compose.mjs`),
 * 而且 `export-frames.mjs` ↔ `export-unified.mjs` 之间还有一个运行时环。两条都修好了,这里把它钉住:
 *
 *   1. `server/**` 不再 import `scripts/**`(`scripts/` → `server/` 单向允许);
 *   2. `server/bakery/**` 内部的 import 图无环。
 *
 * 跑法:`node --test server/test/bakery-deps.test.mjs`
 */
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const SERVER = path.join(ROOT, 'server');
const BAKERY = path.join(SERVER, 'bakery');

/**
 * 例外只有测 scripts/ 自己的测试,不是生产代码对 scripts/ 的依赖:
 *
 *   - `bake-protocol.test.mjs` 测 `scripts/verify-bake-protocol.mjs` 这个命令行校验脚本;
 *   - `dev-server-junction.test.mjs` 测 `scripts/lib/dev-server.mjs` 的 media junction 只拆链接
 *     (拆错了删的是用户素材,所以要常驻基线);
 *   - `probe-coord-mail.test.mjs` 测 `scripts/probes/probe-coord.mjs` 里两个 Agent 之间的 HTTP 信箱(鉴权与长轮询)。
 *
 * 多一条都要在这里显式写出来,加不进来就说明依赖方向真的破了。
 */
const ALLOWED_SCRIPT_IMPORTERS = new Set(['server/test/bake-protocol.test.mjs', 'server/test/dev-server-junction.test.mjs', 'server/test/probe-coord-mail.test.mjs']);

const CODE = /\.(mjs|mts|ts|tsx)$/;

function walk(dir, out = []) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, item.name);
    if (item.isDirectory()) walk(file, out);
    else if (CODE.test(item.name)) out.push(file);
  }
  return out;
}

const rel = (file) => path.relative(ROOT, file).replaceAll('\\', '/');

/** 一个文件里所有的模块说明符:静态 import / export ... from,以及 import("…") */
function specifiersOf(file) {
  const text = fs.readFileSync(file, 'utf8');
  const found = [];
  for (const m of text.matchAll(/(?:^|[\s;}])(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]/gs)) found.push(m[1]);
  for (const m of text.matchAll(/(?:^|[^\w$.])import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) found.push(m[1]);
  for (const m of text.matchAll(/(?:^|[\s;}])import\s*['"]([^'"]+)['"]/g)) found.push(m[1]);
  return found;
}

test('server/** 不 import scripts/ 下的模块', () => {
  const offenders = [];
  for (const file of walk(SERVER)) {
    const name = rel(file);
    if (ALLOWED_SCRIPT_IMPORTERS.has(name)) continue;
    for (const spec of specifiersOf(file)) {
      if (!spec.startsWith('.')) continue;
      const target = rel(path.resolve(path.dirname(file), spec));
      if (target.startsWith('scripts/')) offenders.push(`${name} → ${spec}`);
    }
  }
  assert.deepEqual(offenders, [], '依赖方向只能是 scripts/ → server/,不能反过来');
});

test('名单里允许 import scripts/ 的 server 文件确实还在', () => {
  for (const name of ALLOWED_SCRIPT_IMPORTERS) {
    assert.ok(fs.existsSync(path.join(ROOT, name)), `${name} 不在了,请把它从名单里删掉`);
  }
});

test('server/bakery/** 内部的 import 图无环', () => {
  /** 文件 → 它 import 的同目录(或子目录)模块 */
  const graph = new Map();
  for (const file of walk(BAKERY)) {
    const edges = [];
    for (const spec of specifiersOf(file)) {
      if (!spec.startsWith('.')) continue;
      const target = path.resolve(path.dirname(file), spec);
      if (target.startsWith(BAKERY)) edges.push(rel(target));
    }
    graph.set(rel(file), edges);
  }
  assert.ok(graph.size > 0, 'server/bakery 里应当有模块');

  const state = new Map(); // 未访问 / 1 在栈上 / 2 已完成
  const cycles = [];
  const visit = (node, stack) => {
    if (state.get(node) === 2) return;
    if (state.get(node) === 1) {
      cycles.push([...stack.slice(stack.indexOf(node)), node].join(' → '));
      return;
    }
    state.set(node, 1);
    stack.push(node);
    for (const next of graph.get(node) || []) visit(next, stack);
    stack.pop();
    state.set(node, 2);
  };
  for (const node of graph.keys()) visit(node, []);
  assert.deepEqual(cycles, [], 'server/bakery 内部不允许有运行时 import 环');
});
