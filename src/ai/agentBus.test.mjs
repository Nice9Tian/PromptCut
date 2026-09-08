/**
 * 多 Agent 公告板(agentBus)的单测。跑:node --test src/ai/agentBus.test.mjs
 *
 * 钉死三件事:范围差分算得对;send_message 的自动投递有层数上限,不会两个 Agent 互相唤醒到天亮;
 * consumeNotes 只给「别人的、上次之后的」动态,而且取走即已读。
 */
import test from "node:test";
import assert from "node:assert/strict";

// 浏览器里才有的东西:agentTabs 读 localStorage、react 的 useSyncExternalStore 只是引用
globalThis.localStorage = (() => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
})();

const bus = await import("./agentBus.ts");
const tabs = await import("./agentTabs.ts");

function project(tracks, activeCutId = "c1") {
  return {
    name: "p", width: 1080, height: 1920, fps: 30, duration: 10, media: [],
    tracks,
    cuts: [{ id: "c1", name: "剪辑 1" }, { id: "c2", name: "剪辑 2" }],
    activeCutId,
  };
}
const track = (id, name, clips = []) => ({ id, name, clips });

test("diffScopes:只报 clips 数组换了引用的那几条序列,格式是「剪辑->序列」", () => {
  const a = [track("t1", "序列 1", []), track("t2", "序列 2", [])];
  const before = project(a);
  const after = project([a[0], track("t2", "序列 2", [{ id: "x" }])]);
  assert.deepEqual(bus.diffScopes(before, after), ["剪辑 1->序列 2"]);
});

test("diffScopes:切换剪辑整条剪辑算范围;删序列标出来", () => {
  const a = [track("t1", "序列 1"), track("t2", "序列 2")];
  assert.deepEqual(bus.diffScopes(project(a, "c1"), project(a, "c2")), ["剪辑 2"]);
  assert.deepEqual(bus.diffScopes(project(a), project([a[0]])), ["剪辑 1->序列 2(已删)"]);
});

test("declare_scope 改页签名;范围重叠给 warning", () => {
  bus._resetBus();
  tabs.setTabConversation("main", "c-a");
  const t2 = tabs.addTab();
  tabs.setTabConversation(t2.id, "c-b");
  const r1 = bus.declareScope("c-a", { scope: "剪辑1->序列2" });
  assert.equal(r1.ok, true);
  assert.equal(tabs.getTabs().find((t) => t.id === "main").title, "剪辑1->序列2");
  const r2 = bus.declareScope("c-b", { scope: "剪辑1->序列2, 剪辑1->序列3" });
  assert.match(r2.warning, /c-a/);
  assert.throws(() => bus.declareScope("c-a", {}), /scope 必填/);
  tabs.closeTab(t2.id);
});

test("send_message:空闲对方自动投递,层数到顶就攒着;consumeNotes 取走即已读", () => {
  bus._resetBus();
  tabs.setTabConversation("main", "c-a");
  const t2 = tabs.addTab();
  tabs.setTabConversation(t2.id, "c-b");

  // 用户发起的那一轮(层数 0)里 a 给 b 发:b 能自动收到
  bus.beginRun("c-a", 0);
  const r = bus.sendMessage("c-a", { to: "c-b", text: "序列2 我来改" });
  assert.deepEqual(r.delivered, ["c-b"]);
  assert.equal(bus.hasAutoDeliverable("c-b"), true);
  assert.equal(tabs.getTabs().find((t) => t.id === t2.id).unread, 1);
  const got = bus.takeInbox("c-b", true);
  assert.equal(got.length, 1);
  assert.equal(got[0].hops, 1);
  assert.match(bus.formatInbound(got), /【来自 Agent c-a 的消息】/);

  // b 在第 MAX_AUTO_HOPS-1 层跑时再发回 a:这一条到顶,不自动投递
  bus.beginRun("c-b", bus.MAX_AUTO_HOPS - 1);
  bus.sendMessage("c-b", { to: "c-a", text: "好" });
  assert.equal(bus.hasAutoDeliverable("c-a"), false);
  assert.equal(bus.takeInbox("c-a", true).length, 0, "到顶的不能被自动取走");

  // a 下一次发消息时的动态里带着这条,取走之后第二次就是空的
  const notes = bus.consumeNotes("c-a");
  assert.match(notes, /Agent c-b 给你的消息:好/);
  assert.match(notes, /你的 Agent 对话 ID:c-a/);
  assert.equal(bus.consumeNotes("c-a"), "");

  assert.throws(() => bus.sendMessage("c-a", { to: "nobody", text: "x" }), /没有这个 Agent/);
  tabs.closeTab(t2.id);
});

test("noteToolChange:别人的改动进动态,自己的不进;没改到序列不记", () => {
  bus._resetBus();
  const a = [track("t1", "序列 1"), track("t2", "序列 2")];
  const before = project(a);
  bus.markSeen("c-a");
  bus.noteToolChange("c-b", "add_clip", before, project([a[0], track("t2", "序列 2", [{ id: "x" }])]));
  bus.noteToolChange("c-a", "add_clip", before, project([track("t1", "序列 1", [{ id: "y" }]), a[1]]));
  bus.noteToolChange("c-b", "seek", before, before);
  const notes = bus.consumeNotes("c-a");
  assert.match(notes, /Agent c-b.*用 add_clip 改了 剪辑 1->序列 2/);
  assert.doesNotMatch(notes, /序列 1/, "自己的改动不用通报给自己");
  assert.equal(bus.getChanges().length, 2);
});
