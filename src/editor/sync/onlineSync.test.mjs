/**
 * 在线页面的离线提示与本地备份(C10 契约第 10 节、第 17 节表 A、第 18 节第 4 条)的纯逻辑单测。跑:
 *   node --test src/editor/sync/onlineSync.test.mjs
 *
 * - `onlineStatus.ts`:表 A 五条措辞一字不差;状态 → 措辞;常驻提示的条件;恢复阶段的状态机;
 * - `onlineBackups.ts`:只进内存(不碰任何浏览器存储)、不自动下载、逐个下载出 JSON。
 */
import { srcUrl } from "../../testing/registerTs.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const st = await import(srcUrl("editor/sync/onlineStatus.ts"));
const bk = await import(srcUrl("editor/sync/onlineBackups.ts"));

test("表 A 五条状态措辞与常驻提示一字不差", () => {
  assert.deepEqual({ ...st.ONLINE_STATUS_TEXT }, {
    noNetwork: "当前没有网络连接。",
    docDown: "连不上服务器，请稍后再试。你的修改先留在本页，恢复后会自动提交。",
    assetDown: "连不上素材服务，素材原尺寸和预渲染结果暂时显示不了。",
    recovering: "已恢复连接，正在提交离线时的修改…",
    recovered: "离线时的修改已全部提交。",
  });
  assert.equal(st.OFFLINE_UNSENT_TEXT, "当前离线，有未提交的修改。关闭页面将丢失这些操作。");
});

test("状态 → 措辞:断网、连不上文档服务、连不上素材服务、恢复中、恢复完成;暂停交给「同步已暂停」", () => {
  const base = { status: "online", navigatorOnline: true, assetDown: false, recovery: null };
  const of = (p) => st.onlineStatusOf({ ...base, ...p });
  assert.equal(of({}), null);
  assert.equal(of({ status: "offline", navigatorOnline: false }), "noNetwork");
  assert.equal(of({ status: "offline" }), "docDown");
  assert.equal(of({ assetDown: true }), "assetDown");
  assert.equal(of({ assetDown: true, navigatorOnline: false }), "noNetwork");
  assert.equal(of({ recovery: "recovering" }), "recovering");
  assert.equal(of({ recovery: "recovered" }), "recovered");
  assert.equal(of({ status: "paused" }), null);
  assert.equal(of({ status: "connecting", recovery: "recovering" }), "recovering");
});

test("常驻提示:离线(含暂停)且有未提交的修改才挂", () => {
  assert.equal(st.offlineUnsent("offline", 2), true);
  assert.equal(st.offlineUnsent("paused", 1), false, "暂停时已连上,不说「当前离线」");
  assert.equal(st.unsentAtRisk("paused", 1), true, "暂停时关页面照样丢,挂离开确认");
  assert.equal(st.unsentAtRisk("offline", 1), true);
  assert.equal(st.unsentAtRisk("online", 1), false);
  assert.equal(st.offlineUnsent("offline", 0), false);
  assert.equal(st.offlineUnsent("online", 3), false, "在线时未确认的提交正在飞,不算离线");
});

test("恢复阶段:离线攒过修改 → 回来还有没确认的 = 恢复中 → 确认完 = 恢复完成;离线没改过就不进", () => {
  let s = { phase: null, wasOffline: false, hadUnsent: false };
  s = st.nextRecovery(s, "online", 0);
  assert.equal(s.phase, null);
  s = st.nextRecovery(s, "offline", 0);
  s = st.nextRecovery(s, "offline", 2);
  assert.equal(s.phase, null);
  s = st.nextRecovery(s, "connecting", 2);
  assert.equal(s.phase, "recovering");
  s = st.nextRecovery(s, "online", 1);
  assert.equal(s.phase, "recovering");
  s = st.nextRecovery(s, "online", 0);
  assert.equal(s.phase, "recovered");
  // 离线期间什么都没改:回来不提示
  let q = { phase: null, wasOffline: false, hadUnsent: false };
  q = st.nextRecovery(q, "offline", 0);
  q = st.nextRecovery(q, "online", 0);
  assert.equal(q.phase, null);
  // 回来后第一条被拒 → 暂停 → 丢弃:不说「已全部提交」
  let d = { phase: null, wasOffline: false, hadUnsent: false };
  d = st.nextRecovery(d, "offline", 2);
  d = st.nextRecovery(d, "connecting", 2);
  assert.equal(d.phase, "recovering");
  d = st.nextRecovery(d, "paused", 2);
  assert.equal(d.phase, null);
  d = st.nextRecovery(d, "online", 0);
  assert.equal(d.phase, null, "丢弃之后不报恢复完成");
  // 刚回来就已经全确认了:直接恢复完成
  let r = { phase: null, wasOffline: false, hadUnsent: false };
  r = st.nextRecovery(r, "offline", 1);
  r = st.nextRecovery(r, "online", 0);
  assert.equal(r.phase, "recovered");
});

