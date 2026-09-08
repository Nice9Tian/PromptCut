/**
 * modelOptions.ts 里「参数兼容模式」开关策略的单测。跑:node --test src/ai/compatPolicy.test.mjs
 * 钉住的是:Claude / GPT 锁关、Gemini 锁开(不管走哪个厂商的接口),别家才让用户调。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { compatPolicy, compatToSend } from "./modelOptions.ts";

test("CLI 三条路:Claude Code / Codex 锁关,Antigravity 锁开", () => {
  assert.deepEqual(pick(compatPolicy("claude", "opus", undefined, "on")), [false, true]);
  assert.deepEqual(pick(compatPolicy("codex", "gpt-5.6-terra", undefined, "on")), [false, true]);
  assert.deepEqual(pick(compatPolicy("agy", "", undefined, "off")), [true, true]);
});

test("API 直连按模型名:gemini 锁开(哪怕挂在 openai 兼容接口后面),claude / gpt / o 系 / codex 锁关", () => {
  assert.deepEqual(pick(compatPolicy("api", "gemini-2.5-pro", "openai", "off")), [true, true]);
  assert.deepEqual(pick(compatPolicy("api", "gpt-5.6-terra", "openai", "on")), [false, true]);
  assert.deepEqual(pick(compatPolicy("api", "claude-opus-5", "anthropic", "on")), [false, true]);
  assert.deepEqual(pick(compatPolicy("api", "o3-mini", "openai", "on")), [false, true]);
  assert.deepEqual(pick(compatPolicy("api", "codex-mini", "openai", "on")), [false, true]);
});

test("别家模型:用户自己调;auto 按厂商字段兜底", () => {
  assert.deepEqual(pick(compatPolicy("api", "qwen3-max", "openai", "auto")), [false, false]);
  assert.deepEqual(pick(compatPolicy("api", "qwen3-max", "openai", "on")), [true, false]);
  assert.deepEqual(pick(compatPolicy("api", "deepseek-v4", "gemini", "auto")), [true, false]);
  assert.deepEqual(pick(compatPolicy("api", "deepseek-v4", "gemini", "off")), [false, false]);
});

test("compatToSend:锁死的给定论,可调的把偏好原样交给服务端", () => {
  assert.equal(compatToSend("api", "gemini-2.5-pro", "openai", "off"), "on");
  assert.equal(compatToSend("claude", "opus", undefined, "on"), "off");
  assert.equal(compatToSend("api", "qwen3-max", "openai", "auto"), "auto");
  assert.equal(compatToSend("api", "qwen3-max", "openai", "on"), "on");
});

function pick(p) { return [p.on, p.locked]; }
