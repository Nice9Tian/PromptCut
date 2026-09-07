import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { resolveCli, cliCommand } from "./runners/cli-runtime.mjs";

export interface CodexLaunch {
  kind: string;
  detail: string;
  autoSend: "sent" | "error" | "skipped";
  status: "launching" | "ready" | "failed";
  projectId?: string | null;
  workspaceMode?: "projectless";
  threadId?: string;
  cwd?: string;
  initialState?: "dispatching" | "completed";
}

/** Explicitly create a projectless task with its own workspace.
 * The running desktop caches local projects and does not import projects created
 * by another app-server. A projectless task avoids that cache entirely.
 * No state-file edits and no desktop process termination.
 */
export async function createCodexTask(
  dir: string,
  prompt: string,
  previous: Partial<CodexLaunch> | undefined,
  report: (launch: CodexLaunch) => void,
): Promise<CodexLaunch> {
  const launch: CodexLaunch = {
    kind: "codex-app-server-projectless", detail: "正在连接 Codex app-server", autoSend: "skipped",
    status: "launching", cwd: dir, projectId: null, workspaceMode: "projectless", threadId: previous?.threadId,
    initialState: previous?.initialState,
  };
  // Reuse executable discovery, but NOT cliEnv('codex'): that uses PromptCut's
  // private CLI home rather than the desktop's history and authentication.
  const invocation = cliCommand(process.env.PROMPTCUT_CODEX_EXE || resolveCli("codex"), ["app-server", "--stdio"]);
  if (process.platform === "win32" && invocation.command === "powershell.exe") {
    invocation.args.unshift("-NonInteractive", "-WindowStyle", "Hidden");
  }
  const child = spawn(invocation.command, invocation.args, {
    cwd: dir, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  let seq = 0;
  let closed: Error | undefined;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  let finishTurn: ((error?: Error) => void) | undefined;
  const fail = (error: Error) => {
    closed = error;
    for (const p of pending.values()) p.reject(error);
    pending.clear();
    finishTurn?.(error);
  };
  child.on("error", fail);
  child.on("exit", code => fail(new Error(`Codex app-server 退出 (${code})`)));
  child.stdin.on("error", fail);
  // Drain stderr; protocol errors are reported through stdout, not arbitrary logs.
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => {
    let m: any;
    try { m = JSON.parse(line); } catch { return; }
    if (m.method && m.id != null) {
      // A background launcher cannot answer an approval or user-input request.
      child.stdin.write(JSON.stringify({ id: m.id, error: { code: -32603, message: "PromptCut cannot answer interactive requests" } }) + "\n");
      fail(new Error(`Codex 需要交互: ${m.method}`));
    } else if (m.id != null) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p?.reject(new Error(m.error.message));
      else p?.resolve(m.result);
    } else if (m.method === "turn/completed" && m.params?.threadId === launch.threadId) {
      const turn = m.params.turn;
      finishTurn?.(turn.status === "completed" ? undefined : new Error(turn.error?.message || `Codex 回合 ${turn.status}`));
    }
  });
  const rpc = (method: string, params: unknown): Promise<any> => new Promise((resolve, reject) => {
    if (closed) return reject(closed);
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} 超时`)); }, 30000);
    pending.set(id, {
      resolve: value => { clearTimeout(timer); resolve(value); },
      reject: error => { clearTimeout(timer); reject(error); },
    });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
  /**
   * 读线程,但把「还没有落盘记录」当成读不到而不是失败。
   *
   * 刚 thread/start 出来、一轮都还没跑过的线程没有 rollout,这时 thread/read 会报
   * `no rollout found for thread id …`。那不是错误,只是还没东西可读 —— 早先把它当
   * 失败,于是每次新建任务都在「发指令之前校验」这一步挂掉。
   */
  const readThreadIfAny = async (threadId: string) => {
    try {
      return (await rpc("thread/read", { threadId, includeTurns: false })).thread;
    } catch (error) {
      if (/no rollout found/i.test(error instanceof Error ? error.message : String(error))) return null;
      throw error;
    }
  };
  try {
    report({ ...launch });
    await rpc("initialize", { clientInfo: { name: "promptcut", version: "0.2.9" }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
    let thread;
    if (!launch.threadId) {
      /*
       * 建**不挂项目**的线程,工作区就是任务目录。
       *
       * 试过给任务目录 project/create 再挂上去(`roots: [ProjectRoot]`,接口是通的),
       * 但没用:**运行中的桌面版缓存自己的本地项目列表,不会导入别的 app-server 建出来的
       * 项目** —— 侧栏里根本看不见,等于白建。projectless 绕开这套缓存,线程照样不会落进
       * 用户当前选中的那个项目里(那才是要解决的问题)。
       */
      ({ thread } = await rpc("thread/start", { cwd: dir, runtimeWorkspaceRoots: [dir], projectId: null, ephemeral: false, historyMode: "legacy" }));
      launch.threadId = thread.id;
      report({ ...launch, detail: "独立线程已创建，正在校验工作区和无项目归属" });
    } else {
      thread = await readThreadIfAny(launch.threadId);
      if (!thread) throw new Error("Codex 线程还没有任何记录，无法确认身份；请重新开始一个任务");
    }
    // 校验用 thread/start 当场返回的那个对象,不再多读一次 —— 刚建的线程没有 rollout,
    // 读了必然报 `no rollout found`,早先每次新建任务都挂在这一步
    if (thread.projectId !== null || !samePath(thread.cwd, dir)) {
      throw new Error("Codex 线程项目或工作区校验失败，未发送指令");
    }
    // Relaunch opens the same task; never duplicate a possibly delivered turn.
    if (launch.initialState === "dispatching") throw new Error("先前环境检查已提交或结果未确认，未重复发送，请在 Codex 中查看");
    let turnError: Error | undefined;
    if (launch.initialState !== "completed") {
      if (previous?.threadId) await rpc("thread/resume", { threadId: launch.threadId });
      launch.detail = "无项目归属及任务目录已确认，正在自动发送并执行环境检查";
      launch.initialState = "dispatching";
      report({ ...launch });
      let timer: ReturnType<typeof setTimeout>;
      let timedOut = false;
      const completed = new Promise<void>((resolve, reject) => {
        finishTurn = error => { clearTimeout(timer); error ? reject(error) : resolve(); };
        timer = setTimeout(() => { timedOut = true; reject(new Error("Codex 环境检查 180 秒内未完成")); }, 180000);
      });
      // Attach rejection handling before starting the request (notifications may arrive first).
      const started = rpc("turn/start", { threadId: launch.threadId, input: [{ type: "text", text: prompt }] });
      try {
        await Promise.all([started, completed]);
        launch.initialState = "completed";
      } catch (error) {
        /*
         * 指令没送出去(账号没额度、模型报错都算)。**线程已经建好了**,不该因为这一步
         * 就把它一起当失败丢掉 —— 用户在 Codex 里能找到那条线程,自己说一句就能接着干。
         * 所以下面照样给它命名,并在 detail 里说清楚线程还在。
         *
         * initialState 保持 dispatching,**不因为失败就清掉**:失败可能来自 rpc 直接
         * 拒绝(没送到,重发是安全的),也可能来自 turn/completed 通知说这一轮跑挂了
         * (那是**已经送到并且跑过**,重发就是发第二遍)。两者在这里分不出来,
         * 所以一律不自动重发,让用户去看那条线程。
         */
        turnError = error instanceof Error ? error : new Error(String(error));
        void timedOut;
      } finally {
        clearTimeout(timer!);
        finishTurn = undefined;
      }
    }
    await rpc("thread/metadata/update", { threadId: launch.threadId, projectId: "" });
    await rpc("thread/name/set", { threadId: launch.threadId, name: `PromptCut Skill · ${path.basename(dir)}` });
    // 跑过一轮才有 rollout;没跑过就读不到,那不算校验失败
    const persisted = await readThreadIfAny(launch.threadId);
    if (persisted && (persisted.projectId !== null || !samePath(persisted.cwd, dir))) {
      throw new Error("Codex 持久化工作区或无项目归属校验失败");
    }
    if (turnError) {
      return {
        ...launch,
        autoSend: "error",
        status: "failed",
        detail: `独立线程已经建好（工作区就是任务目录），但指令没发出去：${turnError.message}。到 Codex 里找那条线程说一句就能接着干。`,
      };
    }
    return { ...launch, autoSend: "sent", status: "ready", detail: "已创建不在项目中的独立任务，工作区为任务目录，环境检查指令已执行" };
  } catch (error) {
    return { ...launch, status: "failed", autoSend: "error", detail: error instanceof Error ? error.message : String(error) };
  } finally {
    lines.close();
    child.stdin.end();
    child.kill(); // Only our private app-server, never the desktop app.
  }
}

function samePath(a: string, b: string) {
  const normalize = (p: string) => path.resolve(p).replace(/\\/g, "/").replace(/\/$/, "");
  return process.platform === "win32" ? normalize(a).toLowerCase() === normalize(b).toLowerCase() : normalize(a) === normalize(b);
}
