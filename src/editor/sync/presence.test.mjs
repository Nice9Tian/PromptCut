/**
 * 页面一侧的在场状态(src/editor/sync/presence.ts,计划 agent-workflow-plan.md A3 第二阶段)。用例 MA-P6～MA-P8。
 * 跑:node --test src/editor/sync/presence.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";

const pres = await import("./presence.ts");

function fakeLink(replyFor) {
  const sent = [];
  return {
    sent,
    request: async (msg) => {
      sent.push(msg);
      return replyFor(msg);
    },
  };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test("MA-P6 发布正在编辑:非空 presence.set(15 秒过期、带会话号);空了 presence.clear;没发布过不发撤销", async () => {
  const link = fakeLink((m) => (m.type === "presence.list" ? { type: "presence.state", entries: [] } : { type: "presence.ok" }));
  pres.setPresenceLink(link, "p1", "bob@devB");
  await tick();
  pres.publishEditing("ue-1", []);
  assert.equal(link.sent.filter((m) => m.type !== "presence.list").length, 0, "没发布过就不发撤销");
  pres.publishEditing("ue-1", [{ clipId: "c2", kind: "drag" }]);
  const set = link.sent.at(-1);
  assert.deepEqual({ type: set.type, projectId: set.projectId, session: set.session, key: set.key, ttlMs: set.ttlMs, kind: set.data.kind, clip: set.data.entities[0].clipId }, { type: "presence.set", projectId: "p1", session: "ue-1", key: "editing", ttlMs: pres.EDITING_TTL_MS, kind: "editing", clip: "c2" });
  assert.equal(pres.EDITING_TTL_MS, 15_000);
  pres.publishEditing("ue-1", []);
  assert.equal(link.sent.at(-1).type, "presence.clear");
});

test("MA-P7 旧版文档服务回 unsupported:记下这条连接不支持,之后一概不发,不抛错", async () => {
  const link = fakeLink(() => ({ type: "error", reason: "unsupported" }));
  pres.setPresenceLink(link, "p1", "bob@devB");
  await tick();
  pres.publishEditing("ue-1", [{ clipId: "c2", kind: "drag" }]);
  await tick();
  const n = link.sent.length;
  pres.publishEditing("ue-1", [{ clipId: "c3", kind: "drag" }]);
  await tick();
  assert.equal(link.sent.length, n, "不再发");
  assert.equal(pres.presenceStatus().unsupported, true);
});

test("MA-P8 收别的成员那边 Agent 的范围:列出来;自己的(同一个 userId)与本机空间的不算;撤销与过期的去掉", async () => {
  const link = fakeLink((m) => (m.type === "presence.list"
    ? { type: "presence.state", projectId: "p1", entries: [{ key: "agent:conv-a", from: { userId: "alice@devA", role: "agent" }, data: { kind: "agent", scope: "剪辑1->序列2", vendor: "claude" }, expiresAt: Date.now() + 60_000 }] }
    : { type: "presence.ok" }));
  pres.setPresenceLink(link, "p1", "bob@devB");
  await tick();
  await tick();
  assert.deepEqual(pres.remoteAgents().map((a) => [a.id, a.member, a.vendor, a.scope]), [["conv-a", "alice", "claude", "剪辑1->序列2"]]);
  pres.receivePresence({ type: "presence.update", projectId: "p1", key: "agent:conv-mine", from: { userId: "bob@devB", role: "agent" }, data: { kind: "agent", scope: "剪辑1" }, expiresAt: Date.now() + 60_000 });
  pres.receivePresence({ type: "presence.update", projectId: "p1", key: "agent:conv-local", from: { userId: "local", role: "agent" }, data: { kind: "agent", scope: "剪辑1" }, expiresAt: Date.now() + 60_000 });
  pres.receivePresence({ type: "presence.update", projectId: "p2", key: "agent:conv-p2", from: { userId: "carol@devC" }, data: { kind: "agent", scope: "x" }, expiresAt: Date.now() + 60_000 });
  assert.deepEqual(pres.remoteAgents().map((a) => a.id), ["conv-a"], "自己的、本机空间的、别的项目的都不算");
  pres.receivePresence({ type: "presence.update", projectId: "p1", key: "agent:conv-old", from: { userId: "dan@devD" }, data: { kind: "agent", scope: "y" }, expiresAt: Date.now() - 1 });
  assert.deepEqual(pres.remoteAgents().map((a) => a.id), ["conv-a"], "过期的不列");
  pres.receivePresence({ type: "presence.update", projectId: "p1", key: "agent:conv-a", from: { userId: "alice@devA" }, data: null, expiresAt: 0 });
  assert.deepEqual(pres.remoteAgents(), []);
  pres.setPresenceLink(null, null, "");
  assert.equal(pres.presenceStatus().linked, false);
});
