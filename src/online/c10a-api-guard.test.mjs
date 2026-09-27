/**
 * C10a `/api` 守卫（`docs/plan/c10a-contract.md` 第 2 节「开发期加一个守卫：`ONLINE` 下 `fetch` 的地址以 `/api/` 开头时抛错」）。
 * 跑：node --experimental-test-module-mocks --test src/online/c10a-api-guard.test.mjs
 *
 * 守卫的位置与调用约定见 `server/test/c10a-kit.mjs` 的 K6：`src/online/` 下导出名含 guard 的函数，调用即装上。
 * `src/online/mode.ts` 换成 `{ ONLINE: true }`；`ONLINE: false` 时不拦见 `c10a-api-guard-desktop.test.mjs`。
 * 找不到守卫时整组 skip。
 */
import { srcUrl } from "../testing/registerTs.mjs";
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { exists, skipIf, findApiGuard, repoUrl } from "../../server/test/c10a-kit.mjs";

let guard = null;
if (exists("src/online/mode.ts")) {
  mock.module(srcUrl("online/mode.ts"), { exports: { ONLINE: true } });
  guard = await findApiGuard((rel) => import(repoUrl(rel)));
}
const skip = skipIf(!guard, "src/online/ 下的 /api 守卫（K6）");

/** 装守卫前先换上记账的 fetch：放行的请求落到这里 */
function install() {
  const passed = [];
  const real = globalThis.fetch;
  globalThis.window ??= globalThis;
  globalThis.fetch = async (input) => { passed.push(typeof input === "string" ? input : input?.url ?? String(input)); return new Response("{}"); };
  guard.fn();
  return { passed, restore: () => { globalThis.fetch = real; } };
}

/** 同步抛或 reject 都算拦下 */
async function blocked(url, init) {
  try {
    await globalThis.fetch(url, init);
    return false;
  } catch {
    return true;
  }
}

test("C10A-API-05 在线模式：fetch('/api/…') 抛错、不发出；别的地址照常放行", { skip }, async () => {
  const { passed, restore } = install();
  try {
    for (const url of ["/api/docservice/device", "/api/asset/media/x/chunks", "/api/export", "/api/"]) {
      assert.equal(await blocked(url), true, `${url} 应被拦下`);
      assert.equal(await blocked(url, { method: "POST", body: "{}" }), true, `POST ${url} 应被拦下`);
    }
    assert.deepEqual(passed, [], `被拦的请求不许落到真正的 fetch：${JSON.stringify(passed)}`);
    for (const url of ["/hosted/shared/invite/resolve", "https://8-219-80-16.sslip.io/media/api/asset/media/x", "/editor/assets/a.js", "/apix/y"]) {
      assert.equal(await blocked(url), false, `${url} 不该拦`);
    }
    assert.equal(passed.length, 4);
  } finally {
    restore();
  }
});
