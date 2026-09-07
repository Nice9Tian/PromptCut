import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { createPortal } from "react-dom";
import { serializeProc, currentProjectName } from "./io/proc";
import { applyCombine, summarizeCombine } from "./io/combineImport";
import { useStore } from "../store/project";
import "./SkillDialog.css";

/**
 * Skill 模式:把当前项目交给桌面版的 Claude Code / Codex 去改。
 *
 * 点「开始」→ 服务端快照项目、起一份无头实例、拉起桌面 app 的新对话;这里轮询任务状态,
 * 把每一步摆出来。agent 干完后回来点「合并结果」,三方合并并进当前项目。
 */

type Provider = "claude" | "codex";
type Phase = "snapshot" | "booting" | "launching" | "ready" | "failed" | "stopped";

interface Job {
  id: string;
  provider: Provider;
  name: string;
  createdAt: string;
  phase: Phase;
  error?: string;
  dir: string;
  alive: boolean;
  port: number | null;
  dirty: boolean | null;
  savedAt: string | null;
  clips: number | null;
  instanceError: string | null;
  procUpdatedAt: string | null;
  procUrl: string;
  launch?: { kind: string; detail: string; at: string; autoSend?: "sent" | "nofocus" | "error" | "skipped" };
}

const PROVIDERS: { id: Provider; name: string; desc: string }[] = [
  { id: "claude", name: "Claude Code", desc: "打开 Claude 桌面版的 Code 标签,新对话直接落在任务目录,输入框里预填好 /promptcut,按回车即可" },
  { id: "codex", name: "Codex", desc: "用 codex app 打开任务目录,再开一条新线程,输入框里预填好指令,按回车即可;流程写在 AGENTS.md 里" },
];

const STEPS: { phase: Phase; label: string }[] = [
  { phase: "snapshot", label: "快照当前项目" },
  { phase: "booting", label: "起一份无头实例(独立端口,不碰你手里这份)" },
  { phase: "launching", label: "写入说明文件,拉起桌面 app 的新对话" },
  // 深链只把 /promptcut 预填进输入框,不会替用户按回车 —— 实测 Claude 桌面版就是这个行为
  { phase: "ready", label: "就绪:桌面 app 已打开新对话" },
];

const ORDER: Phase[] = ["snapshot", "booting", "launching", "ready"];

