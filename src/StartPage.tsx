import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";
import "./StartPage.css";
import { Logo } from "./ui/Logo";
import { listDrafts, openDraft, deleteDraft, newDraftId, setActiveDraftId } from "./editor/io/drafts";
import type { DraftInfo } from "./editor/io/drafts";
import { newProject, loadProc, PROC_EXT } from "./editor/io/proc";
import { actions } from "./store/project";
import { sttStatus } from "./editor/io/stt";
import type { SttStatus, SttEngineStatus } from "./editor/io/stt";
import { shotsStatus, installShots } from "./ai/shots";
import { trackStatus, installTrack } from "./ai/track";
import { subjectStatus, installSubject } from "./ai/subject";
import { collectStatus, installCollect, type CollectStatus } from "./ai/collect";
import { openCollectLogin, useCollectLoginState } from "./ai/collectLoginStore";
import { CollectLoginDialog } from "./editor/right/CollectLoginDialog";
import { runSttInstall } from "./editor/io/runSttInstall";
import { useInstallJobs } from "./ai/sttInstallStore";
import { SttInstallProgress } from "./editor/right/SttInstallProgress";
import { VoiceSettingsDialog } from "./voice/VoiceSettingsDialog";
import { openVoiceSettings, useVoiceSettingsState } from "./ai/voiceSettingsStore";
import { getVoiceConfig } from "./ai/voice";

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
 * 这一版只把「新建 / 打开草稿 / 看拓展装没装」这三件事摆出来。
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
      const project = loadProc(await file.text());
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
          <ExtensionCards />
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

/**
 * 一个拓展在界面上的样子。
 *
 * 拆出 offerInstall 而不是直接用「装没装」取反:有两种没装的情况不该给安装按钮 ——
 * 状态压根读不到、以及连 Python 都没有。这两种点了必然再失败一次,
 * 显示成普通的「未安装」等于骗用户去撞墙。
 */
interface ExtStatusView {
  headline: string;
  /** 跟在 headline 后面那句:现在实际吃的是哪一档、降级之后还能干什么 */
  note: string;
  tone: "ok" | "muted" | "danger";
  offerInstall: boolean;
}

function toneClass(tone: ExtStatusView["tone"]): string {
  return tone === "ok" ? "sp-ok" : tone === "danger" ? "sp-ext-error" : "sp-muted";
}

function failedView(reason: unknown): ExtStatusView {
  return {
    headline: "读不到状态",
    note: reason instanceof Error ? reason.message : String(reason),
    tone: "danger",
    offerInstall: false,
  };
}

/** 把一次 settled 的查询结果翻成界面状态。映射本身也可能抛(后端少给字段),一起兜住 */
function toView<T>(r: PromiseSettledResult<T>, map: (v: T) => ExtStatusView): ExtStatusView {
  if (r.status === "rejected") return failedView(r.reason);
  try { return map(r.value); } catch (e) { return failedView(e); }
}

function viewStt(s: SttStatus): ExtStatusView {
  // 状态在 engines.<引擎>.installed 里,顶层没有 ready / installed / available 这些字段;
  // 以前读顶层,取到的永远是 undefined,所以装好了也一直显示「未安装」。
  const engines: Record<string, SttEngineStatus> = s.engines;
  const hit = Object.entries(engines).find(([, e]) => e.installed);
  if (hit) {
    return {
      headline: "已安装",
      note: `当前用 ${hit[0]}${hit[1].version ? ` ${hit[1].version}` : ""}`,
      tone: "ok",
      offerInstall: false,
    };
  }
  return {
    headline: "未安装",
    note: "没有兜底档，装上才能把说的话转成字幕",
    tone: "muted",
    offerInstall: true,
  };
}

function viewShots(s: { ready: boolean; engine: string }): ExtStatusView {
  if (s.ready) {
    return {
      headline: "已安装",
      note: `当前用 ${s.engine || "TransNetV2"}，硬切和溶解、淡入淡出都认得出`,
      tone: "ok",
      offerInstall: false,
    };
  }
  return {
    headline: "未安装",
    note: "当前用 ffmpeg scdet，只认硬切，认不出溶解",
    tone: "muted",
    offerInstall: true,
  };
}

