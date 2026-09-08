import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { createPortal } from "react-dom";
import { serializeProc, currentProjectName } from "./io/proc";
import { applyCombine, summarizeCombine } from "./io/combineImport";
import { useStore } from "../store/project";
import { openSkillMode } from "../skill/skillMode";
import "./SkillDialog.css";

/**
 * Skill 模式:把当前项目交给桌面版的 Claude Code / Codex 去改。
 *
 * 点「开始」→ 服务端快照项目、起一份无头实例、拉起桌面 app 的新对话。点下去的那一刻
 * 就切进 SKILL 悬浮窗,启动的每一步在悬浮窗上走动画(desktop/ui/overlay.html),
 * 这个对话框只管选驱动、看历史任务、对任务做操作:强制并入 / 停 / 再起 / 删。
 */

type Provider = "claude" | "codex";
type Phase = "snapshot" | "booting" | "launching" | "ready" | "failed" | "stopped";

interface Job {
  id: string;
  provider: Provider;
  name: string;
  createdAt: string;
  startedAt?: string;
  phase: Phase;
  error?: string;
  dir: string;
  alive: boolean;
  /** 刚点的、实例还没上来 */
  starting: boolean;
  port: number | null;
  dirty: boolean | null;
  savedAt: string | null;
  clips: number | null;
  instanceError: string | null;
  procUpdatedAt: string | null;
  procUrl: string;
  launch?: { kind: string; detail: string; at: string; status?: "launching" | "ready" | "failed"; autoSend?: "sent" | "nofocus" | "error" | "skipped"; sessionId?: string; sessionCwd?: string };
}

const PROVIDERS: { id: Provider; name: string; desc: string }[] = [
  { id: "claude", name: "Claude Code", desc: "新建一个独立任务目录,Claude 桌面版的新对话直接落在那儿,预填好 /promptcut 自动发送" },
  { id: "codex", name: "Codex", desc: "自动创建不在项目中的独立任务,工作区指向任务目录,执行环境检查后打开对话" },
];

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

function jobStateLabel(j: Job): { text: string; cls: string } {
  if (j.alive) return { text: "运行中", cls: " is-live" };
  if (j.starting) return { text: "启动中", cls: " is-live" };
  if (j.phase === "failed") return { text: "失败", cls: " is-failed" };
  return { text: "已停", cls: "" };
}

/** 一句话说清这个任务现在怎么样了:失败原因 / 拉起结果 / 写回状态 */
function jobDetail(j: Job): { text: string; tone: "ok" | "err" | "muted" } | null {
  if (j.phase === "failed") return { text: `失败:${j.error || j.instanceError || "原因未知"}`, tone: "err" };
  // 停掉的任务不用再讲当初拉起的经过,那一行只会把列表撑乱
  if (!j.alive && !j.starting) return null;
  if (j.launch?.status === "failed" || j.launch?.autoSend === "error") return { text: j.launch.detail, tone: "err" };
  if (j.launch?.status === "launching") return { text: j.launch.detail, tone: "muted" };
  if (j.launch?.autoSend === "nofocus") return { text: "桌面 app 的窗口没到前台,指令留在输入框里 —— 切过去按一下回车就行", tone: "muted" };
  if (j.launch?.detail) return { text: j.launch.detail, tone: "ok" };
  return null;
}

/* 行内小图标:不引第三方图标库,几条 path 就够 */
const IconStop = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect x="1.5" y="1.5" width="9" height="9" rx="1.5" fill="currentColor" /></svg>
);
const IconPlay = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 1.5v9l8-4.5z" fill="currentColor" /></svg>
);
const IconTrash = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
    <path d="M1.5 3h9M4.5 3V1.8h3V3M2.8 3l.5 7.2h5.4L9.2 3M5 5v3.5M7 5v3.5" />
  </svg>
);
const IconMerge = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 1.5v9M9 1.5v3c0 2-6 2-6 4.5" /><circle cx="3" cy="10.5" r="1" fill="currentColor" /><circle cx="9" cy="1.5" r="1" fill="currentColor" /><circle cx="3" cy="1.5" r="1" fill="currentColor" />
  </svg>
);

