/**
 * C10a 在线页面的单舞台 live 预览（`docs/plan/c10a-contract.md` 第 8 节「不开后台舞台：在线页面只有一个同源舞台」、
 * 第 8.1 节「`ONLINE` 时同源单舞台 A 按 live 变体渲……A 就是可见舞台，没有 B」）。
 * 跑：node --experimental-test-module-mocks --test src/editor/c10a-single-stage.test.mjs
 *
 * 假设 K7（`server/test/c10a-kit.mjs`）：仍由 `src/editor/previewMode.ts` 决定开几个舞台、舞台地址带什么——
 *   `dualStage()` 在 `ONLINE` 时恒为 false（就算页面上有舞台端口表）；`stageSrc('A')` 是同源地址，
 *   带 `preview=stage`（「相当于现在双舞台里 `&preview=stage` 的那一份」，舞台据此渲 live 变体）。
 * `src/online/lowMemory.ts`（同一个实现分支的文件）不在时整组 skip。
 */
import { srcUrl } from "../testing/registerTs.mjs";
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { exists, skipIf, LOW_MEMORY_FILE } from "../../server/test/c10a-kit.mjs";

const missing = !exists(LOW_MEMORY_FILE);
const skip = skipIf(missing, `${LOW_MEMORY_FILE}（单舞台随低内存档分支来，K7）`);

globalThis.window = globalThis;
let pm = null;
if (!missing) {
  mock.module(srcUrl("online/mode.ts"), { exports: { ONLINE: true } });
  pm = await import(srcUrl("editor/previewMode.ts"));
}

function page({ ports, search = "" }) {
  const loc = { protocol: "https:", hostname: "8-219-80-16.sslip.io", host: "8-219-80-16.sslip.io", origin: "https://8-219-80-16.sslip.io", pathname: "/editor/", search, hash: "" };
  Object.defineProperty(globalThis, "location", { value: loc, configurable: true, writable: true });
  if (ports) globalThis.__PC_STAGE_PORTS__ = ports;
  else delete globalThis.__PC_STAGE_PORTS__;
  return () => { delete globalThis.location; delete globalThis.__PC_STAGE_PORTS__; };
}

test("C10A-GT-07 在线页面只开一个同源舞台 A，按 live 变体渲（没有后台舞台 B）", { skip }, () => {
  for (const ports of [undefined, [], [5191, 5192]]) {
    const restore = page({ ports });
    try {
      assert.equal(pm.dualStage(), false, `舞台端口表 ${JSON.stringify(ports)}：在线页面不开双舞台`);
      const src = pm.stageSrc("A");
      assert.ok(src.startsWith("/editor/") || src.startsWith("https://8-219-80-16.sslip.io/editor/"), `A 是同源的：${src}`);
      assert.match(src, /[?&]preview=stage(?:&|$)/, `A 按 live 变体渲：${src}`);
      assert.equal(pm.stageTargetOrigin("A"), "https://8-219-80-16.sslip.io");
    } finally {
      restore();
    }
  }
});