function viewTrack(s: { ready: boolean; engine: "bootstapir" | "template" | null; reason?: string }): ExtStatusView {
  if (s.ready) {
    return {
      headline: "已安装",
      note: `当前用 ${s.engine ?? "bootstapir"}，转向、形变、短暂被挡都跟得住`,
      tone: "ok",
      offerInstall: false,
    };
  }
  if (s.engine === "template") {
    // ready:false 不等于用不了 —— 这一档是能跑的,写成光秃秃的「未安装」会让人
    // 以为功能是灰的,所以把「还能用」和「什么时候会翻车」一起说清楚。
    return {
      headline: "未安装",
      note: "当前用 numpy 模板匹配兜底，照样能追：刚体、纹理清晰的目标追得很准；"
        + "目标转向、缩放或长时间被挡就会跟丢。装上拓展会稳得多，但要下约 400 MB",
      tone: "muted",
      offerInstall: true,
    };
  }
  return {
    headline: "用不了",
    note: s.reason || "两档都起不来，通常是找不到 Python",
    tone: "danger",
    offerInstall: false,
  };
}

function viewSubject(s: { ready: boolean; engine: "light" | "full" | null; reason?: string }): ExtStatusView {
  if (s.engine === "full") {
    return {
      headline: "已安装",
      note: "完整档：人脸、人体，还能按任意文字提示找目标（猫、手机、红色的车）",
      tone: "ok",
      offerInstall: false,
    };
  }
  if (s.engine === "light") {
    // light 能用,但和 full 差一整个能力档。写成光秃秃的「已安装」会让人以为
    // 文字提示也能用,结果每次都只回人和脸。
    return {
      headline: "已安装",
      note: "轻档：认得出人脸和人体，够用来避开人物；按文字提示找目标要装完整档拓展库包",
      tone: "ok",
      offerInstall: false,
    };
  }
  if (s.reason) {
    // 连 Python 都没有这类环境问题,给安装按钮只会让人再撞一次墙
    return { headline: "用不了", note: s.reason, tone: "danger", offerInstall: false };
  }
  return {
    headline: "未安装",
    note: "没有兜底档，装上 AI 才知道人在画面哪一边、卡片放哪不挡脸",
    tone: "muted",
    offerInstall: true,
  };
}

/** 拓展卡的壳子。四张卡长得一样,差别只在图标、文案和右边那个按钮 */
function ExtCard(props: {
  icon: ReactNode;
  name: string;
  desc: string;
  status: ExtStatusView | null;
  action?: ReactNode;
  children?: ReactNode;
}): JSX.Element {
  const { icon, name, desc, status, action, children } = props;
  return (
    <div className="sp-ext-card">
      <div className="sp-ext-icon" aria-hidden="true">{icon}</div>
      <div className="sp-ext-body">
        <div className="sp-ext-name">{name}</div>
        <div className="sp-ext-desc">{desc}</div>
        <div className="sp-ext-state">
          {status === null
            ? <span className="sp-muted">检测中…</span>
            : <span className={toneClass(status.tone)}>
                {status.headline}{status.note ? ` · ${status.note}` : ""}
              </span>}
        </div>
        {children}
      </div>
      {action}
    </div>
  );
}

