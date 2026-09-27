/**
 * C10a 低内存档判定的契约测试（`docs/plan/c10a-contract.md` 第 8 节「判定」，第 12 节「低内存档判定」）。
 * 跑：node --experimental-test-module-mocks --test src/online/c10a-lowmem.test.mjs
 *
 *   lowMemory = override ?? (deviceMemory <= 4 || (coarsePointer && maxTouchPoints >= 2 && max(screen.width, screen.height) <= 1600))
 *   coarsePointer = (pointer: coarse) || (any-pointer: coarse)；不看 UA。只在在线模式里判。
 *
 * 本文件把 `src/online/mode.ts` 换成 `{ ONLINE: true }`（在线构建）；桌面运行环境恒为普通档见
 * `c10a-lowmem-desktop.test.mjs`（`ONLINE: false`，另一个进程，免得两份桩互相串）。
 * 判定函数的名字与调用约定见 `server/test/c10a-kit.mjs` 的 K2；`src/online/lowMemory.ts` 不在时整组 skip。
 */
import { srcUrl } from "../testing/registerTs.mjs";
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import {
  exists, skipIf, LOW_MEMORY_FILE, lowMemoryEnv, pickDecider, decideWith, installBrowserGlobals,
} from "../../server/test/c10a-kit.mjs";

const missing = !exists(LOW_MEMORY_FILE);
const skip = skipIf(missing, LOW_MEMORY_FILE);
const it = (name, fn) => test(name, { skip }, fn);

let decide = null;
let stageRpc = null;
if (!missing) {
  mock.module(srcUrl("online/mode.ts"), { exports: { ONLINE: true } });
  const mod = await import(srcUrl("online/lowMemory.ts"));
  const decider = pickDecider(mod);
  decide = (o) => decideWith(decider, lowMemoryEnv(o));
  stageRpc = await import(srcUrl("render/stageRpc.ts"));
}

const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
/** iPadOS 的 Safari 缺省报桌面 UA（契约第 8 节「iPad 常报桌面 UA」） */
const IPAD_DESKTOP_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36";

const desktop = { maxTouchPoints: 0, width: 1920, height: 1080, coarse: false };
const phone = { maxTouchPoints: 5, width: 390, height: 844, coarse: true };

it("C10A-LM-01 deviceMemory ≤ 4 → 低内存档；> 4 → 普通档（桌面形态、没有触屏）", async () => {
  for (const mem of [0.25, 0.5, 1, 2, 4]) assert.equal(await decide({ ...desktop, deviceMemory: mem }), true, `deviceMemory ${mem}`);
  for (const mem of [8, 16, 32]) assert.equal(await decide({ ...desktop, deviceMemory: mem }), false, `deviceMemory ${mem}`);
});

it("C10A-LM-02 没有 deviceMemory（iOS、Firefox）：粗指针 + 至少 2 个触点 + 长边 ≤ 1600 → 低内存档", async () => {
  assert.equal(await decide({ ...phone, userAgent: IPHONE_UA }), true, "iPhone");
  assert.equal(await decide({ maxTouchPoints: 5, width: 1024, height: 1366, coarse: true, userAgent: IPAD_DESKTOP_UA }), true, "iPad Pro 12.9（报桌面 UA）");
  assert.equal(await decide({ maxTouchPoints: 5, width: 820, height: 1180, coarse: true, userAgent: IPAD_DESKTOP_UA }), true, "iPad Air 横竖都一样");
  assert.equal(await decide({ ...desktop }), false, "桌面 Firefox：没有 deviceMemory、细指针");
});

it("C10A-LM-03 屏幕长边的边界：1600 算小屏，1601 不算；横竖屏取较大的一边", async () => {
  const touch = { maxTouchPoints: 10, coarse: true, deviceMemory: 8 };
  assert.equal(await decide({ ...touch, width: 1600, height: 1000 }), true, "1600×1000");
  assert.equal(await decide({ ...touch, width: 1000, height: 1600 }), true, "1000×1600（竖屏）");
  assert.equal(await decide({ ...touch, width: 1601, height: 1000 }), false, "1601×1000");
  assert.equal(await decide({ ...touch, width: 900, height: 1601 }), false, "900×1601（竖屏长边超了）");
  assert.equal(await decide({ ...touch, width: 2560, height: 1440 }), false, "大触屏一体机（8 GB）");
});

