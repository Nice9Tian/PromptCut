/**
 * 分工模式的编排器：把一句要求拆成多个角色任务，能并行的并行跑。
 *
 * 三步，都走 /api/ai/plan（无工具、无历史的最小补全）：
 *   1. 制片主管出计划——散文，讲清怎么拆、为什么这些能并行
 *   2. 依据计划划依赖关系
 *   3. 落成 JSON：每个任务配一个已有角色
 * 然后按拓扑分层，一层之内并发跑。
 *
 * 为什么编排阶段不走 /api/ai/chat：那条路带 30 个工具的 schema 和整段历史，
 * 而这三步一个工具都不用。分工模式的全部意义是省时间，编排本身不能太贵。
 *
 * 为什么要有入口闸（triage.ts）：不然「现在几点了」也要走这三步，
 * 一个为了提速的功能反而更慢。
 */
import { ALL_ROLES, resolveModelFor, type Role } from "./roles";
import { topoWaves, extractJson, normalizeTasks, type OrchestrationTask } from "./orchestrateGraph";

export { topoWaves, normalizeTasks, type OrchestrationTask };

export interface OrchestrationPlan {
  /** 第一步：主管的散文计划，界面折叠里显示 */
  plan: string;
  /** 第二步：依赖关系的说明 */
  dag: string;
  /** 第三步：机器可读的分工 */
  tasks: OrchestrationTask[];
  /** 拓扑分层结果，每一层内部可并发 */
  waves: OrchestrationTask[][];
}

async function planCall(system: string, prompt: string, maxTokens = 1500): Promise<string> {
  const r = await fetch("/api/ai/plan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ system, prompt, maxTokens }),
    signal: AbortSignal.timeout(90000),
  });
  const d = await r.json().catch(() => ({}));
  if (!d.ok) throw new Error(d.error || "编排调用失败");
  return String(d.text ?? "");
}

/** 角色清单，给提示词用。带上 capability，主管好知道谁擅长什么。 */
function roleRoster(roles: Role[]): string {
  return roles
    .map((r) => `- ${r.id}（${r.name}，能力档位：${r.capability}）：${r.prompt.split("\n")[0].slice(0, 60)}`)
    .join("\n");
}




/** 三步编排。roles 默认用全部角色，manager 自己不参与执行。 */
export async function buildPlan(
  query: string,
  opts: { roles?: Role[]; managerPrompt: string } = { managerPrompt: "" },
): Promise<OrchestrationPlan> {
  const all = opts.roles ?? ALL_ROLES;
  const workers = all.filter((r) => r.id !== "manager");
  const roster = roleRoster(workers);

  // 第一步：出计划
  const plan = await planCall(
    opts.managerPrompt,
    `可用角色：\n${roster}\n\n用户这次的要求：\n${query}`,
    1200,
  );

  // 第二步：划依赖
  const dag = await planCall(
    "你在帮一条流水线确定任务之间的先后关系。只有「B 必须拿到 A 的产出才能开始」才算依赖。"
      + "「先做 A 比较顺手」不算——那只会把本来能并行的活人为串起来。",
    `这是拆解方案：\n${plan}\n\n请逐个任务说明它依赖哪些任务、为什么。`
      + `没有依赖的要明确写「无依赖，可与其他任务同时进行」。`,
    900,
  );

  // 第三步：落成 JSON
  const jsonText = await planCall(
    "你把方案转成 JSON。只输出 JSON，不要任何解释文字。",
    `拆解方案：\n${plan}\n\n依赖关系：\n${dag}\n\n可用角色 id：${workers.map((r) => r.id).join(", ")}\n\n`
      + `输出形如：\n`
      + `{"tasks":[{"id":"1","roleId":"director","instruction":"具体要做什么","dependsOn":[]},`
      + `{"id":"2","roleId":"fx-assistant","instruction":"...","dependsOn":["1"]}]}\n\n`
      + `roleId 必须是上面列出的 id 之一。dependsOn 只填真正的数据依赖。`,
    1500,
  );

  const tasks = normalizeTasks(extractJson(jsonText), workers);
  return { plan, dag, tasks, waves: topoWaves(tasks) };
}

/** 每个任务实际要发给模型的提示词：角色卡 + 这次的具体指令 */
export function promptForTask(task: OrchestrationTask, roles: Role[] = ALL_ROLES): string {
  const role = roles.find((r) => r.id === task.roleId);
  const head = role ? role.prompt : "";
  return `${head}\n\n本次你负责的具体任务：\n${task.instruction}`;
}

/** 这个任务该用哪个 provider。现在恒为 null（用用户选的那个），接口先留着。 */
export function providerForTask(task: OrchestrationTask, roles: Role[] = ALL_ROLES): string | null {
  const role = roles.find((r) => r.id === task.roleId);
  return role ? resolveModelFor(role.capability) : null;
}