/** 拓展功能区:听写、镜头识别、运动追踪、主体检测四张卡 */
function ExtensionCards(): JSX.Element {
  const [stt, setStt] = useState<ExtStatusView | null>(null);
  const [shots, setShots] = useState<ExtStatusView | null>(null);
  const [track, setTrack] = useState<ExtStatusView | null>(null);
  const [subject, setSubject] = useState<ExtStatusView | null>(null);
  const [collect, setCollect] = useState<ExtStatusView | null>(null);
  /** 素材收集的原始状态:登录按钮要看 ready 和各站登录态 */
  const [collectRaw, setCollectRaw] = useState<CollectStatus | null>(null);

  const load = useCallback(async () => {
    // 五个查询各打一个 HTTP,而且都要等 Python 那边应答。串行的话最慢的排在最后,
    // 开始页会干等着,所以一起发。用 allSettled 不用 all:一个拓展查不到状态
    // 不该把另外几张卡也永远钉在「检测中…」。
    const [a, b, c, d, e] = await Promise.allSettled([
      sttStatus(), shotsStatus(), trackStatus(), subjectStatus(), collectStatus(),
    ]);
    setStt(toView(a, viewStt));
    setShots(toView(b, viewShots));
    setTrack(toView(c, viewTrack));
    setSubject(toView(d, viewSubject));
    setCollect(toView(e, viewCollect));
    setCollectRaw(e.status === "fulfilled" ? e.value : null);
  }, []);

  useEffect(() => { void load(); }, [load]);

  // 登录框关掉之后刷新一次:登录 / 退出都会改这张卡上的字
  const loginOpen = useCollectLoginState().open;
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !loginOpen) void load();
    wasOpen.current = loginOpen;
  }, [loginOpen, load]);

  return (
    <div className="sp-ext-row">
      <SttCard status={stt} onReload={load} />
      <ShotsCard status={shots} onReload={load} />
      <TrackCard status={track} onReload={load} />
      <SubjectCard status={subject} onReload={load} />
      <CollectCard status={collect} raw={collectRaw} onReload={load} />
      <VoiceCard />
      <CollectLoginDialog />
      <VoiceSettingsDialog />
    </div>
  );
}

function viewCollect(s: CollectStatus): ExtStatusView {
  if (s.ready) {
    const bili = s.cookies?.bilibili;
    const login = bili?.loggedIn
      ? `B 站已登录（用户 ${bili.userId ?? "?"}）`
      : bili?.expired ? "B 站登录态已过期" : "B 站未登录，最高 1080p";
    return {
      headline: "已安装",
      note: `yt-dlp ${s.ytdlp?.version ?? ""}；${login}`,
      tone: "ok",
      offerInstall: false,
    };
  }
  if (s.python === false || (s.ytdlp?.installed && !s.ffmpeg)) {
    // 没有内置 Python 或没有 ffmpeg 不是在线装能解决的,给按钮只会让人再撞一次墙
    return {
      headline: "用不了",
      note: s.reason || (s.ytdlp?.installed ? "找不到 ffmpeg，视频流和音频流合不起来" : "找不到内置 Python"),
      tone: "danger",
      offerInstall: false,
    };
  }
  return {
    headline: "未安装",
    note: "装上就能把 B 站等网页链接里的视频直接抓进素材库（约 3 MB）",
    tone: "muted",
    offerInstall: true,
  };
}

/**
 * 配音:云端合成,不用装东西,卡上只显示「令牌配没配、默认用谁」。
 * 设置项多,点「设置」开子窗口(编辑台顶栏的「配音设置」开的是同一个)。
 */
function VoiceCard(): JSX.Element {
  const [status, setStatus] = useState<ExtStatusView | null>(null);

  const load = useCallback(async () => {
    try {
      const { config, presets } = await getVoiceConfig();
      const p = config.provider;
      const id = config[p].voiceId;
      const voice = config.customVoices.find((v) => v.provider === p && v.voiceId === id)?.name
        ?? presets.systemVoices[p].find((v) => v.voiceId === id)?.name
        ?? id;
      setStatus(config.apiKey.set
        ? { headline: "已配置", note: `${presets.labels[p]} · ${voice}`, tone: "ok", offerInstall: false }
        : { headline: "未配置", note: "填好 API Key，agent 才能配音", tone: "muted", offerInstall: false });
    } catch (e) {
      setStatus(failedView(e));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // 设置窗口关掉之后刷新一次:令牌、默认音色都可能改了
  const open = useVoiceSettingsState().open;
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !open) void load();
    wasOpen.current = open;
  }, [open, load]);

  return (
    <ExtCard
      icon={
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
          <path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2" />
        </svg>
      }
      name="配音"
      desc="把文字配成语音，云端合成，默认 MiniMax。"
      status={status}
      action={<button className="sp-ghost-btn" onClick={openVoiceSettings}>设置</button>}
    />
  );
}

