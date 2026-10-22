/**
 * 在线浏览器的新版本检查单测（语义 `product/platforms.md` 与 `mechanism/platforms.md`「在线浏览器」的「新版本提示」）。
 * 跑：node --test src/online/updateCheck.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  startUpdateCheck,
  parseVersionJson,
  UPDATE_CHECK_INTERVAL_MS,
  VERSION_FILE,
} from "./updateCheck.ts";

/** 构造假的可见性来源与假计时器 */
function makeHarness({ initialVisibility = "visible" } = {}) {
  const listeners = new Set();
  const visibility = {
    visibilityState: initialVisibility,
    addEventListener(type, fn) {
      assert.equal(type, "visibilitychange");
      listeners.add(fn);
    },
    removeEventListener(type, fn) {
      assert.equal(type, "visibilitychange");
      listeners.delete(fn);
    },
    setVisibility(next) {
      this.visibilityState = next;
      for (const fn of [...listeners]) fn();
    },
    listenerCount() {
      return listeners.size;
    },
  };

  let nextTimerId = 1;
  const intervals = new Map();
  const setIntervalFake = (cb, ms) => {
    const id = nextTimerId++;
    intervals.set(id, { cb, ms });
    return id;
  };
  const clearIntervalFake = (id) => {
    intervals.delete(id);
  };
  const tick = async () => {
    for (const { cb } of [...intervals.values()]) cb();
    await flushMicrotasks();
  };

  return {
    visibility,
    intervals,
    setInterval: setIntervalFake,
    clearInterval: clearIntervalFake,
    tick,
  };
}

