import type { Plugin, ViteDevServer } from "vite";
import type { ServerResponse, IncomingMessage } from "node:http";
import fs from "node:fs";
import path from "node:path";

/**
 * SKILL 模式的开关接口,外加 .proc 的独占锁。
 *
 * 单独一个插件而不是并进 vite-plugin-skill.ts:那个文件另一个会话正在改(Codex 深链那条线),
 * 往同一个文件里加东西两边都容易被覆盖。这里的东西也确实是另一件事 —— 那边管「怎么把任务
 * 交出去」,这边管「交出去期间谁说了算」。
 *
 * 三组接口:
 *   GET  /api/skill-mode          现在是不是 SKILL 模式(前端每秒问一次,Rust 壳直接读文件)
 *   POST /api/skill-mode/open     开(Skill 任务起来时)
 *   POST /api/skill-mode/close    关(用户点「关闭 SKILL 模式」)
 *   POST /api/skill-lock/acquire   .proc 独占锁:非 SKILL 模式打开项目时抢
 *   POST /api/skill-lock/release   放锁
 */

function sendJson(res: ServerResponse, code: number, data: unknown) {
  if (res.headersSent) return;
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 1024 * 1024) {
        req.destroy();
        reject(new Error("请求太大"));
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", () => reject(new Error("读取请求体失败")));
  });
}

interface LockFile {
  pid: number;
  at: string;
  /** 谁占的,给冲突提示用 */
  host: string;
}

function lockPathFor(procPath: string): string {
  return procPath + ".lock";
}

