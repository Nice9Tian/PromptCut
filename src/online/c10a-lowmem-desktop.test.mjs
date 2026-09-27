/**
 * C10a 低内存档判定：桌面运行环境恒为普通档（`docs/plan/c10a-contract.md` 第 8 节「只在在线模式里判；桌面运行环境恒为普通档」）。
 * 跑：node --experimental-test-module-mocks --test src/online/c10a-lowmem-desktop.test.mjs
 *
 * `src/online/mode.ts` 换成 `{ ONLINE: false }`（桌面版、本机 dev server）。在线构建下的判定见 `c10a-lowmem.test.mjs`。
 */
import { srcUrl } from "../testing/registerTs.mjs";
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import {
  exists, skipIf, LOW_MEMORY_FILE, lowMemoryEnv, pickDecider, decideWith, installBrowserGlobals, hostCapabilitiesOf,
} from "../../server/test/c10a-kit.mjs";

const missing = !exists(LOW_MEMORY_FILE);
const skip = skipIf(missing, LOW_MEMORY_FILE);

let decider = null;
let stageRpc = null;
let mod = null;
if (!missing) {
  mock.module(srcUrl("online/mode.ts"), { exports: { ONLINE: false } });
  mod = await import(srcUrl("online/lowMemory.ts"));
  decider = pickDecider(mod);
  stageRpc = await import(srcUrl("render/stageRpc.ts"));
}

const SAFARI_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const weakPhone = { deviceMemory: 2, maxTouchPoints: 5, width: 390, height: 844, coarse: true };

test("C10A-LM-09 桌面运行环境（ONLINE = false）：判定恒为普通档，舞台的 hostCapabilities.lowMemory 恒为 false", { skip }, async () => {
  assert.equal(await decideWith(decider, lowMemoryEnv(weakPhone)), false, "2 GB、触屏小屏");
  assert.equal(await decideWith(decider, lowMemoryEnv({ deviceMemory: 1, maxTouchPoints: 0, width: 1366, height: 768, coarse: false })), false, "1 GB 桌面");
  for (const o of [weakPhone, { deviceMemory: undefined, maxTouchPoints: 0, width: 2560, height: 1600, coarse: false, userAgent: SAFARI_MAC }]) {
    const restore = installBrowserGlobals(lowMemoryEnv(o));
    const had = Object.getOwnPropertyDescriptor(globalThis, "location");
    Object.defineProperty(globalThis, "location", { value: { search: "?stage=1&id=A", origin: "http://x" }, configurable: true, writable: true });
    try {
      // 集成对账（K2）：online 由舞台页传入
      assert.equal((await hostCapabilitiesOf(stageRpc, mod)).lowMemory, false, JSON.stringify(o));
    } finally {
      if (had) Object.defineProperty(globalThis, "location", had);
      else delete globalThis.location;
      restore();
    }
  }
});