async function api<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || (data as { ok?: boolean }).ok === false) {
    throw new Error((data as { error?: string }).error || `请求失败(${res.status})`);
  }
  return data as T;
}

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function SkillDialog(props: { open: boolean; onClose: () => void }): JSX.Element | null {
  const { open, onClose } = props;
  const dirty = useStore((s) => s.dirty);
  const [provider, setProvider] = useState<Provider>("claude");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const timer = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await api<{ jobs: Job[] }>("/api/skill/jobs");
      setJobs(data.jobs);
    } catch (e) {
      setMsg({ tone: "err", text: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  // 开着就每 1.5 秒刷一次:实例起来要几秒到几十秒,用户得看见进度在走
  useEffect(() => {
    if (!open) return;
    setMsg(null);
    void refresh();
    timer.current = window.setInterval(() => void refresh(), 1500);
    return () => {
      if (timer.current) window.clearInterval(timer.current);
    };
  }, [open, refresh]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const job = jobs.find((j) => j.id === current) ?? null;

  const run = async (what: string, fn: () => Promise<string | void>) => {
    setBusy(what);
    setMsg(null);
    try {
      const text = await fn();
      if (text) setMsg({ tone: "ok", text });
      await refresh();
    } catch (e) {
      setMsg({ tone: "err", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy("");
    }
  };

  const start = () =>
    run("start", async () => {
      if (dirty && !confirm("当前项目有未保存的改动。Skill 拿到的是现在这一刻的快照,继续?")) return;
      const data = await api<{ job: Job }>("/api/skill/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, proc: serializeProc(), name: currentProjectName() }),
      });
      setCurrent(data.job.id);
    });

  const merge = (j: Job) =>
    run("merge", async () => {
      const [theirs, base] = await Promise.all([
        fetch(`/api/skill/jobs/${j.id}/proc`).then((r) => (r.ok ? r.text() : Promise.reject(new Error("还没有结果文件")))),
        fetch(`/api/skill/jobs/${j.id}/base`).then((r) => (r.ok ? r.text() : null)),
      ]);
      const report = applyCombine(theirs, base);
      return "已合并到当前项目(记得保存):\n" + summarizeCombine(report);
    });

  const stepState = (phase: Phase): "done" | "active" | "todo" | "failed" => {
    if (!job) return "todo";
    if (job.phase === "failed") {
      // 失败停在哪一步:job.phase 记的是失败前的那一步,由 error 标出来
      return "failed";
    }
    if (job.phase === "stopped") return ORDER.indexOf(phase) <= ORDER.indexOf("ready") ? "done" : "todo";
    const cur = ORDER.indexOf(job.phase);
    const me = ORDER.indexOf(phase);
    if (me < cur) return "done";
    if (me === cur) return job.phase === "ready" ? "done" : "active";
    return "todo";
  };

  return createPortal(
    <div className="pc-dialog-mask" onClick={onClose}>
      <div
        className="pc-dialog pc-skill-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pc-dialog-title-skill"
        onClick={(e) => e.stopPropagation()}
      >
        <div id="pc-dialog-title-skill" className="pc-dialog-title">Skill 模式</div>

        <div className="pc-skill-intro">
          把当前项目交给桌面版的 AI 编程助手去改。它拿到的是一份<b>独立副本</b>,跑在另一份看不见的 PromptCut 里,
          不会动你正在编辑的这份;改完把结果链接交回来,你再决定合不合进来。
        </div>

        <div className="pc-skill-providers">
          {PROVIDERS.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`pc-skill-provider${provider === p.id ? " is-on" : ""}`}
              disabled={busy !== ""}
              onClick={() => setProvider(p.id)}
            >
              <span className="pc-skill-provider-name">{p.name}</span>
              <span className="pc-skill-provider-desc">{p.desc}</span>
            </button>
          ))}
        </div>

        <div className="pc-skill-actions">
          <button type="button" className="pc-dialog-opt is-on" disabled={busy !== ""} onClick={start}>
            {busy === "start" ? "启动中…" : `用 ${provider === "claude" ? "Claude Code" : "Codex"} 开始`}
          </button>
        </div>

        {job && (
          <>
            <div className="pc-skill-steps">
              {STEPS.map((s) => {
                const st = stepState(s.phase);
                return (
                  <div key={s.phase} className={`pc-skill-step is-${st}`}>
                    <span className="pc-skill-step-dot" />
                    <span>{s.label}</span>
                  </div>
                );
              })}
              {job.phase === "failed" && <div className="pc-skill-step is-failed">失败:{job.error}</div>}
              {job.phase === "ready" && !job.launch && <div className="pc-skill-step is-active">正在拉起桌面 app 并替你按回车…</div>}
              {job.launch?.autoSend === "sent" && <div className="pc-skill-step is-done">指令已自动发送,agent 在配环境;配好后直接告诉它要做什么</div>}
              {job.launch && job.launch.autoSend !== "sent" && (
                <div className="pc-skill-step is-active">桌面 app 的窗口没到前台,指令留在输入框里 —— 切过去按一下回车就行</div>
              )}
              {job.phase === "stopped" && <div className="pc-skill-step">实例已停止。结果文件还在,可以合并</div>}
            </div>

            <div className="pc-skill-meta">
              <span>任务</span><code>{job.name} · {fmtTime(job.createdAt)} · {job.provider}</code>
              <span>目录</span><code>{job.dir}</code>
              <span>实例</span><code>{job.alive ? `端口 ${job.port},${job.dirty ? "有改动待写回" : "已写回"}${job.clips != null ? `,${job.clips} 张卡` : ""}` : "未运行"}</code>
              <span>结果</span><code>{job.procUpdatedAt ? `project.proc 更新于 ${fmtTime(job.procUpdatedAt)}` : "还没写回"}</code>
            </div>

            <div className="pc-skill-actions">
              <button type="button" className="pc-dialog-opt" disabled={busy !== "" || !job.procUpdatedAt} onClick={() => merge(job)} title="三方合并:以启动时的快照为基线,把 agent 的改动并进当前项目;两边都改的保留你的">
                {busy === "merge" ? "合并中…" : "合并结果到当前项目"}
              </button>
              <button type="button" className="pc-dialog-opt" disabled={busy !== "" || !job.alive} onClick={() => run("relaunch", async () => { await api(`/api/skill/jobs/${job.id}/relaunch`, { method: "POST" }); return "已重新拉起桌面 app 的对话"; })} title="桌面 app 的对话关掉了就再拉一次">
                重新拉起对话
              </button>
              <button type="button" className="pc-dialog-opt" disabled={busy !== ""} onClick={() => run("reveal", async () => { await api(`/api/skill/jobs/${job.id}/reveal`, { method: "POST" }); })}>
                打开任务文件夹
              </button>
              <button type="button" className="pc-dialog-opt" disabled={busy !== "" || !job.alive} onClick={() => run("stop", async () => { await api(`/api/skill/jobs/${job.id}/stop`, { method: "POST" }); return "已通知实例收工"; })}>
                停止实例
              </button>
            </div>
          </>
        )}

        {msg && <div className={`pc-skill-msg${msg.tone === "err" ? " is-err" : ""}`}>{msg.text}</div>}

        {jobs.length > 0 && (
          <div className="pc-dialog-body">
            <div className="pc-dialog-label">历史任务</div>
            <div className="pc-skill-jobs">
              {jobs.map((j) => (
                <button key={j.id} type="button" className={`pc-skill-job${j.id === current ? " is-on" : ""}`} onClick={() => setCurrent(j.id)}>
                  <span className="pc-skill-job-name">{j.name}</span>
                  <span>{fmtTime(j.createdAt)}</span>
                  <span>{j.provider}</span>
                  <span className={`pc-skill-job-state${j.alive ? " is-live" : ""}`}>{j.alive ? "运行中" : j.phase === "failed" ? "失败" : "已停"}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="pc-skill-actions" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="pc-dialog-opt" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
