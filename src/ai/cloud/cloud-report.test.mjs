/**
 * 云端对话的诊断报告与空对话示例句(用户 2026-10-07 定;契约 `docs/plan/cloud-agent-contract.md` 第 22 节)。
 * 跑:npm test -- src/ai/cloud/cloud-report.test.mjs
 *
 *   CAU-DIAG-01  报告含这段云端对话的过程(每一轮的用户消息、回复、工具调用与结果)、出错原因、客户端与版本信息;
 *   CAU-DIAG-02  报告里没有任何凭证:票据形状的串(`v1.<段>.<段>`)、对话委托、模型 Key、Bearer、带 key/token 的查询参数;
 *                键名叫 grant / ticket / token 的字段整条抹掉;整份 JSON 文本里再扫一遍都没有;
 *   CAU-DIAG-03  守门:报告与云端 AI 栏的源码里没有 `/api/` 请求(在线页面不请求编辑器进程的 `/api/*`),「保存为文件」在在线构建里是浏览器下载;
 *   CAU-EMPTY-01 空对话只留一条示例句,原文照抄(含句号),本机与云端同一份。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyCloudEvents } from "./events.ts";
import { cloudConversationReport, scrubCloudSecrets, CLOUD_REPORT_FORMAT } from "./report.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// 测试里的假凭证(形状对,值是假的)
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const FAKE_TICKET = `v1.${b64({ kid: "k1", k: "dlg", p: "proj_abc", u: "alice@dev", exp: 9999999999 })}.${Buffer.alloc(32, 7).toString("base64url")}`;
const FAKE_GRANT = `v1.${b64({ kid: "k1", k: "dlg", p: "proj_abc", c: "cc-1", exp: 9999999999 })}.${Buffer.alloc(32, 9).toString("base64url")}`;
const FAKE_KEY = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd";
const FAKE_GKEY = "AIzaSyA1234567890abcdefghijklmnopqrstuv";

const events = [
  { type: "user", seq: 1, runId: "r1", prompt: `把标题改成你好(我的票据是 ${FAKE_TICKET},别外传)`, at: 1000 },
  { type: "tool_call", seq: 2, runId: "r1", name: "update_clip", input: { clipId: "c1", text: "你好", grant: FAKE_GRANT, note: `Authorization: Bearer ${FAKE_TICKET}` }, callId: "k1" },
  { type: "tool_result", seq: 3, runId: "r1", name: "update_clip", ok: true, summary: "已改", callId: "k1", durationMs: 12 },
  { type: "tool_call", seq: 4, runId: "r1", name: "get_project", input: { url: `https://x.test/y?token=abc123&key=${FAKE_KEY}` }, callId: "k2" },
  { type: "tool_result", seq: 5, runId: "r1", name: "get_project", ok: false, summary: `读取失败 ${FAKE_GKEY}`, callId: "k2", durationMs: 5 },
  { type: "render", seq: 6, runId: "r1", state: "failed", reason: "渲染节点 10 分钟没有进展" },
  { type: "text", seq: 7, runId: "r1", delta: "改好了" },
  { type: "error", seq: 8, runId: "r1", code: "model", message: `模型调用失败:401 invalid x-api-key ${FAKE_KEY}` },
  { type: "end", seq: 9, runId: "r1", state: "failed", reason: "model" },
  { type: "user", seq: 10, runId: "r2", prompt: "再试一次", at: 5000 },
];

const messages = applyCloudEvents([], events);
const input = {
  messages,
  conversationId: "cc-abc-1234",
  projectId: "proj_abc",
  serviceUrl: "https://149-88-94-84.sslip.io/agent/v1",
  view: { streaming: true, connection: "live", problem: null, lastSeq: 10 },
  info: { enabled: true, models: [{ id: "claude-x", label: "Claude X" }], defaultModel: "claude-x", running: ["cc-abc-1234"], limits: { rounds: 24, runMs: 1800000 } },
  model: "claude-x",
  notice: null,
  client: { mode: "online", userAgent: "Mozilla/5.0 test", language: "zh-CN", platform: "Win32", viewport: { width: 1440, height: 900, dpr: 2 }, codeVersion: "abcdef123456" },
  now: Date.UTC(2026, 9, 7, 8, 0, 0),
};

test("CAU-DIAG-01 报告含这段云端对话的过程、出错原因、客户端与版本信息", () => {
  const text = cloudConversationReport(input);
  const r = JSON.parse(text);
  assert.equal(r.format, CLOUD_REPORT_FORMAT);
  assert.equal(r.exportedAt, "2026-10-07T08:00:00.000Z");
  assert.equal(r.conversation.id, "cc-abc-1234");
  assert.equal(r.conversation.rounds, 2);
  assert.equal(r.conversation.running, true);
  assert.equal(r.conversation.connection, "live");
  assert.equal(r.service.url, "https://149-88-94-84.sslip.io/agent/v1", "只留来源与路径");
  assert.deepEqual(r.service.models, [{ id: "claude-x", label: "Claude X" }]);
  assert.equal(r.client.mode, "online");
  assert.equal(r.client.codeVersion, "abcdef123456");
  assert.equal(r.client.viewport.width, 1440);
  // 第一轮:用户消息、两次工具调用及结果、补渲失败、文字、出错原因
  const r1 = r.rounds[0];
  assert.equal(r1.round, 1);
  assert.match(r1.user, /把标题改成你好/);
  assert.deepEqual(r1.reply.tools.map((t) => [t.name, t.ok]), [["update_clip", true], ["get_project", false]]);
  assert.equal(r1.reply.tools[0].durationMs, 12);
  assert.equal(r1.reply.render.state, "failed");
  assert.equal(r1.reply.text, "改好了");
  assert.equal(r1.reply.outcome, "error");
  assert.match(r1.reply.error, /模型调用失败/);
  assert.deepEqual(r.errors.map((e) => e.round), [1], "出错原因单列一处,标明是哪一轮");
  // 第二轮还在跑
  assert.equal(r.rounds[1].reply.running, true);
});

test("CAU-DIAG-02 报告里没有任何凭证:票据形状、对话委托、模型 Key、Bearer、带 key/token 的查询参数", () => {
  const text = cloudConversationReport(input);
  for (const secret of [FAKE_TICKET, FAKE_GRANT, FAKE_KEY, FAKE_GKEY, "abc123"]) {
    assert.equal(text.includes(secret), false, `报告里不该出现 ${secret.slice(0, 18)}…`);
  }
  assert.equal(/\bv1\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/.test(text), false, "整份文本里没有票据形状的串");
  assert.equal(/\bsk-[A-Za-z0-9_-]{8,}/.test(text), false, "没有 sk- 形状的 Key");
  assert.equal(/\bAIza[0-9A-Za-z_-]{20,}/.test(text), false);
  assert.equal(/Bearer\s+(?!\[)/.test(text), false, "Bearer 后面不是原值");
  const r = JSON.parse(text);
  assert.equal(r.rounds[0].reply.tools[0].input.grant, "[REDACTED]", "键名叫 grant 的字段整条抹掉");
  assert.equal(r.rounds[0].reply.tools[0].input.clipId, "c1", "别的字段原样留着,排查要用");
  // 用户消息里粘进来的票据也被换掉,其余文字还在
  assert.match(r.rounds[0].user, /我的票据是 \[TICKET-REDACTED\],别外传/);
});

test("CAU-DIAG-02b scrubCloudSecrets 单独可用;过长的字段截断并写明", () => {
  assert.equal(scrubCloudSecrets(`a ${FAKE_TICKET} b`), "a [TICKET-REDACTED] b");
  assert.equal(scrubCloudSecrets("没有凭证的话原样"), "没有凭证的话原样");
  const long = "字".repeat(9000);
  const text = cloudConversationReport({ ...input, messages: applyCloudEvents([], [{ type: "user", seq: 1, runId: "x", prompt: long }]) });
  assert.match(JSON.parse(text).rounds[0].user, /已截断,原 9000 字/);
});

test("CAU-DIAG-03 守门:报告与云端 AI 栏不请求 /api/*;在线构建里「保存为文件」是浏览器下载", () => {
  for (const rel of ["src/ai/cloud/report.ts", "src/editor/right/CloudAiPanel.tsx"]) {
    // 去掉注释再查:注释里会写「不请求 `/api/*`」这样的话
    const src = read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.equal(/["'`]\/api\//.test(src), false, `${rel} 里不该有 /api/ 请求`);
  }
  const dialog = read("src/editor/right/ReportDialog.tsx");
  assert.match(dialog, /if \(ONLINE_BUILD\) return downloadReportFile\(text, label\)/, "在线构建里「保存为文件」走浏览器下载");
  const dbg = read("src/ai/debug.ts");
  assert.match(dbg, /export function downloadReportFile/);
  const panel = read("src/editor/right/CloudAiPanel.tsx");
  assert.match(panel, /canDiagnose: chat\.messages\.length > 0/, "云端下诊断报告不置灰、也不隐藏");
  assert.match(panel, /cloudConversationReport\(/);
});

test("CAU-EMPTY-01 空对话只留一条示例句,原文照抄,本机与云端同一份", () => {
  const src = read("src/editor/right/chat/MessageList.tsx");
  assert.match(src, /export const EMPTY_EXAMPLE = "为我快速创建一个视频告诉我软件都可以做什么。";/);
  assert.equal((src.match(/className="ai-empty-example"/g) ?? []).length, 1, "空对话里只有一个示例按钮");
  for (const old of ["时间轴上现在有什么", "金句卡", "根据我刚导入的视频做字幕"]) assert.equal(src.includes(old), false, `旧示例句「${old}」已清掉`);
  // 本机 AI 栏与云端 AI 栏都经 MessageList,没有各写一份
  for (const rel of ["src/editor/right/AiPanel.tsx", "src/editor/right/CloudAiPanel.tsx"]) {
    const s = read(rel);
    assert.match(s, /<MessageList/);
    assert.equal(s.includes("ai-empty-example"), false);
  }
});

/* ---------- 本机对话的报告与两个出口(用户 2026-10-07 定,任务书 K) ---------- */
import { conversationReport, recordTrace, redactDebug } from "../debug.ts";

