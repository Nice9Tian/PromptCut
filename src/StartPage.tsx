import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import "./StartPage.css";
import { Logo } from "./ui/Logo";
import { listDrafts, openDraft, deleteDraft, newDraftId, setActiveDraftId } from "./editor/io/drafts";
import type { DraftInfo } from "./editor/io/drafts";
import { newProject, parseProc, PROC_EXT } from "./editor/io/proc";
import { actions } from "./store/project";

/** 字节数写成人看的样子 */
function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / 1024 / 1024).toFixed(1)}M`;
}

/** 秒 → mm:ss */
function humanDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** 今天的只显示时间,其余显示日期 */
function humanDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
    : `${d.getMonth() + 1}月${d.getDate()}日`;
}

/**
 * 开始页面。进软件先看到这里,选了才进编辑器。
 *
 * 三块:开始创作、拓展功能、本地草稿。没有左侧栏,也没有那排圆形入口 ——
 * 这一版只把「新建 / 打开草稿 / 装听写」这三件事摆出来。
 */
export function StartPage(props: { onEnterEditor: () => void }): JSX.Element {
  const { onEnterEditor } = props;
  const [drafts, setDrafts] = useState<DraftInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setDrafts(await listDrafts());
    } catch (e) {
      setError(e instanceof Error ? e.message : "读取草稿失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const startNew = () => {
    newProject("未命名");
    // 新项目还没落盘,进编辑器后由「保存项目」写成草稿
    setActiveDraftId(newDraftId());
    onEnterEditor();
  };

  const open = async (id: string) => {
    setBusy(id);
    setError("");
    try {
      await openDraft(id);
      setActiveDraftId(id);
      onEnterEditor();
    } catch (e) {
      setError(e instanceof Error ? e.message : "打开失败");
    } finally {
      setBusy("");
    }
  };

  const remove = async (draft: DraftInfo) => {
    if (!confirm(`删除草稿「${draft.name}」？这会删掉磁盘上的 .proc 文件，不能撤销。`)) return;
    try {
      await deleteDraft(draft.id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "删除失败");
    }
  };

  const openFile = async (file: File) => {
    setError("");
    try {
      const project = parseProc(await file.text());
      actions.loadProject(project, file.name);
      // 从文件打开的不属于任何草稿,保存时再新建一份
      setActiveDraftId(null);
      onEnterEditor();
    } catch (e) {
      setError(e instanceof Error ? e.message : "这个文件打不开");
    }
  };

  return (
    <div className="sp">
      <header className="sp-bar">
        {/* Logo 自带文字标,别再补一遍 */}
        <Logo size={22} />
        <span className="sp-bar-spacer" />
        <button className="sp-ghost-btn" onClick={() => fileInput.current?.click()}>
          打开项目文件
        </button>
      </header>

      <main className="sp-main">
        <button className="sp-hero" onClick={startNew}>
          <span className="sp-hero-plus" aria-hidden="true">＋</span>
          <span className="sp-hero-text">开始创作</span>
          <span className="sp-hero-sub">新建一个空项目</span>
        </button>

        <section className="sp-section">
          <h2 className="sp-section-title">拓展功能</h2>
          <div className="sp-ext-row">
            <SttCard />
          </div>
        </section>

        <section className="sp-section">
          <div className="sp-section-head">
            <h2 className="sp-section-title">本地草稿</h2>
            <div className="sp-section-actions">
              <span className="sp-muted">{loading ? "读取中…" : `${drafts.length} 个`}</span>
              <button className="sp-ghost-btn" onClick={() => void refresh()}>刷新</button>
            </div>
          </div>

          {error && <div className="sp-error">{error}</div>}

          {!loading && drafts.length === 0 && !error && (
            <div className="sp-empty">
              还没有草稿。点上面的「开始创作」新建一个，编辑器里保存后就会出现在这里。
            </div>
          )}

          <div className="sp-grid">
            {drafts.map((d) => (
              <div key={d.id} className={`sp-draft${d.broken ? " is-broken" : ""}`}>
                <button
                  className="sp-draft-thumb"
                  disabled={d.broken || busy === d.id}
                  onClick={() => void open(d.id)}
                  title={d.broken ? "这个文件解析不了" : `打开「${d.name}」`}
                >
                  {d.thumbnail
                    ? <img src={d.thumbnail} alt="" />
                    : <span className="sp-draft-placeholder">{d.broken ? "！" : `${d.clips} 张卡`}</span>}
                  {busy === d.id && <span className="sp-draft-busy">打开中…</span>}
                </button>
                <div className="sp-draft-meta">
                  <div className="sp-draft-name" title={d.name}>{d.name}</div>
                  <div className="sp-draft-sub">
                    {humanDate(d.updatedAt)} · {humanSize(d.size)} · {humanDuration(d.duration)}
                  </div>
                </div>
                <button className="sp-draft-del" title="删除这份草稿" onClick={() => void remove(d)}>
                  ✕
                </button>
              </div>
            ))}
          </div>
        </section>
      </main>

      <input
        ref={fileInput}
        type="file"
        accept={`${PROC_EXT},.json`}
        hidden
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void openFile(f); }}
      />
    </div>
  );
}

/** 拓展功能里的听写识别:显示装没装,没装就地装 */
function SttCard(): JSX.Element {
  const [status, setStatus] = useState<{ ready: boolean; detail: string } | null>(null);
  const [installing, setInstalling] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await (await fetch("/api/stt/status")).json();
      setStatus({ ready: !!(d.ready ?? d.installed ?? d.available), detail: d.hint || d.detail || d.engine || "" });
    } catch {
      setStatus({ ready: false, detail: "读不到状态" });
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const install = async () => {
    setInstalling(true);
    try {
      await fetch("/api/stt/install", { method: "POST" });
      // 安装是后台跑的,这里只负责把状态刷新到位
      await load();
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div className="sp-ext-card">
      <div className="sp-ext-icon" aria-hidden="true">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
          <rect x="9" y="3" width="6" height="11" rx="3" />
          <path d="M5 11a7 7 0 0 0 14 0" />
          <path d="M12 18v3M8.5 21h7" />
        </svg>
      </div>
      <div className="sp-ext-body">
        <div className="sp-ext-name">听写识别</div>
        <div className="sp-ext-desc">把视频里的话转成字幕，本机跑，不上传。</div>
        <div className="sp-ext-state">
          {status === null ? "检测中…" : status.ready
            ? <span className="sp-ok">已就绪{status.detail ? ` · ${status.detail}` : ""}</span>
            : <span className="sp-muted">{status.detail || "未安装"}</span>}
        </div>
      </div>
      {status && !status.ready && (
        <button className="sp-ghost-btn" disabled={installing} onClick={() => void install()}>
          {installing ? "安装中…" : "安装"}
        </button>
      )}
    </div>
  );
}