it("C10A-LM-04 触点数：少于 2 个不算触屏设备", async () => {
  const small = { width: 800, height: 1280, coarse: true, deviceMemory: 8 };
  assert.equal(await decide({ ...small, maxTouchPoints: 0 }), false);
  assert.equal(await decide({ ...small, maxTouchPoints: 1 }), false);
  assert.equal(await decide({ ...small, maxTouchPoints: 2 }), true);
});

it("C10A-LM-05 粗指针取 (pointer: coarse) 或 (any-pointer: coarse)；两者都不匹配就不算", async () => {
  const small = { maxTouchPoints: 5, width: 1280, height: 800, deviceMemory: 8 };
  assert.equal(await decide({ ...small, coarse: true, anyCoarse: true }), true, "主指针是粗的");
  assert.equal(await decide({ ...small, coarse: false, anyCoarse: true }), true, "只有 any-pointer 是粗的（触屏笔记本接了鼠标）");
  assert.equal(await decide({ ...small, coarse: false, anyCoarse: false }), false, "都是细指针：触点数与屏幕尺寸不作数");
});

it("C10A-LM-06 不看 UA：同一组硬件桩换不同 UA，结论相同；桌面 Safari 不再因为是 Safari 就判低内存档", async () => {
  const hw = { maxTouchPoints: 5, width: 1024, height: 1366, coarse: true };
  const verdicts = [];
  for (const ua of [IPHONE_UA, IPAD_DESKTOP_UA, ANDROID_UA, undefined]) verdicts.push(await decide({ ...hw, userAgent: ua }));
  assert.deepEqual(verdicts, [true, true, true, true]);
  // Mac 上的 Safari：没有 deviceMemory、没有触屏、细指针 → 普通档（stageRpc 旧判据「或 Safari」要换掉）
  assert.equal(await decide({ ...desktop, width: 2560, height: 1600, userAgent: IPAD_DESKTOP_UA }), false);
  assert.equal(await decide({ ...phone, deviceMemory: 8, userAgent: IPAD_DESKTOP_UA.replace("Macintosh", "Windows NT 10.0") }), true, "UA 像桌面，硬件是手机");
});

it("C10A-LM-07 设备设置「显示档」覆盖自动判定：低内存 / 普通两个方向都生效", async () => {
  assert.equal(await decide({ ...desktop, deviceMemory: 32, override: "low" }), true, "强壮的桌面强制低内存档");
  assert.equal(await decide({ ...phone, deviceMemory: 2, override: "normal" }), false, "2 GB 手机强制普通档");
  assert.equal(await decide({ ...phone, deviceMemory: 2, override: undefined }), true, "自动");
  assert.equal(await decide({ ...desktop, deviceMemory: 16, override: undefined }), false, "自动");
});

it("C10A-LM-08 舞台的 hostCapabilities.lowMemory 用同一条判据（在线构建）", async () => {
  const cases = [
    [{ ...phone, userAgent: IPHONE_UA }, true],
    [{ ...desktop, deviceMemory: 2 }, true],
    [{ ...desktop, deviceMemory: 16 }, false],
    [{ ...desktop, width: 2560, height: 1600, userAgent: IPAD_DESKTOP_UA }, false], // Mac Safari：旧判据会给 true
  ];
  for (const [o, want] of cases) {
    const env = lowMemoryEnv(o);
    const restore = installBrowserGlobals(env);
    const hadLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
    Object.defineProperty(globalThis, "location", { value: { search: "?stage=1&id=A", origin: "http://x" }, configurable: true, writable: true });
    try {
      const caps = stageRpc.detectHostCapabilities();
      assert.equal(caps.lowMemory, want, JSON.stringify(o));
    } finally {
      if (hadLocation) Object.defineProperty(globalThis, "location", hadLocation);
      else delete globalThis.location;
      restore();
    }
  }
});
