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

export type TaskStatus = "pending" | "running" | "done" | "error";

/** 一个任务的运行时状态。界面按它渲染每个角色气泡的进度。 */
export interface TaskRun {
  task: OrchestrationTask;
  status: TaskStatus;
  /** 这个任务产生的那条消息的 id，界面据此把气泡和任务对上 */
  messageId?: string;
  /**
   * 自己没跑，是因为上游失败被跳过的。
   *
   * status 同为 error，但两者对用户的含义完全不同：失败要看原因，跳过只是
   * 连带。界面**用这个字段区分，别去匹配 error 里的文案** —— 那句话是给人
   * 读的，改个措辞就会让判断静默失效。
   */
  skipped?: boolean;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}

/**
 * 整次编排的状态。这是界面唯一需要读的东西。
 *
 * plan / dag / tasks 三段都留着而不是只留最终结果：界面要把它们放进
 * 默认折叠的块里。分工分错的时候，用户得能展开看是哪一步判断错了——
 * 全隐藏的话只能看着结果猜。
 */
export interface OrchestrationState {
  phase: "planning" | "running" | "done" | "error" | "cancelled";
  /** 用户原始的那句话 */
  query: string;
  /** 第一步：主管的散文计划 */
  plan: string;
  /** 第二步：依赖关系说明 */
  dag: string;
  /** 第三步的产物，带运行时状态 */
  tasks: TaskRun[];
  /** 拓扑分层，元素是任务 id。界面想显示「第几批」时用得上 */
  waves: string[][];
  error?: string;
}

/**
 * 界面注入的「怎么真的把一个任务发出去」。
 *
 * 编排器不碰 send()、不碰 messages —— 那是界面的地盘。这里只负责按 DAG
 * 决定谁什么时候能跑，具体怎么发、气泡怎么建，由调用方实现这个函数。
 * 返回这条任务对应的消息 id（可选），好让界面把气泡和任务对上。
 */
export type TaskExecutor = (
  task: OrchestrationTask,
  prompt: string,
  provider: string | null,
) => Promise<string | void>;


/**
 * 按 DAG 跑完整个计划。同一层里的任务用 Promise.all 并发。
 *
 * 失败不连坐：一个任务挂了，同层的其他任务照跑完（它们本来就互不依赖）。
 * 但**依赖它的后续任务会被跳过**并标成 error —— 拿着上游没产出的东西往下做，
 * 只会产生一堆看起来完成了、其实建立在空气上的结果。
 *
 * 每次状态变化都回调 onUpdate，界面据此实时更新气泡。
 */
export async function runOrchestration(
  plan: { plan: string; dag: string; tasks: OrchestrationTask[]; waves: OrchestrationTask[][] },
  query: string,
  exec: TaskExecutor,
  onUpdate: (state: OrchestrationState) => void,
  signal: AbortSignal | undefined,
  /**
   * 角色相关的两件事由调用方注入，本模块不 import roles ——
   * roles/index.ts 用了 vite 专有的 import.meta.glob，一旦引进来，
   * 这个模块就没法用 node 直接跑单测了，而并发调度恰恰最该测。
   */
  deps: {
    promptFor: (t: OrchestrationTask) => string;
    providerFor: (t: OrchestrationTask) => string | null;
  },
): Promise<OrchestrationState> {
  const state: OrchestrationState = {
    phase: "running",
    query,
    plan: plan.plan,
    dag: plan.dag,
    tasks: plan.tasks.map((task) => ({ task, status: "pending" as TaskStatus })),
    waves: plan.waves.map((w) => w.map((t) => t.id)),
  };
  const byId = new Map(state.tasks.map((r) => [r.task.id, r]));
  const push = () => onUpdate({ ...state, tasks: state.tasks.map((t) => ({ ...t })) });
  push();

  const failed = new Set<string>();

  for (const wave of plan.waves) {
    if (signal?.aborted) {
      state.phase = "cancelled";
      for (const r of state.tasks) if (r.status === "pending") r.status = "error", (r.error = "已取消");
      push();
      return state;
    }

    await Promise.all(
      wave.map(async (task) => {
        const run = byId.get(task.id)!;

        // 上游挂了就别跑：基于空气的产出比没有产出更糟
        const blocked = task.dependsOn.filter((d) => failed.has(d));
        if (blocked.length > 0) {
          run.status = "error";
          run.skipped = true;
          run.error = `依赖的任务 ${blocked.join("、")} 没成功，跳过`;
          failed.add(task.id);
          push();
          return;
        }

        run.status = "running";
        run.startedAt = Date.now();
        push();
        try {
          const messageId = await exec(task, deps.promptFor(task), deps.providerFor(task));
          if (typeof messageId === "string") run.messageId = messageId;
          run.status = "done";
        } catch (e) {
          run.status = "error";
          run.error = e instanceof Error ? e.message : String(e);
          failed.add(task.id);
        } finally {
          run.finishedAt = Date.now();
          push();
        }
      }),
    );
  }

  state.phase = state.tasks.every((t) => t.status === "done") ? "done" : "error";
  push();
  return state;
}

