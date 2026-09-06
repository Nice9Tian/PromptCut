/**
 * 分工模式闸门的单测。跑：node --test src/ai/triage.test.mjs
 *
 * 这里防的是一个**静默失效**：闸门本身在没配 API 直连时永远不可用，
 * 而它一度直接返回「不编排」，于是勾上分工模式发多步请求，链路会一声不响地
 * 走回普通提问——界面上看不出任何区别，只有翻网络面板才发现少了三次
 * /api/ai/plan。本机端到端实测踩到过一次，所以这几条必须钉死。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { heuristicTriage, looseTriage } from "./triage.ts";

const 多步 = "把这三段采访视频分别加上字幕和动效，然后按顺序排到时间轴上，最后加个片头。";

test("多步请求：严格版就该放行，不该白问一次闸", () => {
  const v = heuristicTriage(多步);
  assert.equal(v?.parallel, true);
  assert.equal(v?.by, "heuristic");
});

test("「分别」「最后」算并列词", () => {
  // 早先的词表只有「并且|然后|同时|以及|接着|再给|还要|另外」，
  // 上面那句只数出 1 处，够不到 2 的门槛，于是掉进 LLM 闸 → 不可用 → 不编排。
  assert.equal(heuristicTriage("先分别处理，最后合起来导出成片")?.parallel, true);
});

test("短句和纯提问：不编排", () => {
  assert.equal(heuristicTriage("这个视频多长")?.parallel, false);
  assert.equal(heuristicTriage("为什么导出的画面是黑的")?.parallel, false);
});

test("拿不准的交给 LLM，不自己下结论", () => {
  assert.equal(heuristicTriage("帮我把第二个片段的音量调大一点"), null);
});

test("闸门不可用时，放宽版仍能认出多步请求", () => {
  // 只有 CLI 驱动（大多数用户）的时候走的就是这条路
  assert.equal(looseTriage("把片头换掉，然后重新导出一遍").parallel, true);
});

test("放宽版也不能把提问当成多步", () => {
  assert.equal(looseTriage("这个视频多长").parallel, false);
  assert.equal(looseTriage("然后呢").parallel, false); // 有并列词但太短
});
