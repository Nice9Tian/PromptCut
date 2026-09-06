/**
 * 编排里的纯逻辑：拓扑分层、抠 JSON、归一任务。
 *
 * 单独成一个模块是为了能**直接用 node 跑单测**——orchestrate.ts 依赖
 * roles/index.ts，那里用了 vite 专有的 import.meta.glob，node 里跑不起来。
 * 而这三个函数恰恰是最容易出错的部分：它们处理的是模型生成的 JSON，
 * 环、指向不存在的任务、瞎编的角色名都是常态而不是异常。
 */
import type { Role } from "./roles";

export interface OrchestrationTask {
  /** 任务号，DAG 里靠它表示依赖 */
  id: string;
  /** 落到哪个已有角色上 */
  roleId: string;
  /** 交给这个角色的具体指令 */
  instruction: string;
  /** 必须先完成的任务号 */
  dependsOn: string[];
}

/**
 * 把任务按依赖拓扑分层。同一层里的任务互不依赖，可以并发。
 *
 * 环、指向不存在任务的依赖、自依赖都要处理掉而不是抛错：这些边是模型写出来的，
 * 出错是常态。遇到解不开的环就把剩下的全塞进最后一层串行跑——宁可慢，
 * 不能卡死或者悄悄丢任务。
 */
export function topoWaves(tasks: OrchestrationTask[]): OrchestrationTask[][] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  // 只保留指向真实任务的依赖，并去掉自依赖
  const deps = new Map(
    tasks.map((t) => [t.id, new Set(t.dependsOn.filter((d) => d !== t.id && byId.has(d)))]),
  );
  const waves: OrchestrationTask[][] = [];
  const done = new Set<string>();

  while (done.size < tasks.length) {
    const ready = tasks.filter(
      (t) => !done.has(t.id) && [...(deps.get(t.id) ?? [])].every((d) => done.has(d)),
    );
    if (ready.length === 0) {
      // 剩下的互相成环。挑不出能先跑的，就按原顺序串行跑完，别卡死。
      waves.push(tasks.filter((t) => !done.has(t.id)));
      break;
    }
    waves.push(ready);
    for (const t of ready) done.add(t.id);
  }
  return waves;
}

/** 从模型输出里抠出 JSON。它常常裹在 ``` 里或者前后带解释。 */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = (fenced ? fenced[1] : text).trim();
  // 退一步：从第一个 { 或 [ 找到最后一个配对的括号
  const start = raw.search(/[[{]/);
  if (start < 0) throw new Error("模型没有返回 JSON");
  const end = Math.max(raw.lastIndexOf("]"), raw.lastIndexOf("}"));
  return JSON.parse(raw.slice(start, end + 1));
}

/** 把模型给的 JSON 归一成任务数组，顺手挡掉不存在的角色 */
export function normalizeTasks(parsed: unknown, roles: Role[]): OrchestrationTask[] {
  const arr = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { tasks?: unknown[] })?.tasks)
      ? (parsed as { tasks: unknown[] }).tasks
      : null;
  if (!arr) throw new Error("JSON 里没有任务数组");

  const known = new Set(roles.map((r) => r.id));
  const out: OrchestrationTask[] = [];
  arr.forEach((item, i) => {
    const o = (item ?? {}) as Record<string, unknown>;
    const id = String(o.id ?? o.task ?? i + 1);
    const roleId = String(o.roleId ?? o.role ?? "");
    const instruction = String(o.instruction ?? o.prompt ?? o.task ?? "").trim();
    if (!instruction) return;
    // 角色名瞎编的就落到第一个角色上，不要整批失败——宁可派错一个，
    // 也别让用户白等一轮编排然后看到一句「解析失败」。
    const role = known.has(roleId) ? roleId : roles[0]?.id;
    if (!role) return;
    const dependsOn = Array.isArray(o.dependsOn ?? o.deps)
      ? ((o.dependsOn ?? o.deps) as unknown[]).map(String)
      : [];
    out.push({ id, roleId: role, instruction, dependsOn });
  });
  if (out.length === 0) throw new Error("JSON 里没有可执行的任务");
  return out;
}
