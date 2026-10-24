/**
 * 游客每个项目只能开一个云端 Agent 对话（2026-10-23 用户定）在页面这一侧的部分：
 *   - 上限是几个由身份定：账号 50，游客 1（`chatLimitOf`，和服务端 `MAX_CONVERSATIONS_PER_OWNER`、`GUEST_LIMITS.conversations` 同数）；
 *   - 服务端拒新建回 403 `guest-chat-limit`，页面把它译成「游客每个项目只能开一个对话……注册一个账号」那句，不落到「云端 Agent 出错了(代号)」；
 *   - 界面上哪些「新建对话」的入口会置灰、说明从哪来：源码守门（真页面要游客先过告知那一关，当前游客过不了，见报告）。
 * 服务端那一层见 `server/test/guest-one-chat.test.mjs`、`guest-one-chat-http.test.mjs`。
 *
 * 跑：npm test -- src/ai/cloud/guest-chat-limit.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CloudError, cloudErrorText, createCloudApi } from "./cloudApi.ts";
import { CLOUD_CHAT_LIMIT, CLOUD_CHAT_TEXT, chatLimitOf } from "./chatTexts.ts";
import { GUEST_CHAT_LIMIT_TEXT, GUEST_LIMITS } from "../../account/guest.ts";
import { GUEST_LIMITS as SERVER_LIMITS } from "../../../server/account/guest.mjs";
import { MAX_CONVERSATIONS_PER_OWNER } from "../../../server/account/conversation-authority.mjs";

const guestId = "gst_" + "a".repeat(24), accountId = "acc_" + "a".repeat(24);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const source = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

test("GCL-1 上限由身份定：游客 1 个、账号 50 个，两边（页面与服务端）同数；没有身份当账号算", () => {
  assert.equal(chatLimitOf(guestId), 1);
  assert.equal(chatLimitOf(guestId), SERVER_LIMITS.conversations);
  assert.equal(chatLimitOf(accountId), CLOUD_CHAT_LIMIT);
  assert.equal(chatLimitOf(accountId), MAX_CONVERSATIONS_PER_OWNER);
  assert.equal(chatLimitOf(null), CLOUD_CHAT_LIMIT);
  assert.equal(chatLimitOf(undefined), CLOUD_CHAT_LIMIT);
  assert.equal(GUEST_LIMITS.conversations, SERVER_LIMITS.conversations);
});

test("GCL-2 服务端回 403 guest-chat-limit：页面拿到可辨认的码和那句人话（发新对话的第一条消息被拒就是这样）", async () => {
  const api = createCloudApi({ baseUrl: () => "https://fixture.invalid/v1", projectId: () => "project",
    ticket: async () => "opaque-ticket", grant: async () => undefined,
    fetchImpl: async () => Response.json({ ok: false, code: "guest-chat-limit", message: "guest-chat-limit" }, { status: 403 }) });
  const failed = await api.send("c-2", { prompt: "第二个对话" }).then(() => null, (error) => error);
  assert.ok(failed instanceof CloudError);
  assert.equal(failed.code, "guest-chat-limit");
  assert.equal(failed.status, 403);
  assert.equal(failed.message, CLOUD_CHAT_TEXT.guestLimit);
  assert.equal(cloudErrorText("guest-chat-limit"), GUEST_CHAT_LIMIT_TEXT);
  assert.doesNotMatch(failed.message, /guest-chat-limit|出错了/, "不把代号当人话");
  // 说为什么、怎么接着聊、怎么多开
  assert.match(failed.message, /只能开 1 个 Agent 对话/);
  assert.match(failed.message, /对话历史/);
  assert.match(failed.message, /注册一个账号/);
  // 账号的满额那句没被动
  assert.equal(cloudErrorText("conversation-limit"), CLOUD_CHAT_TEXT.limitReached);
  assert.match(CLOUD_CHAT_TEXT.limitReached, new RegExp(String(CLOUD_CHAT_LIMIT)));
  assert.equal(CLOUD_CHAT_TEXT.countLabel(3), `我的 3/${CLOUD_CHAT_LIMIT}`, "账号那一组的计数照旧");
  assert.equal(CLOUD_CHAT_TEXT.countLabel(1, 1), "我的 1/1", "游客显示 1/1，不是 1/50");
});

test("GCL-3 守门：每个「新建对话」的入口都接了游客的限制（源码）", () => {
  const useCloud = source("src/ai/cloud/useCloud.ts");
  // 判断在 hook 里：游客满额时 newChat 自己就不开新对话、给说明；上限与「是游客」都对外给
  assert.match(useCloud, /chatLimitOf\(cloud\.accountId\)/);
  assert.match(useCloud, /if \(chatGuest && atLimit\) \{ setNotice\(CLOUD_CHAT_TEXT\.guestLimit\); return; \}/);
  assert.match(useCloud, /limit: chatLimit, guest: chatGuest/);
  assert.match(useCloud, /err\.code === "guest-chat-limit"/, "被拒之后重读列表，界面和服务端对上");
  assert.doesNotMatch(useCloud, /CLOUD_CHAT_LIMIT/, "不再把 50 写死在 hook 里");

  const panel = source("src/editor/right/CloudAiPanel.tsx");
  assert.match(panel, /guestChatFull = cloud\.accountMode && chat\.history\.guest && chat\.history\.atLimit/);
  assert.match(panel, /onNewChat: \(\) => chat\.newChat\(\),\s*\.\.\.\(guestChatFull \? \{ newChatDisabledReason: CLOUD_CHAT_TEXT\.guestLimit \} : \{\}\)/, "输入框「✦」菜单里的新对话");
  assert.match(panel, /\.\.\.\(guestChatFull \? \{ newChatDisabledReason: CLOUD_CHAT_TEXT\.guestLimit \} : \{\}\)\}\s*hideLocal/, "对话历史抽屉头部的新对话");
  assert.match(panel, /disabled=\{Boolean\(view\.revoked\) \|\| guestNoNewChat\}/, "停在一段没发过的新对话上时输入区置灰");
  assert.match(panel, /limit: chat\.history\.limit/);
  assert.match(panel, /limitText: CLOUD_CHAT_TEXT\.guestLimit/);

  assert.match(source("src/editor/right/chat/Composer.tsx"), /disabled=\{ro\.locked \|\| !!newChatDisabledReason\}/);
  assert.match(source("src/editor/right/ChatHistoryDrawer.tsx"), /data-pc="chat-new" disabled=\{!!newChatDisabledReason\}/);

  const start = source("src/start/OnlineStart.tsx");
  assert.match(start, /if \(vibe\.chat\.history\.guest && vibe\.chat\.history\.atLimit\) \{ setNotice\(GUEST_CHAT_LIMIT_TEXT\); return; \}/, "开始页侧栏点「新对话」");
  assert.match(start, /newChatBlocked=\{\(projectId\) => \(projectId === openId && vibe\.chat\.history\.guest && vibe\.chat\.history\.atLimit \? GUEST_CHAT_LIMIT_TEXT : null\)\}/);
  assert.match(source("src/start/ProjectSidebar.tsx"), /aria-disabled=\{blocked \? true : undefined\} title=\{blocked \?\? undefined\}/);
});
