/**
 * 编排过程的折叠块：一行摘要，点开看计划 / DAG / 分工。
 *
 * 用户定的是「默认折叠、可展开」，不是全隐藏也不是全展开：
 * - 全隐藏 → 分工分错了只能看着结果猜原因，这三步恰恰是最容易出错的地方
 * - 全展开 → 每次提问前面多出三大段机器对机器的内容，正经回复被埋掉
 *
 * 这里刻意不引入编排器的类型：那边还在写，类型定下来之前先按这个最小形状渲染，
 * 字段对不上也只是少显示一块，不会让整个面板炸掉。等对方把类型导出来再收紧。
 */
import { useState } from "react";
import { RoleAvatar } from "./RoleAvatar";
import "./OrchestrationBlock.css";

/** 一个被派出去的任务。字段尽量少——多的等编排器定了再加。 */
export interface OrchestratedTask {
  id?: string;
  roleId?: string;
  /** 这个任务要干什么 */
  title?: string;
  /** 依赖哪些任务的 id；空数组表示第一批就能开跑 */
  dependsOn?: string[];
  status?: "pending" | "running" | "done" | "error";
}

export interface OrchestrationInfo {
  /** manager 那一步的正文 */
  plan?: string;
  /** 划出来的任务 */
  tasks?: OrchestratedTask[];
  /** 第三步那份 JSON，原样留着好排查 */
  raw?: unknown;
  /** 编排本身失败了（不是某个任务失败） */
  error?: string;
}

const STATUS_TEXT: Record<string, string> = {
  pending: "等待",
  running: "进行中",
  done: "完成",
  error: "失败",
};

/** 按依赖关系分批：同一批里的任务互不依赖，可以同时跑 */
export function toWaves(tasks: OrchestratedTask[]): OrchestratedTask[][] {
  const waves: OrchestratedTask[][] = [];
  const done = new Set<string>();
  let rest = tasks.slice();
  // 最多迭代 tasks.length 轮：每轮至少排掉一个，排不掉就是有环
  for (let guard = 0; guard < tasks.length && rest.length > 0; guard++) {
    const ready = rest.filter((t) => (t.dependsOn ?? []).every((d) => done.has(d)));
    if (ready.length === 0) break; // 有环或依赖了不存在的 id，剩下的整体算作最后一批
    waves.push(ready);
    for (const t of ready) if (t.id) done.add(t.id);
    rest = rest.filter((t) => !ready.includes(t));
  }
  if (rest.length > 0) waves.push(rest);
  return waves;
}

export function OrchestrationBlock(props: { info: OrchestrationInfo }) {
  const [open, setOpen] = useState(false);
  const { info } = props;
  const tasks = info.tasks ?? [];
  const waves = toWaves(tasks);
  const parallel = Math.max(1, ...waves.map((w) => w.length));

  const summary = info.error
    ? "编排失败"
    : tasks.length === 0
      ? "正在拆解任务…"
      : `已拆成 ${tasks.length} 个任务，分 ${waves.length} 批跑${parallel > 1 ? `，最多 ${parallel} 个并行` : ""}`;

  return (
    <div className="pc-orch">
      <button
        className="pc-orch-summary"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="pc-orch-caret">{open ? "▾" : "▸"}</span>
        <span className={info.error ? "pc-orch-bad" : undefined}>{summary}</span>
      </button>

      {open && (
        <div className="pc-orch-body">
          {info.error && <div className="pc-orch-error">{info.error}</div>}

          {info.plan && (
            <section>
              <h4>制片主管的拆解</h4>
              <p className="pc-orch-plan">{info.plan}</p>
            </section>
          )}

          {waves.length > 0 && (
            <section>
              <h4>执行批次</h4>
              {waves.map((wave, i) => (
                <div key={i} className="pc-orch-wave">
                  <div className="pc-orch-wave-label">
                    第 {i + 1} 批{wave.length > 1 ? `（${wave.length} 个并行）` : ""}
                  </div>
                  {wave.map((t, j) => (
                    <div key={t.id ?? j} className="pc-orch-task">
                      <RoleAvatar roleId={t.roleId} size={16} />
                      <span className="pc-orch-task-title">{t.title ?? t.id ?? "(未命名任务)"}</span>
                      <span className={`pc-orch-status is-${t.status ?? "pending"}`}>
                        {STATUS_TEXT[t.status ?? "pending"]}
                      </span>
                    </div>
                  ))}
                </div>
              ))}
            </section>
          )}

          {info.raw !== undefined && (
            <details className="pc-orch-raw">
              <summary>原始分工 JSON</summary>
              <pre>{JSON.stringify(info.raw, null, 2)}</pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
