/**
 * AI 栏 Agent 标签的关闭与编号(2026-10-20 用户定,见 docs/semantics/workflow/editing.md)。跑:node --test src/ai/agentTabsClose.test.mjs
 * 用例 AT-C1～AT-C5:主页「Agent 1」可关、最后一个不能关、关当前页后的激活、新建取最小空号、刷新后从持久化恢复。
 */
import test from "node:test";
import assert from "node:assert/strict";

const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };

let n = 0;
/** 每个用例重新载入一份模块,等于刷新页面;prep 先往 localStorage 里放点东西 */
async function fresh(prep) {
  store.clear();
  prep?.();
  return import(`./agentTabs.ts?case=${++n}`);
}

test("AT-C1 第一次打开只有「Agent 1」(主页),它是最后一个,关不掉", async () => {
  const t = await fresh();
  assert.deepEqual(t.getTabs().map((x) => x.title), ["Agent 1"]);
  assert.equal(t.canCloseTab("main"), false);
  t.closeTab("main");
  assert.equal(t.getTabs().length, 1);
});

test("AT-C2 主页「Agent 1」和别的页一样能关;关的是当前页就切到左边那页,在最左就切到右边那页", async () => {
  const t = await fresh();
  const a = t.addTab(); // Agent 2,激活
  const b = t.addTab(); // Agent 3,激活
  t.activateTab("main");
  assert.equal(t.canCloseTab("main"), true);
  t.closeTab("main");
  assert.deepEqual(t.getTabs().map((x) => x.title), ["Agent 2", "Agent 3"]);
  assert.equal(t.getActiveTabId(), a.id);
  t.activateTab(b.id);
  t.closeTab(b.id);
  assert.equal(t.getActiveTabId(), a.id);
  assert.equal(t.canCloseTab(a.id), false);
  // 关的不是当前页,当前页不变
  const c = t.addTab();
  t.activateTab(c.id);
  t.closeTab(a.id);
  assert.equal(t.getActiveTabId(), c.id);
});

test("AT-C3 新建标签取当前最小的空号:关掉 2 号后再新建得到 2 号;关掉 1 号后再新建得到 1 号", async () => {
  const t = await fresh();
  const a = t.addTab();
  t.addTab();
  assert.deepEqual(t.getTabs().map((x) => x.title), ["Agent 1", "Agent 2", "Agent 3"]);
  t.closeTab(a.id);
  assert.equal(t.addTab().title, "Agent 2");
  t.closeTab("main");
  assert.equal(t.addTab().title, "Agent 1");
});

test("AT-C4 刷新后:关掉主页之后的列表原样恢复,不再自动补回主页;编号和激活页保持", async () => {
  const t = await fresh();
  const a = t.addTab();
  t.closeTab("main");
  assert.equal(t.getActiveTabId(), a.id);
  const saved = new Map(store);
  const t2 = await fresh(() => saved.forEach((v, k) => store.set(k, v)));
  assert.deepEqual(t2.getTabs().map((x) => [x.id, x.title]), [[a.id, "Agent 2"]]);
  assert.equal(t2.getActiveTabId(), a.id);
  assert.equal(t2.addTab().title, "Agent 1");
});

test("AT-C5 老数据(没存编号)刷新后按名字认出编号;存的激活页已不存在就落到第一个页", async () => {
  const t = await fresh(() => {
    store.set("pc.agentTabs", JSON.stringify([
      { id: "main", title: "Agent 1" },
      { id: "tx", title: "Agent 3" },
    ]));
    store.set("pc.agentTabs.active", "gone");
  });
  assert.equal(t.getActiveTabId(), "main");
  assert.equal(t.addTab().title, "Agent 2");
  t.closeTab("main");
  assert.equal(t.addTab().title, "Agent 1");
});
