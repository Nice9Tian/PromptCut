import test from "node:test";
import assert from "node:assert/strict";
import { CloudError, cloudErrorText, createCloudApi, normalizeChatItem, normalizeNotice } from "./cloudApi.ts";
import { createCloudSession } from "./session.ts";
import { CLOUD_CHAT_LIMIT, CLOUD_CHAT_TEXT, cloudNoticeText } from "./chatTexts.ts";

/* 块五(0.7.18):页面一侧的 50 个上限提示、删除接口、通知、对话被删时的流事件。 */

const baseApi = (fetchImpl) => createCloudApi({ baseUrl: () => "https://fixture.invalid/v1", projectId: () => "project",
  ticket: async () => "opaque-ticket", grant: async () => undefined, fetchImpl });

test("删除：DELETE 带请求号、不带 Cookie；只认文档服务确认过的回包", async () => {
  const calls = [];
  const api = baseApi(async (url, init) => {
    calls.push({ url: String(url), init });
    return Response.json({ ok: true, conversationId: "c1", removed: true, already: false, projectId: "project" });
  });
  assert.deepEqual(await api.remove("c1", "req-1"), { already: false });
  assert.equal(calls[0].url, "https://fixture.invalid/v1/conversations/c1");
  assert.equal(calls[0].init.method, "DELETE");
  assert.equal(calls[0].init.credentials, "omit");
  assert.deepEqual(JSON.parse(calls[0].init.body), { requestId: "req-1" });
  await assert.rejects(baseApi(async () => Response.json({ ok: true })).remove("c1", "r"), { code: "unavailable" });
  await assert.rejects(baseApi(async () => Response.json({ ok: true, removed: true, conversationId: "other" })).remove("c1", "r"), { code: "unavailable" });
  await assert.rejects(api.remove("", "r"), { code: "bad-request" });
  assert.equal((await baseApi(async () => Response.json({ ok: true, removed: true, conversationId: "c1", already: true })).remove("c1", "r")).already, true);
});

test("错误码给用户看的话：满额、没权限、正在删除、任务还没停稳、已经删了", async () => {
  const fail = (status, code) => baseApi(async () => Response.json({ ok: false, code }, { status })).remove("c1", "r");
  await assert.rejects(fail(409, "conversation-limit"), { code: "conversation-limit", message: CLOUD_CHAT_TEXT.limitReached });
  await assert.rejects(fail(403, "delete-forbidden"), { code: "delete-forbidden", message: CLOUD_CHAT_TEXT.deleteForbidden });
  await assert.rejects(fail(409, "conversation-deleting"), { message: CLOUD_CHAT_TEXT.conversationDeleting });
  await assert.rejects(fail(503, "agent-fence-pending"), { code: "agent-fence-pending", status: 503, message: CLOUD_CHAT_TEXT.deletePending });
  await assert.rejects(fail(404, "no-conversation"), { message: CLOUD_CHAT_TEXT.noConversation });
  assert.equal(cloudErrorText("conversation-limit"), CLOUD_CHAT_TEXT.limitReached);
  assert.match(CLOUD_CHAT_TEXT.limitReached, new RegExp(String(CLOUD_CHAT_LIMIT)));
});

test("列表项带出「有任务在跑」「正在删除」；老形状不受影响", () => {
  const item = normalizeChatItem({ v: 2, id: "c1", projectId: "p", ownerAccountId: "a", visibility: "shared", currentRunId: "run1", deleting: true });
  assert.equal(item.running, true); assert.equal(item.deleting, true);
  const idle = normalizeChatItem({ v: 2, id: "c2", projectId: "p", ownerAccountId: "a", visibility: "private", currentRunId: null });
  assert.equal(idle.running, false); assert.equal("deleting" in idle, false);
  const legacy = normalizeChatItem({ id: "c3", title: "x", state: "running" });
  assert.equal("running" in legacy, false);
});

test("通知：取、回执、气泡文字的几种情形", async () => {
  const calls = [];
  const api = baseApi(async (url, init) => {
    calls.push({ url: String(url), method: init.method ?? "GET", body: init.body });
    if (String(url).endsWith("/notices")) return Response.json({ ok: true, items: [
      { noticeId: "n1", kind: "conversation-deleted", conversationId: "c1", title: "改文案", deletedByAccountId: "acc", deletedByName: "Creator", deletedByRole: "creator", recipientRole: "owner", createdAt: 5 },
      { bogus: true }] });
    return Response.json({ ok: true, acked: 1 });
  });
  const items = await api.notices();
  assert.equal(items.length, 1, "坏形状的丢掉");
  await api.ackNotices(["n1"]);
  await api.ackNotices([]);
  assert.equal(calls.length, 2, "空回执不发请求");
  assert.deepEqual(JSON.parse(calls[1].body), { noticeIds: ["n1"] });
  assert.equal(calls[1].method, "POST");
  assert.equal(normalizeNotice({ noticeId: "x" }), null);

  assert.equal(cloudNoticeText(items[0]), "项目创建者「Creator」删除了你的云端对话「改文案」。");
  assert.equal(cloudNoticeText({ recipientRole: "participant", deletedByRole: "owner", deletedByName: "Alice", title: "" }),
    "「Alice」删除了共有云端对话「云端对话」，你在里面发过消息。");
  assert.equal(cloudNoticeText({ recipientRole: "participant", deletedByRole: "creator", deletedByName: "Boss", title: "T" }),
    "项目创建者「Boss」删除了共有云端对话「T」，你在里面发过消息。");
});

test("流上来 conversation.deleted：清掉正文、不重连、通知界面退出这个对话", async () => {
  const messages = { v: [] }, listeners = new Set();
  const store = { get: () => messages.v, set(next) { messages.v = typeof next === "function" ? next(messages.v) : next; for (const l of listeners) l(); },
    subscribe(l) { listeners.add(l); return () => listeners.delete(l); } };
  const deleted = [];
  let streams = 0;
  const api = {
    async send() { return { runId: "r", seq: 1 }; },
    async abort() {},
    async *events() {
      streams++;
      yield { type: "user", seq: 1, runId: "r1", prompt: "旧内容", messageId: "m1", senderAccountId: "a", senderNameAtSend: "A" };
      yield { type: "conversation.deleted" };
      assert.fail("收到 conversation.deleted 以后不该再读这条流");
    },
  };
  const session = createCloudSession({ api, store, accountMode: true, onConversationDeleted: (id) => deleted.push(id), backoff: () => 5 });
  session.open("conv-x");
  const deadline = Date.now() + 2000;
  while (!deleted.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(deleted, ["conv-x"]);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(streams, 1, "不重连");
  assert.deepEqual(store.get(), [], "旧正文清掉");
  assert.equal(session.getView().connection, "idle");
  assert.equal(session.getView().problem, null, "不显示「无权读取」");
  session.close();
});