export function SkillDialog(props: { open: boolean; onClose: () => void }): JSX.Element | null {
  const { open, onClose } = props;
  const dirty = useStore((s) => s.dirty);
  const [provider, setProvider] = useState<Provider>("claude");
  const [jobs, setJobs] = useState<Job[]>([]);
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

  // 开着就每 1.5 秒刷一次:任务的生死、写回时间都在变
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

  /*
   * 开始:建任务 → **立刻**进 SKILL 模式(主窗收成悬浮窗,启动进度在悬浮窗上走)→ 关掉这个对话框。
   * 不等实例就绪:那要几秒到几十秒,用户点了「开始」就该看到软件切过去,而不是盯着对话框里的进度条。
   * 快照那一步在 /api/skill/start 里是同步做完的,project.proc 这时已经在了,锁能直接挂上。
   */
  const start = () =>
    run("start", async () => {
      if (dirty && !confirm("当前项目有未保存的改动。Skill 拿到的是现在这一刻的快照,继续?")) return;
      const data = await api<{ job: Job }>("/api/skill/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, proc: serializeProc(), name: currentProjectName() }),
      });
      await openSkillMode({ jobId: data.job.id, jobDir: data.job.dir, procPath: `${data.job.dir}\\project.proc` });
      onClose();
    });

  /** 强制并入:不管 agent 有没有调 submit_merge,现在就把任务目录里的结果三方合并进当前项目 */
  const merge = (j: Job) =>
    run(`merge:${j.id}`, async () => {
      const [theirs, base] = await Promise.all([
        fetch(`/api/skill/jobs/${j.id}/proc`).then((r) => (r.ok ? r.text() : Promise.reject(new Error("还没有结果文件")))),
        fetch(`/api/skill/jobs/${j.id}/base`).then((r) => (r.ok ? r.text() : null)),
      ]);
      const report = applyCombine(theirs, base);
      return "已并入当前项目(记得保存):\n" + summarizeCombine(report);
    });

  const stop = (j: Job) =>
    run(`stop:${j.id}`, async () => {
      await api(`/api/skill/jobs/${j.id}/stop`, { method: "POST" });
      return "已通知实例收工";
    });

  /** 开始(停掉的任务再起一份实例,并把桌面 app 的对话叫回来);之后同样立刻进 SKILL 模式 */
  const restart = (j: Job) =>
    run(`restart:${j.id}`, async () => {
      const data = await api<{ job: Job }>(`/api/skill/jobs/${j.id}/restart`, { method: "POST" });
      await openSkillMode({ jobId: data.job.id, jobDir: data.job.dir, procPath: `${data.job.dir}\\project.proc` });
      onClose();
    });

  const remove = (j: Job) =>
    run(`delete:${j.id}`, async () => {
      if (!confirm(`删除任务「${j.name} · ${fmtTime(j.createdAt)}」?任务目录会整个删掉,结果文件也没了。`)) return;
      await api(`/api/skill/jobs/${j.id}/delete`, { method: "POST" });
    });

  const relaunch = (j: Job) =>
    run(`relaunch:${j.id}`, async () => {
      await api(`/api/skill/jobs/${j.id}/relaunch`, { method: "POST" });
      return "已把桌面 app 的对话叫回来";
    });

  const reveal = (j: Job) => run(`reveal:${j.id}`, async () => { await api(`/api/skill/jobs/${j.id}/reveal`, { method: "POST" }); });

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
          把当前项目交给桌面版的 AI 编程助手去改。开始时会新建一个<b>独立的任务目录</b>(在软件的数据目录下,
          不在源码里),项目副本、工具、说明都在里面;它跑在另一份看不见的 PromptCut 上,不会动你正在编辑的这份。
          点「开始」软件就收成悬浮窗;agent 可以随时把改动并回来,你也能在下面的历史任务里「强制并入」。
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

        {provider === "codex" && (
          <div className="pc-skill-check">
            无需关闭 Codex。任务不挂在你的项目下面,工作区指向独立任务目录;环境检查完成后自动打开对话。
          </div>
        )}

        <div className="pc-skill-actions">
          <button type="button" className="pc-dialog-opt is-on" disabled={busy !== ""} onClick={start}>
            {busy === "start" ? "启动中…" : `用 ${provider === "claude" ? "Claude Code" : "Codex"} 开始`}
          </button>
        </div>

        {msg && <div className={`pc-skill-msg${msg.tone === "err" ? " is-err" : ""}`}>{msg.text}</div>}

        {jobs.length > 0 && (
          <div className="pc-dialog-body">
            <div className="pc-dialog-label">历史任务</div>
            <div className="pc-skill-jobs">
              {jobs.map((j) => {
                const st = jobStateLabel(j);
                const detail = jobDetail(j);
                const running = j.alive || j.starting;
                const busyHere = busy.endsWith(`:${j.id}`);
                return (
                  <div key={j.id} className={`pc-skill-job${running ? " is-live" : ""}`}>
                    <div className="pc-skill-job-main">
                      <span className="pc-skill-job-name" title={j.dir}>{j.name}</span>
                      <span className={`pc-skill-job-state${st.cls}`}>{st.text}</span>
                    </div>
                    <div className="pc-skill-job-main">
                      <span className="pc-skill-job-when">{fmtTime(j.createdAt)} · {j.provider}{j.clips != null ? ` · ${j.clips} 张卡` : ""}</span>
                      <span className="pc-skill-job-acts">
                        <button
                          type="button"
                          className="pc-skill-job-act is-merge"
                          disabled={busy !== "" || !j.procUpdatedAt}
                          onClick={() => merge(j)}
                          title={j.procUpdatedAt ? `强制并入:以启动时的快照为基线,把这个任务的改动三方合并进当前项目(结果更新于 ${fmtTime(j.procUpdatedAt)})` : "还没有结果文件"}
                        >
                          <IconMerge />
                          <span>{busyHere && busy.startsWith("merge:") ? "并入中…" : "强制并入"}</span>
                        </button>
                        {running ? (
                          <button type="button" className="pc-skill-job-act is-stop" disabled={busy !== ""} onClick={() => stop(j)} title="停止实例(agent 之后再改会被拒)" aria-label="停止实例">
                            <IconStop />
                          </button>
                        ) : (
                          <button type="button" className="pc-skill-job-act is-start" disabled={busy !== ""} onClick={() => restart(j)} title="开始:再起一份实例,把桌面 app 的对话叫回来,并进入 SKILL 模式" aria-label="开始">
                            <IconPlay />
                          </button>
                        )}
                        <button type="button" className="pc-skill-job-act is-del" disabled={busy !== "" || running} onClick={() => remove(j)} title={running ? "先停掉实例再删" : "删除任务目录"} aria-label="删除">
                          <IconTrash />
                        </button>
                      </span>
                    </div>
                    {detail && <div className={`pc-skill-job-detail is-${detail.tone}`}>{detail.text}</div>}
                    {running && (
                      <div className="pc-skill-job-links">
                        <button type="button" className="pc-skill-job-link" disabled={busy !== ""} onClick={() => relaunch(j)} title="桌面 app 的对话关掉了就再叫回来">重新拉起对话</button>
                        <button type="button" className="pc-skill-job-link" disabled={busy !== ""} onClick={() => reveal(j)}>打开任务文件夹</button>
                      </div>
                    )}
                  </div>
                );
              })}
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
