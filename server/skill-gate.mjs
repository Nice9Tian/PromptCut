/**
 * SKILL 模式的开关与闸门。
 *
 * 一句话:**SKILL 变量为假时,无头实例的任何操作都不许落地**,只回一句话告诉它模式已关。
 *
 * 为什么需要:进了 Skill 模式,用户手里这份 PromptCut 的 AI 面板被锁住,活交给无头实例上的
 * agent 去干。用户随时可能点「关闭 SKILL 模式」收回控制权 —— 但 agent 那边可能正跑在半路,
 * 它不知道用户已经收工了。没有这道闸,它会继续往项目里写东西,用户眼睁睁看着自己刚拿回来的
 * 项目又被改。所以闸门在**执行工具之前**拦,不是执行完再回滚。
 *
 * 状态存哪:一个固定路径的 JSON,不是某个 .proc 里的字段。三个进程要读同一份状态 ——
 * 用户那份 PromptCut、无头实例、还有 Rust 壳(它是另一个进程,读不到网页里的东西)——
 * 固定路径是唯一都能约定的地方。它和 Skill 任务目录同一个根:
 *   1. 那个根在 Documents 下,**不会被 MSIX 容器虚拟化**(%LOCALAPPDATA% 会,踩过);
 *   2. 用户自己也能打开看。
 * .proc 里另外存一份 skill 字段,那是**给项目本身留的痕迹**(这份编排是不是 Skill 改过的),
 * 不是运行时状态,别拿它当真相源。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 和 vite-plugin-skill.ts 的 jobsRoot 用同一个环境变量,两边指向同一个根 */
export function skillRoot() {
  return process.env.PROMPTCUT_SKILL_DIR || path.join(os.homedir(), "Documents", "PromptCut-Skill");
}

export function statePath() {
  return path.join(skillRoot(), "skill-state.json");
}

/**
 * @typedef {object} SkillState
 * @property {boolean} active      SKILL 模式开着没有
 * @property {string|null} jobId   哪个任务
 * @property {string|null} jobDir  任务目录
 * @property {string|null} procPath 无头实例正在写的 project.proc(壳监听它)
 * @property {string|null} since   什么时候开的
 * @property {string|null} closedAt 什么时候关的
 * @property {string|null} closedBy 谁关的:user / job-stopped
 */

/** 关着的状态。读不到文件、文件坏了,都按「关着」处理 —— 默认拒绝比默认放行安全 */
function closed() {
  return { active: false, jobId: null, jobDir: null, procPath: null, since: null, closedAt: null, closedBy: null };
}

export function readState() {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(), "utf8"));
    return { ...closed(), ...raw, active: raw.active === true };
  } catch {
    return closed();
  }
}

export function writeState(patch) {
  const next = { ...readState(), ...patch };
  const file = statePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 先写临时文件再改名:壳每秒都在读它,直接覆盖有可能被读到写了一半的内容
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8");
  fs.renameSync(tmp, file);
  return next;
}

/**
 * 开闸。
 *
 * **无头实例不许开** —— 它是被管的一方,不是管人的一方。少了这道拦截会出真事:
 * 前端那套「有活着的任务就自动开闸」的逻辑在无头实例的页面里也在跑,用户刚点了
 * 「关闭 SKILL 模式」,它下一秒就把闸打开、接着往项目里写(实测复现)。
 * 前端那边已经按 ?headless=1 跳过了,这里再堵一道:开关只能由用户那一侧动。
 */
export function openGate({ jobId, jobDir, procPath }) {
  if (process.env.PROMPTCUT_HEADLESS === "1") {
    return { ...readState(), refused: "无头实例不能自己打开 SKILL 模式" };
  }
  return writeState({
    active: true,
    jobId: jobId ?? null,
    jobDir: jobDir ?? null,
    procPath: procPath ?? null,
    since: new Date().toISOString(),
    closedAt: null,
    closedBy: null,
  });
}

export function closeGate(by = "user") {
  return writeState({ active: false, closedAt: new Date().toISOString(), closedBy: by });
}

/**
 * 拒绝时给 agent 的那段话。
 *
 * 写成一段能读懂的说明而不是干巴巴一个 false:收到它的是模型,它得知道
 * 「不是我调错了参数,是人把开关关了」,以及接下来该干什么(收尾、别重试)。
 * 反复重试同一个工具是这类拦截最常见的失败模式。
 */
export function gateMessage(tool) {
  return [
    "SKILL 模式已经关闭,无法操作。",
    "",
    `用户已经在 PromptCut 里点了「关闭 SKILL 模式」,收回了对项目的控制权,所以 \`${tool}\` 没有执行,项目**没有**任何改动。`,
    "",
    "接下来请这样做:",
    "1. **不要重试**这个工具,也不要换个工具再试 —— 现在所有工具调用都会被同样拦下,包括只读的;",
    "2. 把你已经做完的部分总结给用户(改了什么、还差什么);",
    "3. 告诉用户:想继续的话,在 PromptCut 里重新进入 Skill 模式,然后回来跟你说一声。",
  ].join("\n");
}

/**
 * 这次工具调用放不放行。
 *
 * 只在**无头实例**上拦(PROMPTCUT_HEADLESS=1)。用户自己那份 PromptCut 不受这道闸影响 ——
 * 它的 AI 面板是前端锁的,而且用户本来就有权在自己的项目上做任何事;把用户也拦了,
 * 关掉 Skill 模式之后他自己的 AI 助手反而用不了了。
 */
export function checkGate(tool) {
  if (process.env.PROMPTCUT_HEADLESS !== "1") return { ok: true };
  const state = readState();
  if (state.active) return { ok: true };
  return { ok: false, message: gateMessage(tool) };
}
