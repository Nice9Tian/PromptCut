/**
 * 编排过程的折叠块：一行摘要，点开看计划 / 依赖 / 批次 / 原始分工。
 *
 * 用户定的是「默认折叠、可展开」，不是全隐藏也不是全展开：
 * - 全隐藏 → 分工分错了只能看着结果猜原因，而这三步恰恰最容易出错
 * - 全展开 → 每次提问前面多出三大段机器对机器的内容，正经回复被埋掉
 *
 * 分批不在这里算：orchestrate 已经用 topoWaves 拓扑分好层并放在 state.waves 里。
 * 这边再实现一遍就是两份会各自漂移的逻辑——界面显示的并行关系和实际跑的
 * 并行关系对不上，是最难查的那种 bug。
 */
import { useState } from "react";
import type { OrchestrationState, TaskRun } from "../../ai/orchestrate";
import { RoleAvatar } from "./RoleAvatar";
import "./OrchestrationBlock.css";

const STATUS_TEXT: Record<string, string> = {
  pending: "等待",
  running: "进行中",
  done: "完成",
  error: "失败",
};

/**
 * 「自己失败」和「被上游连累」都是 status: "error"，但对用户是两件事：
 * 前者要看这条任务本身出了什么问题，后者根本没跑过、该去看它依赖的那个。
 *
 * 判据走 run.skipped 这个字段，不去匹配 error 里的文案 —— 那句话是给人读的，
 * 编排器哪天改个措辞，这里的判断就会静默失效，而且不报任何错。
 */
function isSkipped(run: TaskRun): boolean {
  return !!run.skipped;
}

const PHASE_TEXT: Record<string, string> = {
  planning: "正在拆解任务…",
  cancelled: "编排已取消",
};

function summarize(s: OrchestrationState): string {
  if (s.phase === "error") return "编排失败";
  if (PHASE_TEXT[s.phase]) return PHASE_TEXT[s.phase];
  const n = s.tasks.length;
  if (n === 0) return "没有拆出任务";
  const widest = Math.max(1, ...s.waves.map((w) => w.length));
  const done = s.tasks.filter((t) => t.status === "done").length;
  const errored = s.tasks.filter((t) => t.status === "error");
  const skipped = errored.filter(isSkipped).length;
  const failed = errored.length - skipped;
  const head = `已拆成 ${n} 个任务，分 ${s.waves.length} 批跑${widest > 1 ? `，最多 ${widest} 个并行` : ""}`;
  if (s.phase === "running") return `${head} · 完成 ${done}/${n}`;
  const tail = [
    failed > 0 ? `${failed} 个失败` : "",
    skipped > 0 ? `${skipped} 个因依赖未执行` : "",
  ].filter(Boolean).join("，");
  return tail ? `${head} · ${tail}` : head;
}

/** 一个任务一行：头像 + 指令 + 状态。失败时把原因跟在下面。 */
function TaskRow({ run }: { run: TaskRun }) {
  // != null 而不是真值判断：两个都是时间戳，0 是合法值（真值判断会把它当没有）。
  const secs = run.startedAt != null && run.finishedAt != null
    ? Math.round((run.finishedAt - run.startedAt) / 1000)
    : null;
  const skipped = isSkipped(run);
  return (
    <div className={`pc-orch-task${skipped ? " is-skipped" : ""}`}>
      <div className="pc-orch-task-line">
        <RoleAvatar roleId={run.task.roleId} size={16} />
        <span className="pc-orch-task-title" title={run.task.instruction}>
          {run.task.instruction}
        </span>
        {secs !== null && <span className="pc-orch-secs">{secs}s</span>}
        <span className={`pc-orch-status is-${skipped ? "skipped" : run.status}`}>
          {skipped ? "跳过" : STATUS_TEXT[run.status]}
        </span>
      </div>
      {run.error && (
        <div className={skipped ? "pc-orch-task-skipped" : "pc-orch-task-error"}>{run.error}</div>
      )}
    </div>
  );
}

export function OrchestrationBlock({ state }: { state: OrchestrationState }) {
  const [open, setOpen] = useState(false);
  const byId = new Map(state.tasks.map((t) => [t.task.id, t]));

  return (
    <div className="pc-orch">
      <button className="pc-orch-summary" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="pc-orch-caret">{open ? "▾" : "▸"}</span>
        {/* 拆解和执行期间转个圈:主管三步拆解要好几十秒,没有动静用户会以为卡死了 */}
        {(state.phase === "planning" || state.phase === "running") && <span className="ai-spinner" aria-hidden />}
        <span className={state.phase === "error" ? "pc-orch-bad" : undefined}>{summarize(state)}</span>
      </button>

      {open && (
        <div className="pc-orch-body">
          {state.error && <div className="pc-orch-error">{state.error}</div>}

          {state.plan && (
            <section>
              <h4>制片主管的拆解</h4>
              <p className="pc-orch-prose">{state.plan}</p>
            </section>
          )}

          {state.dag && (
            <section>
              <h4>依赖关系</h4>
              <p className="pc-orch-prose">{state.dag}</p>
            </section>
          )}

          {state.waves.length > 0 && (
            <section>
              <h4>执行批次</h4>
              {state.waves.map((wave, i) => (
                <div key={i} className="pc-orch-wave">
                  <div className="pc-orch-wave-label">
                    第 {i + 1} 批{wave.length > 1 ? `（${wave.length} 个并行）` : ""}
                  </div>
                  {wave.map((id) => {
                    const run = byId.get(id);
                    // 编排器给的 id 理论上都在 tasks 里；真对不上时显示 id 本身，
                    // 而不是整块不渲染——静默少一行比看得见的异常更难发现。
                    return run
                      ? <TaskRow key={id} run={run} />
                      : <div key={id} className="pc-orch-task-missing">{id}（找不到对应任务）</div>;
                  })}
                </div>
              ))}
            </section>
          )}

          <details className="pc-orch-raw">
            <summary>原始分工</summary>
            <pre>{JSON.stringify(state.tasks.map((t) => t.task), null, 2)}</pre>
          </details>
        </div>
      )}
    </div>
  );
}