function pidAlive(pid: number): boolean {
  if (!pid || pid === process.pid) return pid === process.pid;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 抢一份 .proc 的独占锁。
 *
 * 为什么要独占:两个 PromptCut 同时开着同一个 .proc,各自按自己内存里的状态往回写,
 * 后写的把先写的整份盖掉 —— 不是合并,是丢。所以非 SKILL 模式下一个文件只许一个实例写。
 *
 * **SKILL 模式下不加锁**,这是有意的:那时候无头实例在写 job 的 project.proc,而 Rust 壳
 * 和用户那份都要读它来更新状态。加了独占就读不了了。丢改动的风险由「只有 agent 一个人写」
 * 来保证 —— 用户那份在 Skill 模式下是锁住的,不会同时往同一个文件写。
 *
 * # 两层判据,顺序不能反
 *
 * 锁是旁路文件 `<name>.proc.lock`(**不是 .proc 本体** —— 实测独占本体之后 Node 连读都读
 * 不了,等于把自己人挡在门外)。判「有没有人占着」按可靠性从高到低试:
 *
 * 1. **内核说的**:`open(lock,'r+')` 拿到 EBUSY,说明有进程正用共享模式 0 握着这个句柄
 *    (桌面版里是 Rust 外壳干的,见 desktop/src-tauri/src/proc_lock.rs)。这个信号最硬 ——
 *    持有者一死内核立刻收走句柄,不存在死锁,也不用判活。
 * 2. **锁文件里的 pid**:没有外壳的时候(开发期 `npm run dev`、浏览器里跑)只能退到这条。
 *    弱在两处:持有者被强杀会留下死锁文件;pid 会被系统回收,死进程的号被新进程占了就
 *    误判成「还有人占着」。所以它只是兜底,能用第 1 条就不用它。
 *
 * 创建用 `open(path,'wx')` 而不是「先 existsSync 再写」—— 后者不是原子的,两个实例能同时
 * 通过检查然后都以为自己拿到了锁。wx 是原子的(实测 20 个进程并发抢,恰好 1 个赢)。
 */
function acquireLock(procPath: string): { ok: boolean; error?: string; stolen?: boolean; by?: "kernel" | "pid" } {
  const file = lockPathFor(procPath);
  const mine = JSON.stringify({ pid: process.pid, at: new Date().toISOString(), host: "promptcut" });
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 原子创建。抢到了就是我的,不用再看任何东西
    try {
      fs.writeFileSync(file, mine, { flag: "wx" });
      return { ok: true };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }

    // 文件已经在了。先问内核:有没有人正握着它的句柄
    try {
      fs.closeSync(fs.openSync(file, "r+"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EBUSY") {
        return { ok: false, by: "kernel", error: "这个项目文件正被另一个 PromptCut 打开" };
      }
      // 别的错(权限之类)当作拿不到锁,但说清楚原因
      return { ok: false, error: `锁文件读不了:${(e as Error).message}` };
    }

    // 没人握句柄,退到 pid 那条弱判据
    const cur = JSON.parse(fs.readFileSync(file, "utf8")) as LockFile;
    if (cur.pid === process.pid) return { ok: true };
    if (pidAlive(cur.pid)) {
      return { ok: false, by: "pid", error: `这个项目文件正被另一个 PromptCut 打开(进程 ${cur.pid},自 ${cur.at})` };
    }
    // 上一个持有者已经不在了(崩溃 / 强杀),接管
    fs.writeFileSync(file, mine, "utf8");
    return { ok: true, stolen: true };
  } catch (e) {
    // 锁写不出来(只读目录之类)不该把「打开项目」这件事整个挡掉
    return { ok: true, error: (e as Error).message };
  }
}

function releaseLock(procPath: string): void {
  const file = lockPathFor(procPath);
  try {
    const cur = JSON.parse(fs.readFileSync(file, "utf8")) as LockFile;
    if (cur.pid === process.pid) fs.unlinkSync(file);
  } catch {
    /* 没有锁、不是我的锁、或者外壳正握着它(删不掉),都不用管 */
  }
}

export function skillStatePlugin(): Plugin {
  return {
    name: "promptcut-skill-state",
    configureServer(server: ViteDevServer) {
      /** 本进程持有的锁,退出时一并放掉 */
      const held = new Set<string>();
      const releaseAll = () => {
        for (const p of held) releaseLock(p);
        held.clear();
      };
      server.httpServer?.on("close", releaseAll);
      process.on("exit", releaseAll);

      server.middlewares.use("/api/skill-mode", async (req, res) => {
        const url = new URL(req.url || "/", "http://localhost");
        const action = url.pathname.replace(/^\/+/, "");
        try {
          const gate = await import(new URL("./skill-gate.mjs", import.meta.url).href);
          if (!action && req.method === "GET") {
            const state = gate.readState();
            // 顺带把 agent 那边的进度报回去:壳和面板都想显示「改到哪了」
            let proc: { updatedAt: string; clips: number } | null = null;
            if (state.procPath && fs.existsSync(state.procPath)) {
              try {
                const doc = JSON.parse(fs.readFileSync(state.procPath, "utf8"));
                const tracks = doc?.project?.tracks ?? [];
                proc = {
                  updatedAt: fs.statSync(state.procPath).mtime.toISOString(),
                  clips: tracks.reduce((n: number, t: { clips?: unknown[] }) => n + (t.clips?.length ?? 0), 0),
                };
              } catch { /* 正在写到一半,下一秒再问 */ }
            }
            return sendJson(res, 200, { ok: true, state, proc });
          }
          if (action === "open" && req.method === "POST") {
            const body = JSON.parse((await readBody(req)) || "{}");
            return sendJson(res, 200, { ok: true, state: gate.openGate(body) });
          }
          if (action === "close" && req.method === "POST") {
            const body = JSON.parse((await readBody(req)) || "{}");
            return sendJson(res, 200, { ok: true, state: gate.closeGate(body.by || "user") });
          }
          return sendJson(res, 404, { ok: false, error: "没有这个接口" });
        } catch (e) {
          return sendJson(res, 400, { ok: false, error: (e as Error).message });
        }
      });

      server.middlewares.use("/api/skill-lock", async (req, res) => {
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "POST only" });
        const url = new URL(req.url || "/", "http://localhost");
        const action = url.pathname.replace(/^\/+/, "");
        try {
          const body = JSON.parse((await readBody(req)) || "{}");
          /*
           * 前端手里通常只有草稿 id(路径规则在服务端,而且可以被 PROMPTCUT_PROJECTS_DIR
           * 改掉),所以这里两种都收:draftId 由 projects 插件解析成真实路径,path 留给
           * 已经知道绝对路径的调用方。
           */
          let raw = body.path;
          if (!raw && body.draftId) {
            const { draftFileFor } = await import(new URL("./vite-plugin-projects.ts", import.meta.url).href);
            raw = draftFileFor(server.config.root || process.cwd(), String(body.draftId));
            if (!raw) return sendJson(res, 400, { ok: false, error: "草稿 id 不合法" });
          }
          if (!raw) return sendJson(res, 400, { ok: false, error: "path 或 draftId 必填" });
          const target = path.resolve(String(raw));
          if (action === "acquire") {
            const gate = await import(new URL("./skill-gate.mjs", import.meta.url).href);
            // SKILL 模式下不加锁 —— 壳和用户那份都要读无头实例正在写的那个文件
            if (gate.readState().active) return sendJson(res, 200, { ok: true, skipped: "skill-mode" });
            const out = acquireLock(target);
            if (out.ok) held.add(target);
            // 把解析出的真实路径回给前端:桌面壳那层要拿它去独占内核句柄
            return sendJson(res, out.ok ? 200 : 409, { ...out, file: target });
          }
          if (action === "release") {
            releaseLock(target);
            held.delete(target);
            return sendJson(res, 200, { ok: true });
          }
          return sendJson(res, 404, { ok: false, error: "没有这个接口" });
        } catch (e) {
          return sendJson(res, 400, { ok: false, error: (e as Error).message });
        }
      });
    },
  };
}

export default skillStatePlugin;