/** 素材收集:状态由上面统一查,安装走 installCollect 的 SSE 日志流(pip 装 yt-dlp) */
function CollectCard(props: { status: ExtStatusView | null; raw: CollectStatus | null; onReload: () => void | Promise<void> }): JSX.Element {
  const { status, raw, onReload } = props;
  const [running, setRunning] = useState(false);
  // 装好了才谈登录:按钮文案跟着存盘登录态走,过期也算「要重新登录」
  const canLogin = !!raw?.ready;
  const biliLoggedIn = !!raw?.cookies?.bilibili?.loggedIn;
  const [tail, setTail] = useState("");
  const [error, setError] = useState<string | null>(null);

  const install = () => {
    setRunning(true);
    setError(null);
    setTail("");
    void installCollect((line) => setTail(line))
      .then(({ ok, log }) => {
        if (!ok) setError(log.filter((l) => l.startsWith("[error]")).slice(-1)[0] ?? "安装失败");
        return onReload();
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setRunning(false));
  };

  return (
    <ExtCard
      icon={
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3v12" />
          <path d="M7 10l5 5 5-5" />
          <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
        </svg>
      }
      name="素材收集"
      desc="给一条 B 站等网页链接，把视频抓进素材库。"
      status={status}
      action={
        status?.offerInstall && !running
          ? <button className="sp-ghost-btn" onClick={install} title="约 3 MB">
              {error ? "重试" : "安装"}
            </button>
          : canLogin
            ? <button className="sp-ghost-btn" onClick={() => openCollectLogin("bilibili", "qr")}
                title={biliLoggedIn ? "查看登录态、换账号或退出" : "扫码或账号密码登录,拿登录才有的清晰度"}>
                {biliLoggedIn ? "B 站账号" : "登录 B 站"}
              </button>
            : null
      }
    >
      {running && (
        <div className="sp-ext-progress">
          <span className="sp-muted">安装中…{tail ? ` ${tail}` : ""}</span>
        </div>
      )}
      {error && <div className="sp-ext-error">{error}</div>}
    </ExtCard>
  );
}

/** 听写识别:状态由上面统一查,这张卡只管就地安装 */
function SttCard(props: { status: ExtStatusView | null; onReload: () => void | Promise<void> }): JSX.Element {
  const { status, onReload } = props;
  const [startError, setStartError] = useState<string | null>(null);
  const jobs = useInstallJobs();
  const job = jobs.at(-1);
  const running = !!job && job.phase !== "done" && job.phase !== "failed";

  // 装完自动把状态刷新到位,不用用户自己再点一次
  useEffect(() => { if (job?.phase === "done") void onReload(); }, [job?.phase, onReload]);

  const install = () => {
    setStartError(null);
    // 走和编辑器里那个缺依赖提示完全相同的路径:流式读 pip 输出、解析进度、
    // 互斥防重复。以前这里是 POST /api/stt/install 且不带 body,
    // 服务端 JSON.parse("") 直接抛错返回 500,安装根本没启动过,
    // 而这段代码既不看返回码也不读那条 SSE 流,所以按钮闪一下就回到「安装」。
    try { runSttInstall("faster-whisper"); }
    catch (e) { setStartError(e instanceof Error ? e.message : String(e)); }
  };

  return (
    <ExtCard
      icon={
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
          <rect x="9" y="3" width="6" height="11" rx="3" />
          <path d="M5 11a7 7 0 0 0 14 0" />
          <path d="M12 18v3M8.5 21h7" />
        </svg>
      }
      name="听写识别"
      desc="把视频里的话转成字幕，本机跑，不上传。"
      status={status}
      action={
        // 判断依据是「有没有在跑」,不是「有没有任务」—— 装完一次之后 store 里会一直留着
        // 那条已完成的记录,拿它当条件会让卡片再也出不来按钮,变成死胡同。
        status?.offerInstall && !running
          ? <button className="sp-ghost-btn" onClick={install}>{job?.phase === "failed" ? "重试" : "安装"}</button>
          : null
      }
    >
      {/* 装的过程要看得见:下几百 MB、跑几分钟,没有进度就和没反应一样。
          失败的也留着显示,否则用户只看到按钮变回「安装」,不知道为什么没装上。 */}
      {(running || job?.phase === "failed") && (
        <div className="sp-ext-progress"><SttInstallProgress job={job!} compact /></div>
      )}
      {startError && <div className="sp-ext-error">{startError}</div>}
    </ExtCard>
  );
}

/** 镜头识别:状态由上面统一查,安装走 installShots 的 SSE 日志流 */
function ShotsCard(props: { status: ExtStatusView | null; onReload: () => void | Promise<void> }): JSX.Element {
  const { status, onReload } = props;
  const [running, setRunning] = useState(false);
  const [tail, setTail] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** 依赖装好了,只差模型文件 —— 得靠拓展库包补,不是在线装能解决的 */
  const [needsPack, setNeedsPack] = useState(false);

  const install = () => {
    setRunning(true);
    setError(null);
    setTail("");
    // 只留最后一行,理由同运动追踪那张卡
    void installShots((line) => setTail(line))
      .then(({ ok, needsModel, log }) => {
        // 「依赖装好了但还缺模型」不是失败:模型是我们自己转/官方下的权重,
        // 不在 requirements 里,只随拓展库包发。报成红字会让人以为白装了,
        // 而真正该说的是「去跑那个 .exe」。
        if (!ok) setError(log.filter((l) => l.startsWith("[error]")).slice(-1)[0] ?? "安装失败");
        else if (needsModel) setNeedsPack(true);
        return onReload();
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setRunning(false));
  };

  return (
    <ExtCard
      icon={
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="M10 5v14M14 5v14" />
        </svg>
      }
      name="镜头识别"
      desc="找出素材里的镜头切换点，按镜头拆条。"
      status={status}
      action={
        status?.offerInstall && !running
          ? <button className="sp-ghost-btn" onClick={install} title="约 30 MB">
              {error ? "重试" : "安装"}
            </button>
          : null
      }
    >
      {running && (
        <div className="sp-ext-progress">
          <span className="sp-muted">安装中…{tail ? ` ${tail}` : ""}</span>
        </div>
      )}
      {needsPack && !error && (
        <div className="sp-ext-error">
          依赖已装好，还差模型文件。它随拓展库包分发，请运行 PromptCut-ext-shots-&lt;版本&gt;.exe
        </div>
      )}
      {error && <div className="sp-ext-error">{error}</div>}
    </ExtCard>
  );
}

/** 运动追踪:状态由上面统一查,安装走 installTrack 的 SSE 日志流 */
function TrackCard(props: { status: ExtStatusView | null; onReload: () => void | Promise<void> }): JSX.Element {
  const { status, onReload } = props;
  const [running, setRunning] = useState(false);
  const [tail, setTail] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** 依赖装好了,只差模型文件 —— 得靠拓展库包补,不是在线装能解决的 */
  const [needsPack, setNeedsPack] = useState(false);

  const install = () => {
    // 400 MB 走的是用户自己的网,开始之前先问一声 —— 点错了退不掉。
    if (!confirm("运动追踪拓展要下载 torch 和 BootsTAPIR 权重，约 400 MB，要好几分钟。现在装？")) return;
    setRunning(true);
    setError(null);
    setTail("");
    // 只留最后一行:pip 会刷几百行,开始页没有装日志面板的地方,
    // 有一行在动就够说明「还在跑」了。
    void installTrack((line) => setTail(line))
      .then(({ ok, needsModel, log }) => {
        // 「依赖装好了但还缺模型」不是失败:模型是我们自己转/官方下的权重,
        // 不在 requirements 里,只随拓展库包发。报成红字会让人以为白装了,
        // 而真正该说的是「去跑那个 .exe」。
        if (!ok) setError(log.filter((l) => l.startsWith("[error]")).slice(-1)[0] ?? "安装失败");
        else if (needsModel) setNeedsPack(true);
        return onReload();
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setRunning(false));
  };

  return (
    <ExtCard
      icon={
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
          <circle cx="12" cy="12" r="3.2" />
          <path d="M12 2.5v3.2M12 18.3v3.2M2.5 12h3.2M18.3 12h3.2" />
        </svg>
      }
      name="运动追踪"
      desc="让文字和贴图跟着画面里的目标走。"
      status={status}
      action={
        status?.offerInstall && !running
          ? <button className="sp-ghost-btn" onClick={install} title="约 400 MB，要好几分钟">
              {error ? "重试" : "安装"}
            </button>
          : null
      }
    >
      {running && (
        <div className="sp-ext-progress">
          <span className="sp-muted">安装中…{tail ? ` ${tail}` : ""}</span>
        </div>
      )}
      {needsPack && !error && (
        <div className="sp-ext-error">
          依赖已装好，还差 208 MB 的权重文件。它随拓展库包分发，请运行 PromptCut-ext-track-&lt;版本&gt;.exe
        </div>
      )}
      {error && <div className="sp-ext-error">{error}</div>}
    </ExtCard>
  );
}

/** 主体检测:状态由上面统一查,安装走 installSubject 的 SSE 日志流(只装 light 档) */
function SubjectCard(props: { status: ExtStatusView | null; onReload: () => void | Promise<void> }): JSX.Element {
  const { status, onReload } = props;
  const [running, setRunning] = useState(false);
  const [tail, setTail] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** 依赖装好了,只差模型文件 —— 得靠拓展库包补,不是在线装能解决的 */
  const [needsPack, setNeedsPack] = useState(false);

  const install = () => {
    setRunning(true);
    setError(null);
    setTail("");
    // 只留最后一行,理由同另外两张卡:pip 会刷几百行,这里没有装日志面板的地方
    void installSubject((line) => setTail(line))
      .then(({ ok, needsModel, log }) => {
        // 「依赖装好了但还缺模型」不是失败:YuNet 和 RT-DETR 的权重不在
        // requirements 里,只随拓展库包发。报成红字会让人以为白装了,
        // 而真正该说的是「去跑那个 .exe」。
        if (!ok) setError(log.filter((l) => l.startsWith("[error]")).slice(-1)[0] ?? "安装失败");
        else if (needsModel) setNeedsPack(true);
        return onReload();
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setRunning(false));
  };

  return (
    <ExtCard
      icon={
        // 一个人形加一个取景框:这张卡干的就是「框出画面里的人」
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
          <path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16" />
          <circle cx="12" cy="10" r="2.4" />
          <path d="M8.2 17c.5-2 1.9-3 3.8-3s3.3 1 3.8 3" />
        </svg>
      }
      name="主体检测"
      desc="看清人在画面哪一边，卡片自动避开人物的脸。"
      status={status}
      action={
        status?.offerInstall && !running
          ? <button className="sp-ghost-btn" onClick={install} title="轻档约 30 MB">
              {error ? "重试" : "安装"}
            </button>
          : null
      }
    >
      {running && (
        <div className="sp-ext-progress">
          <span className="sp-muted">安装中…{tail ? ` ${tail}` : ""}</span>
        </div>
      )}
      {needsPack && !error && (
        <div className="sp-ext-error">
          依赖已装好，还差模型文件。它随拓展库包分发，请运行 PromptCut-ext-light-&lt;版本&gt;.exe
        </div>
      )}
      {error && <div className="sp-ext-error">{error}</div>}
    </ExtCard>
  );
}