const overwritten = { kind: "overwritten", projectId: "p", entity: "/tracks/@t/clips/@c", by: { actor: { username: "bob" } }, rev: 7, value: { id: "c" }, at: Date.UTC(2026, 8, 27, 1, 2, 3) };
const discard = { kind: "offline-discard", projectId: "p", baseRev: 3, batch: [{ opId: "o1", ops: [] }, { opId: "o2", ops: [] }], project: { name: "x" }, at: Date.UTC(2026, 8, 27, 4, 5, 6) };

test("备份:只进内存、不自动下载,列表里逐个下载出 JSON(LocalBackup 原样)", () => {
  // 任何浏览器存储被碰到就炸
  const trap = new Proxy({}, { get() { throw new Error("不许碰浏览器存储"); } });
  const saved = { localStorage: globalThis.localStorage, sessionStorage: globalThis.sessionStorage, indexedDB: globalThis.indexedDB };
  Object.defineProperty(globalThis, "localStorage", { value: trap, configurable: true });
  Object.defineProperty(globalThis, "sessionStorage", { value: trap, configurable: true });
  Object.defineProperty(globalThis, "indexedDB", { value: trap, configurable: true });
  try {
    const downloads = [];
    const store = bk.createOnlineBackups({ download: (name, text) => downloads.push({ name, text }), projectName: () => "我的/项目" });
    let changes = 0;
    const off = store.subscribe(() => changes++);
    assert.equal(store.save(overwritten), 0);
    assert.equal(store.save(discard), 1);
    assert.equal(downloads.length, 0, "不自动下载");
    assert.equal(changes, 2);
    assert.equal(store.list().length, 2);
    assert.equal(store.download(1), true);
    assert.equal(downloads.length, 1);
    assert.match(downloads[0].name, /^我的_项目-备份-离线丢弃-\d{8}-\d{6}-2\.json$/);
    const body = JSON.parse(downloads[0].text);
    assert.deepEqual(body.backup, discard);
    assert.equal(body.projectName, "我的/项目");
    assert.equal(store.download(0), true);
    assert.match(downloads[1].name, /-被覆盖-/);
    assert.deepEqual(JSON.parse(downloads[1].text).backup, overwritten);
    assert.equal(store.download(5), false, "没有这一份");
    off();
    store.save(overwritten);
    assert.equal(changes, 2, "退订之后不再回调");
  } finally {
    for (const [k, v] of Object.entries(saved)) Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
});

test("备份:缺省的下载走 Blob + <a download> + click(浏览器里),不写存储", () => {
  const clicks = [];
  const saved = { document: globalThis.document, URL: globalThis.URL };
  const a = { style: {}, click() { clicks.push({ href: this.href, download: this.download }); }, remove() {} };
  globalThis.document = { createElement: (tag) => { assert.equal(tag, "a"); return a; }, body: { appendChild() {} } };
  const created = [];
  globalThis.URL = class extends saved.URL {};
  globalThis.URL.createObjectURL = (blob) => { created.push(blob); return "blob:x"; };
  globalThis.URL.revokeObjectURL = () => {};
  try {
    const store = bk.createOnlineBackups();
    store.save(overwritten);
    assert.equal(clicks.length, 0);
    store.download(0);
    assert.equal(clicks.length, 1);
    assert.equal(clicks[0].href, "blob:x");
    assert.match(clicks[0].download, /\.json$/);
    assert.equal(created[0].type, "application/json;charset=utf-8");
  } finally {
    globalThis.document = saved.document;
    globalThis.URL = saved.URL;
  }
});
