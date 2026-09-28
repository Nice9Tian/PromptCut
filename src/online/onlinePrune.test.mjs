/**
 * 守门:在线构建剪枝的就地常量(M8 遗留 L24,写法见 `src/online/pageFlag.ts` 的「在线构建剪枝」)。
 * 跑:node --test src/online/onlinePrune.test.mjs
 *
 * rolldown 摇树只认本模块里值可知的常量,所以要剪枝的模块各自就地写一行 `ONLINE_BUILD`。这一行抄错了
 * (比如写成读 `mode.ts`、少了 `typeof` 守卫),在线构建就剪不掉、或 Node 单测载入时当场抛错。这里核对:
 *   PRUNE-01 `src/` 下每一处 `const ONLINE_BUILD =` 都与标准写法逐字相同;
 *   PRUNE-02 Node 里(没有 `import.meta.env`)这行求值为 false,不抛错。
 * 剪得掉没有,由 `server/test/c10a-online-build.test.mjs` 的 C10A-API-03(`/api` 棘轮清单与产物逐条一致)核对。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const CANON = 'const ONLINE_BUILD = typeof import.meta.env !== "undefined" && import.meta.env.VITE_PC_ONLINE === "1";';

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  if (e.isDirectory()) return e.name === "node_modules" ? [] : walk(p);
  return /\.(ts|tsx)$/.test(e.name) && !e.name.endsWith(".d.ts") ? [p] : [];
});

test("PRUNE-01 每一处就地的 ONLINE_BUILD 都与标准写法逐字相同", () => {
  const sites = [];
  const bad = [];
  for (const f of walk(path.join(ROOT, "src"))) {
    const lines = fs.readFileSync(f, "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      if (!/^\s*(export\s+)?const ONLINE_BUILD\b/.test(line)) return;
      const where = `${path.relative(ROOT, f).split(path.sep).join("/")}:${i + 1}`;
      sites.push(where);
      if (line.trim() !== CANON) bad.push(`${where}: ${line.trim()}`);
    });
  }
  assert.ok(sites.length >= 10, `就地常量应在十几个模块里,实际 ${sites.length}:${sites.join(", ")}`);
  assert.deepEqual(bad, [], `写法与标准不同:\n${bad.join("\n")}`);
});

test("PRUNE-02 Node 里这行求值为 false,不抛错", () => {
  // 与源码同一个表达式;Node 的 ESM 里 import.meta 在、import.meta.env 不在
  const ONLINE_BUILD = typeof import.meta.env !== "undefined" && import.meta.env.VITE_PC_ONLINE === "1";
  assert.equal(ONLINE_BUILD, false);
});
