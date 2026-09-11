/**
 * node --test src/ai/handoff.test.mjs
 *
 * 换模型接手时要把前面几轮摘给新模型。来自诊断报告 对话诊断-20260910-204342:
 * 前半段 Gemini 被用户骂「根本没有视频和图片」,换成 Opus 后它只收到一句「你来接替继续」,
 * 看不到那句不满,于是按项目现状自己找活干,还去磁盘上翻交接笔记。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { buildHandoff } = await import("./handoff.ts");

const u = (text) => ({ id: text, role: "user", text });
const a = (provider, text, extra = {}) => ({ id: `${provider}-${text}`, role: "assistant", text, runtime: { provider }, ...extra });

test("新模型没有会话:整段对话都摘进去,用户的原话一句不漏", () => {
  const h = [u("做个东京旅游宣传片"), a("agy", "已加了 10 张卡"), u("根本没有视频和图片"), a("agy", "我去找图")];
  const s = buildHandoff(h, "claude", false);
  assert.match(s, /^\[前情/);
  assert.match(s, /\[\/前情\]$/);
  assert.match(s, /用户:做个东京旅游宣传片/);
  assert.match(s, /用户:根本没有视频和图片/);
  assert.match(s, /助手\(Antigravity\):我去找图/);
});

test("有会话:只摘这家最后一次回复之后、别家说的那几轮", () => {
  const h = [u("一"), a("claude", "C1"), u("二"), a("agy", "G1"), u("三")];
  const s = buildHandoff(h, "claude", true);
  assert.doesNotMatch(s, /用户:一/, "claude 自己见过的不重复");
  assert.doesNotMatch(s, /C1/);
  assert.match(s, /用户:二/);
  assert.match(s, /G1/);
});

test("有会话、中间没有别家说话:不加前情", () => {
  const h = [u("一"), a("claude", "C1"), u("二"), a("claude", "", { error: "额度熔断" })];
  assert.equal(buildHandoff(h, "claude", true), "");
});

test("空对话、或者只有用户自己的话:不加前情", () => {
  assert.equal(buildHandoff([], "claude", false), "");
  assert.equal(buildHandoff([u("你好")], "claude", false), "");
});

test("还在跑的消息不算", () => {
  const h = [u("一"), a("agy", "半截", { pending: true })];
  assert.equal(buildHandoff(h, "claude", false), "");
});

test("太长:单条截断,总量封顶,留最近的", () => {
  const h = [];
  for (let i = 0; i < 40; i++) { h.push(u(`第${i}句 ` + "字".repeat(300))); h.push(a("agy", `回${i} ` + "答".repeat(3000))); }
  const s = buildHandoff(h, "claude", false, { maxChars: 4000, perMessage: 500 });
  assert.ok(s.length < 6000, `总长该封顶,实际 ${s.length}`);
  assert.match(s, /第39句/, "最近的必须在");
  assert.doesNotMatch(s, /第0句/, "最早的让位");
  assert.match(s, /更早的 \d+ 条略/);
  assert.match(s, /后面略/);
});