test("CAU-DIAG-04 本机对话的报告按这段对话出,同样不含凭证、票据、委托、模型 Key(含它的执行事件与环境快照)", () => {
  const FAKE_CODE = "PCM-ABCDE-FGHJK-MNPQR-STVWX";
  let reply = {
    id: "a1", role: "assistant", text: `读到了 ${FAKE_GKEY},也看到 ${FAKE_TICKET}`, error: `401 invalid x-api-key ${FAKE_KEY}`, outcome: "error",
    tools: [{ name: "update_clip", input: { clipId: "c1", grant: FAKE_GRANT, delegation: FAKE_TICKET, ticket: FAKE_TICKET } }],
  };
  reply = recordTrace(reply, { type: "tool_call", name: "web_fetch", input: { url: `https://x.test/y?token=abc123&key=${FAKE_KEY}`, headers: { Authorization: `Bearer ${FAKE_TICKET}` } } });
  reply = recordTrace(reply, { type: "text", delta: `模型回了 ${FAKE_GKEY}` });
  const user = { id: "u1", role: "user", text: `我的票据 ${FAKE_TICKET},Key 是 ${FAKE_KEY}` };
  const text = conversationReport([user, reply], "api", null, { server: { machineCode: FAKE_CODE, headers: { "x-api-key": FAKE_KEY }, note: FAKE_GRANT } });
  for (const secret of [FAKE_TICKET, FAKE_GRANT, FAKE_KEY, FAKE_GKEY, "abc123", "FGHJK"]) {
    assert.equal(text.includes(secret), false, `本机对话报告里不该出现 ${secret.slice(0, 18)}…`);
  }
  assert.equal(/\bv1\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/.test(text), false, "整份文本里没有票据形状的串");
  assert.equal(/\bsk-[A-Za-z0-9_-]{8,}/.test(text), false);
  assert.equal(/\bAIza[0-9A-Za-z_-]{20,}/.test(text), false);
  assert.equal(/Bearer\s+(?!\[)/.test(text), false);
  const r = JSON.parse(text);
  assert.equal(r.messages.length, 2, "是这段对话的全部消息,不是整机诊断");
  assert.equal(r.messages[1].tools[0].input.grant, "[REDACTED]");
  assert.equal(r.messages[1].tools[0].input.clipId, "c1", "排查要用的字段原样留着");
  assert.match(r.messages[0].text, /我的票据 \[TICKET-REDACTED\]/);
});

test("CAU-DIAG-04b redactDebug 的新增规则不误伤排查要用的东西(版本号、文件名、计数)", () => {
  const out = redactDebug({ v: "v1.2.3", file: "v1.final_render.mp4", max_tokens: 4096, note: "第 v1 版" });
  assert.deepEqual(out, { v: "v1.2.3", file: "v1.final_render.mp4", max_tokens: 4096, note: "第 v1 版" });
});

test("CAU-DIAG-05 两个出口:下载是浏览器本地的,提交是页面直接打收集端的外部地址,都不经 /api/*;本机与云端同一个对话框", () => {
  const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const submit = code("src/ai/reportSubmit.ts");
  assert.equal(/["'`]\/api\//.test(submit), false, "提交不经编辑器进程的 /api/*");
  assert.match(submit, /fetch\(SUBMIT_URL,/, "提交直接请求收集端的地址");
  assert.match(submit, /"Content-Type": "text\/plain;charset=utf-8"/, "text/plain 是 CORS 简单请求,在线页面跨源提交不触发预检");
  assert.match(submit, /if \(!SUBMIT_URL\) return /, "没配收集端地址时给出原因(按钮置灰)");
  const dialog = read("src/editor/right/ReportDialog.tsx");
  assert.match(dialog, /submitReport\(text, label\)/);
  assert.match(dialog, /disabled=\{collecting \|\| submitBlocked !== "" \|\| busy !== ""\}/, "没配地址时提交按钮置灰");
  for (const rel of ["src/editor/right/AiPanel.tsx", "src/editor/right/CloudAiPanel.tsx"]) {
    assert.match(read(rel), /<ReportDialog/, `${rel} 用同一个报告对话框(复制、保存为文件、提交)`);
  }
  assert.match(read("src/editor/right/AiPanel.tsx"), /conversationReport\(messages, provider, config, environment\)/, "本机对话按对话出报告");
});