async function flushMicrotasks() {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

test("UPD-01 启动时不取；切到前台取、切到后台不取；URL 与 cache: no-store 正确", async () => {
  const h = makeHarness({ initialVisibility: "visible" });
  const calls = [];
  const ctl = startUpdateCheck({
    base: "/editor",
    codeVersion: "v-100",
    visibility: h.visibility,
    setInterval: h.setInterval,
    clearInterval: h.clearInterval,
    fetch: async (url, init) => {
      calls.push([url, init]);
      return { ok: true, text: async () => JSON.stringify({ codeVersion: "v-100" }) };
    },
  });

  // 启动时不发请求，但已挂上 10 分钟定时器与 visibilitychange 监听
  await flushMicrotasks();
  assert.equal(calls.length, 0, "启动时不发请求");
  assert.equal(h.intervals.size, 1);
  assert.equal([...h.intervals.values()][0].ms, UPDATE_CHECK_INTERVAL_MS);
  assert.equal(UPDATE_CHECK_INTERVAL_MS, 10 * 60 * 1000);

  // 切到后台：不取
  h.visibility.setVisibility("hidden");
  await flushMicrotasks();
  assert.equal(calls.length, 0, "切到后台不取");

  // 切回前台：取一次，URL 为 /editor/version.json，cache 为 no-store
  h.visibility.setVisibility("visible");
  await flushMicrotasks();
  assert.deepEqual(calls, [[`/editor/${VERSION_FILE}`, { cache: "no-store" }]]);

  ctl.stop();
});

test("UPD-02 前台每 10 分钟取一次；在后台时计时器到点也不取", async () => {
  const h = makeHarness({ initialVisibility: "visible" });
  let count = 0;
  const ctl = startUpdateCheck({
    base: "/editor/",
    codeVersion: "v-100",
    visibility: h.visibility,
    setInterval: h.setInterval,
    clearInterval: h.clearInterval,
    fetch: async () => {
      count++;
      return { ok: true, text: async () => JSON.stringify({ codeVersion: "v-100" }) };
    },
  });

  // 在前台：每到一次 10 分钟就取一次
  await h.tick();
  assert.equal(count, 1);
  await h.tick();
  assert.equal(count, 2);

  // 切到后台后计时器到点：不取
  h.visibility.setVisibility("hidden");
  await h.tick();
  await h.tick();
  assert.equal(count, 2, "在后台时计时器到点不取");

  // 切回前台当即取一次，之后前台计时器恢复取
  h.visibility.setVisibility("visible");
  await flushMicrotasks();
  assert.equal(count, 3);
  await h.tick();
  assert.equal(count, 4);

  ctl.stop();
});

test("UPD-03 版本相同不提示且状态引用不变；版本不同则提示并通知订阅者", async () => {
  const h = makeHarness({ initialVisibility: "visible" });
  let serverVersion = "v-100";
  const ctl = startUpdateCheck({
    codeVersion: "v-100",
    visibility: h.visibility,
    setInterval: h.setInterval,
    clearInterval: h.clearInterval,
    fetch: async () => ({
      ok: true,
      text: async () => JSON.stringify({ codeVersion: serverVersion }),
    }),
  });

  const initial = ctl.getState();
  assert.deepEqual(initial, { hasUpdate: false, currentVersion: "v-100", latestVersion: null });

  let notified = 0;
  const unsub = ctl.subscribe(() => {
    notified++;
  });

  // 版本相同：不通知订阅者，getState() 返回同一个对象
  await h.tick();
  assert.equal(notified, 0);
  assert.equal(ctl.getState(), initial);

  // 服务端升级到 v-200：状态变为有新版本，通知订阅者
  serverVersion = "v-200";
  await h.tick();
  assert.equal(notified, 1);
  const updated = ctl.getState();
  assert.notEqual(updated, initial);
  assert.deepEqual(updated, { hasUpdate: true, currentVersion: "v-100", latestVersion: "v-200" });

  // 再次取到相同的 v-200：状态未变，返回同一个对象且不重复通知
  await h.tick();
  assert.equal(notified, 1);
  assert.equal(ctl.getState(), updated);

  // 取消订阅后不再收到通知
  unsub();
  serverVersion = "v-300";
  await h.tick();
  assert.equal(notified, 1);
  assert.deepEqual(ctl.getState(), { hasUpdate: true, currentVersion: "v-100", latestVersion: "v-300" });

  ctl.stop();
});

test("UPD-04 codeVersion 为 null（开发构建）时永远不取、不提示", async () => {
  const h = makeHarness({ initialVisibility: "visible" });
  let fetched = 0;
  const ctl = startUpdateCheck({
    codeVersion: null,
    visibility: h.visibility,
    setInterval: h.setInterval,
    clearInterval: h.clearInterval,
    fetch: async () => {
      fetched++;
      return { ok: true, text: async () => JSON.stringify({ codeVersion: "v-999" }) };
    },
  });

  assert.equal(h.intervals.size, 0, "开发构建不起定时器");
  assert.equal(h.visibility.listenerCount(), 0, "开发构建不挂监听");
  h.visibility.setVisibility("hidden");
  h.visibility.setVisibility("visible");
  await h.tick();
  assert.equal(fetched, 0);
  assert.deepEqual(ctl.getState(), { hasUpdate: false, currentVersion: null, latestVersion: null });
  ctl.stop();
});

test("UPD-05 各种失败（抛错、404、HTML 正文、坏 JSON、缺字段、空字符串）既不挂出提示，也不撤掉已有的提示", async () => {
  const h = makeHarness({ initialVisibility: "visible" });
  const responses = [
    () => { throw new Error("network down"); },
    () => ({ ok: false, status: 404, text: async () => "Not Found" }),
    () => ({ ok: false, status: 502, text: async () => JSON.stringify({ codeVersion: "v-200" }) }),
    // nginx 在 version.json 不存在时 try_files 回落到 index.html 并回 200
    () => ({ ok: true, status: 200, text: async () => "<!doctype html><html><head><title>PromptCut</title></head></html>" }),
    () => ({ ok: true, status: 200, text: async () => "{bad json" }),
    () => ({ ok: true, status: 200, text: async () => JSON.stringify({}) }),
    () => ({ ok: true, status: 200, text: async () => JSON.stringify({ codeVersion: "" }) }),
    () => ({ ok: true, status: 200, text: async () => JSON.stringify({ codeVersion: "   " }) }),
    () => ({ ok: true, status: 200, text: async () => JSON.stringify({ codeVersion: 123 }) }),
    () => ({ ok: true, status: 200, text: async () => JSON.stringify(["v-200"]) }),
  ];

  let idx = 0;
  let mode = "failures";
  const ctl = startUpdateCheck({
    codeVersion: "v-100",
    visibility: h.visibility,
    setInterval: h.setInterval,
    clearInterval: h.clearInterval,
    fetch: async () => {
      if (mode === "upgrade") {
        return { ok: true, status: 200, text: async () => JSON.stringify({ codeVersion: "v-200" }) };
      }
      const fn = responses[idx++ % responses.length];
      return fn();
    },
  });

  const before = ctl.getState();
  let notified = 0;
  ctl.subscribe(() => { notified++; });

  // 1) 未提示状态下连续经历全部失败：始终不挂出提示，状态引用不变
  for (let i = 0; i < responses.length; i++) {
    await h.tick();
    assert.equal(ctl.getState(), before, `第 ${i} 种失败不该改变状态`);
  }
  assert.equal(notified, 0);

  // 2) 成功检测到新版本 v-200，挂出提示
  mode = "upgrade";
  await h.tick();
  const active = ctl.getState();
  assert.equal(active.hasUpdate, true);
  assert.equal(active.latestVersion, "v-200");
  assert.equal(notified, 1);

  // 3) 已挂出提示后再次经历全部失败：已挂出的提示不被撤掉，状态引用保持不变
  mode = "failures";
  idx = 0;
  for (let i = 0; i < responses.length; i++) {
    await h.tick();
    assert.equal(ctl.getState(), active, `第 ${i} 种失败不该撤掉已有提示`);
  }
  assert.equal(notified, 1);

  // 直接校验 parseVersionJson
  assert.equal(parseVersionJson('{"codeVersion":"abc"}'), "abc");
  assert.equal(parseVersionJson("<!doctype html>"), null);
  assert.equal(parseVersionJson("{}"), null);
  assert.equal(parseVersionJson('{"codeVersion":""}'), null);

  ctl.stop();
});

test("UPD-06 同一时刻只发一个请求（请求未完成时再次触发不并发）", async () => {
  const h = makeHarness({ initialVisibility: "visible" });
  let inFlightCalls = 0;
  let totalCalls = 0;
  let resolveFetch;

  const ctl = startUpdateCheck({
    codeVersion: "v-100",
    visibility: h.visibility,
    setInterval: h.setInterval,
    clearInterval: h.clearInterval,
    fetch: () => {
      totalCalls++;
      inFlightCalls++;
      return new Promise((resolve) => {
        resolveFetch = () => {
          inFlightCalls--;
          resolve({ ok: true, text: async () => JSON.stringify({ codeVersion: "v-200" }) });
        };
      });
    },
  });

  // 触发第一次请求（挂起中）
  await h.tick();
  assert.equal(totalCalls, 1);
  assert.equal(inFlightCalls, 1);

  // 第一个请求未完成时，连续触发计时器与切回前台，都不应发出第二个请求
  await h.tick();
  h.visibility.setVisibility("hidden");
  h.visibility.setVisibility("visible");
  await flushMicrotasks();
  assert.equal(totalCalls, 1, "同一时刻只有一个请求在飞");

  // 第一个请求完成后，状态更新，后续触发可再次发请求
  resolveFetch();
  await flushMicrotasks();
  assert.equal(ctl.getState().hasUpdate, true);

  await h.tick();
  assert.equal(totalCalls, 2);
  resolveFetch();
  await flushMicrotasks();

  ctl.stop();
});

test("UPD-07 stop() 之后撤掉监听与计时器，不再发请求、不再更新状态", async () => {
  const h = makeHarness({ initialVisibility: "visible" });
  let calls = 0;
  let pendingResolve = null;

  const ctl = startUpdateCheck({
    codeVersion: "v-100",
    visibility: h.visibility,
    setInterval: h.setInterval,
    clearInterval: h.clearInterval,
    fetch: () => {
      calls++;
      return new Promise((resolve) => {
        pendingResolve = () => resolve({ ok: true, text: async () => JSON.stringify({ codeVersion: "v-200" }) });
      });
    },
  });

  // 先发起一个在途请求，然后在它返回前调 stop()
  await h.tick();
  assert.equal(calls, 1);

  ctl.stop();
  assert.equal(h.intervals.size, 0, "stop() 清掉了计时器");
  assert.equal(h.visibility.listenerCount(), 0, "stop() 撤掉了 visibilitychange 监听");

  // 在途请求在 stop() 之后返回，也不应更新状态
  pendingResolve();
  await flushMicrotasks();
  assert.equal(ctl.getState().hasUpdate, false);

  // stop() 之后切回前台或计时器触发，都不再发请求
  h.visibility.setVisibility("hidden");
  h.visibility.setVisibility("visible");
  await h.tick();
  assert.equal(calls, 1);
});
