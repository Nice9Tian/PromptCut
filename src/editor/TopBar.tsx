import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { actions, useStore } from "../store/project";
import { cancelExport, exportVideo, streamExportFile, revealExport, importProjectFile } from "./io";
import { newProject, pickSaveTarget, serializeProc, writeProcToDisk, loadProc, forgetSaveTarget, PROC_EXT, PROC_FORMAT } from "./io/proc";
import { PROCP_EXT, isProcpFile, loadProcpFile, packProcp } from "./io/procp";
import { ExportDialog, type ExportState } from "./ExportDialog";
import { ensureActiveDraftId, saveDraft, setActiveDraftId } from "./io/drafts";
import { Logo } from "../ui/Logo";
import {
  IconExport,
  IconHome,
  IconNew,
  IconMore,
  IconPalette,
  IconImport,
  IconOpen,
  IconRedo,
  IconSave,
  IconSettings,
  IconUndo,
  IconVoice,
} from "../ui/icons";
import { openVoiceSettings } from "../ai/voiceSettingsStore";
import { ModeSwitch } from "./ModeSwitch";
import { AgentBrowserTab } from "./AgentBrowserTab";
import { ProjectSettingsDialog } from "./ProjectSettingsDialog";
import { SkinDialog } from "./SkinDialog";
import { SkillDialog } from "./SkillDialog";
import { applyCombine, summarizeCombine } from "./io/combineImport";
import { isViewOnly } from "./io/viewOnly";
import { SyncChips } from "./sync/SyncChips";
import { NewSharedDialog, OpenSharedDialog } from "./sync/SharedDialogs";
import { BackupsDialog } from "./sync/BackupsDialog";
import { useSync, whenSaved } from "./sync/syncManager";
import "../ui/toolbar.css";

/** 顶栏宽度档位:宽档(全部展开)、中档(图标收缩)、窄档(折叠更多菜单) */
type BarTier = "wide" | "icon" | "narrow";

const THRESHOLD_ICON = 880;
const THRESHOLD_WIDE = 1180;
const HYSTERESIS = 40;

/** 带滞回的档位换算,避免在临界宽度时来回抖动 */
function computeNextTier(current: BarTier, width: number): BarTier {
  if (current === "wide") {
    if (width < THRESHOLD_ICON) return "narrow";
    if (width < THRESHOLD_WIDE) return "icon";
    return "wide";
  }
  if (current === "icon") {
    if (width >= THRESHOLD_WIDE + HYSTERESIS) return "wide";
    if (width < THRESHOLD_ICON) return "narrow";
    return "icon";
  }
  // current === "narrow"
  if (width >= THRESHOLD_WIDE + HYSTERESIS) return "wide";
  if (width >= THRESHOLD_ICON + HYSTERESIS) return "icon";
  return "narrow";
}

/**
 * 顶栏按钮:label 永远渲染为 span.pc-btn-label,通过 CSS 平滑收缩展开。
 * title 恒等于 label,收起为方形图标态后鼠标悬停仍能看到提示。
 */
function Btn({
  onClick,
  label,
  icon,
  primary,
  collapsed,
  disabled,
  title,
}: {
  onClick: () => void;
  label: string;
  icon?: React.ReactNode;
  primary?: boolean;
  collapsed?: boolean;
  disabled?: boolean;
  /** 覆盖悬停提示。禁用时用它说清为什么点不了 */
  title?: string;
}) {
  return (
    <button
      title={title ?? label}
      onClick={onClick}
      disabled={disabled}
      className={`pc-btn${primary ? " pc-btn--primary" : ""}${collapsed ? " pc-btn--collapsed" : ""}`}
    >
      {icon}
      <span className="pc-btn-label">{label}</span>
    </button>
  );
}

/**
 * 顶栏:按条宽动态三档降级,包含编辑操作、外观与布局、文件导出。
 */
export function TopBar() {
  const barRef = useRef<HTMLDivElement>(null);
  const moreBtnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const [tier, setTier] = useState<BarTier>("wide");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [skinOpen, setSkinOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [skillOpen, setSkillOpen] = useState(false);
  /** C6.5:共享项目的两个对话框与「本地备份…」 */
  const [newSharedOpen, setNewSharedOpen] = useState(false);
  const [openSharedOpen, setOpenSharedOpen] = useState(false);
  const [backupsOpen, setBackupsOpen] = useState(false);
  // 撤销提示条里点「项目设置」那一类实体会派发这个事件:打开项目设置对话框
  useEffect(() => {
    const open = () => setSettingsOpen(true);
    window.addEventListener("pc-open-project-settings", open);
    return () => window.removeEventListener("pc-open-project-settings", open);
  }, []);
  /**
   * 撤销 / 重做按钮的禁用态:栈空时置灰。撤销栈的变化大多伴随项目变化(store 会通知);
   * 一处都没撤成时项目不变、只出提示条,所以顺带订阅同步状态里的提示条。
   */
  const canUndo = useStore(() => actions.canUndo());
  const canRedo = useStore(() => actions.canRedo());
  useSync((v) => v.notice);
  const mergeInput = useRef<HTMLInputElement>(null);
  const [moreBtnRect, setMoreBtnRect] = useState<DOMRect | null>(null);

  /**
   * 「项目」下拉:新建 / 打开 / 保存 / 项目设置收在一个按钮里,点开才出子菜单。
   * 四个动作都是"偶尔点一次"的,平铺在条上占四个位置,还挤得导出这种常点的没地方。
   * 菜单挂在 body 上(portal),和「⋯」一样点外面 / 按 Esc 收起。
   */
  const [projOpen, setProjOpen] = useState(false);
  const projBtnRef = useRef<HTMLButtonElement>(null);
  const projMenuRef = useRef<HTMLDivElement>(null);
  const [projRect, setProjRect] = useState<DOMRect | null>(null);
  const toggleProjMenu = () => {
    if (!projOpen && projBtnRef.current) setProjRect(projBtnRef.current.getBoundingClientRect());
    setProjOpen((v) => !v);
  };
  useEffect(() => {
    if (!projOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (projMenuRef.current?.contains(t) || projBtnRef.current?.contains(t)) return;
      setProjOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); setProjOpen(false); } };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [projOpen]);
  // 只读查看在页面地址里就定了,不会中途变,所以不进 state
  const viewOnly = isViewOnly();

  const name = useStore((s) => s.project.name);
  const project = useStore((s) => s.project);
  const dirty = useStore((s) => s.dirty);
  const projectInput = useRef<HTMLInputElement>(null);

  /** 顶栏项目名就地改名:点一下标签变输入框 */
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);

  /**
   * 用 ref 而不是 renaming 这个 state 当闸门:按 Esc 关掉编辑态时,正在卸载的
   * input 还会再冒一次 blur,而那个 blur 处理函数捕获的是上一次渲染的
   * renaming(仍然是 true)——只看 state 的话,取消会被 blur 又提交回来。
   */
  const renamingRef = useRef(false);

  const startRename = () => {
    setDraftName(name);
    renamingRef.current = true;
    setRenaming(true);
  };

  const cancelRename = () => {
    renamingRef.current = false;
    setRenaming(false);
  };

  /**
   * 收尾改名。Enter 和失焦都走这里,闸门保证只生效一次。
   * 名字留空退回「未命名」,和项目设置对话框里那条规则保持一致。
   */
  const commitRename = () => {
    if (!renamingRef.current) return;
    renamingRef.current = false;
    setRenaming(false);
    const next = draftName.trim() || "未命名";
    if (next !== name) actions.setProjectMeta({ name: next });
  };

  // 进入编辑态就把光标放进去并全选,省得用户自己再点一次、删一遍
  useEffect(() => {
    if (!renaming) return;
    const el = renameInputRef.current;
    el?.focus();
    el?.select();
  }, [renaming]);

  /**
   * 点到别处就收尾。
   *
   * 光靠 onBlur 不够:预览和时间线在 mousedown 里 preventDefault(挡文字选中),
   * 那会连焦点转移一起挡掉,输入框就一直开着。所以照「⋯」菜单那套,额外在
   * window 上听 mousedown,点在输入框外面就提交。两条路都进 commitRename,
   * 由 renamingRef 保证只生效一次。
   */
  useEffect(() => {
    if (!renaming) return;
    const onDown = (e: MouseEvent) => {
      if (!renameInputRef.current?.contains(e.target as Node)) commitRename();
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  });

  /**
   * 桌面版原生菜单栏的「外观 → 皮肤…」点了会派发 pc-open-skin,这里接住它打开
   * 同一个对话框 —— 两个入口共用一份界面,不做第二套。
   *
   * 走 window.__TAURI__(tauri.conf.json 里开了 withGlobalTauri),省得前端为这
   * 一个监听多装 @tauri-apps/api;浏览器里没有这个全局,整段自然跳过。
   */
  useEffect(() => {
    const api = (window as unknown as {
      __TAURI__?: { event?: { listen?: (e: string, cb: () => void) => Promise<() => void> } };
    }).__TAURI__;
    if (!api?.event?.listen) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    api.event
      .listen("pc-open-skin", () => setSkinOpen(true))
      .then((off) => {
        // 组件可能在 listen 落地之前就卸载了,那就立刻退订
        if (cancelled) off();
        else unlisten = off;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // ResizeObserver 监听顶栏根元素自身 clientWidth 并带滞回换算档位
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const update = () => {
      setTier((curr) => computeNextTier(curr, el.clientWidth));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 更多菜单点击外部或按 Escape 关闭
  useEffect(() => {
    if (!menuOpen) return;
    const handleDown = (e: MouseEvent) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node) &&
        !moreBtnRef.current?.contains(e.target as Node)
      ) {
        setMenuOpen(false);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", handleDown);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("mousedown", handleDown);
      window.removeEventListener("keydown", handleKey);
    };
  }, [menuOpen]);

  // 菜单打开期间监听窗口 resize 和 scroll(捕获阶段),一触发就关掉菜单防漂移
  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [menuOpen]);

  // 原来这里有条「档位切回 wide/icon 就收起菜单」——那是因为当时「⋯」只在窄档存在,
  // 变宽后按钮没了、菜单会孤零零留在屏幕上。现在「⋯」任何宽度都在,这条规则会
  // 在宽档一打开就立刻把菜单关掉,所以去掉了。菜单漂移由下面的 resize 监听负责。

  const run = (fn: () => Promise<unknown>) => () => fn().catch((e) => alert(String(e?.message ?? e)));

  const [exportState, setExportState] = useState<ExportState | null>(null);
  /** 正在跑的导出任务 id,取消要用 */
  const exportIdRef = useRef<string | null>(null);

  /**
   * 保存:弹「另存为」让用户选位置,同时把本地草稿更新掉。
   *
   * 顺序有讲究 —— showSaveFilePicker 要用户手势,所以它必须是这里的第一个
   * await;先去存草稿再弹窗,手势就过期了,浏览器会直接抛 SecurityError。
   * 用户点取消就整个不算保存:草稿不写、脏标记不清,和「我没保存」一致。
   */
  const saveProject = async () => {
    const fileName = `${name}${PROC_EXT}`;
    try {
      // 挑好落点之后、写之前:等文档服务确认完所有本地修改(语义「页面只在拿到确认之后才写」),再序列化
      const outcome = await writeProcToDisk(async () => {
        await settledOrExplain();
        return serializeProc();
      }, fileName);
      if (outcome.kind === "cancelled") return;
      await saveDraft(ensureActiveDraftId());
      // 存完就不脏了,否则「首页」「新建项目」每次都要多问一句
      actions.markSaved(fileName);
      if (outcome.kind === "downloaded") {
        // 这个 WebView 没有文件选择 API,至少告诉用户文件去哪了
        alert(`当前环境不支持选择目录，已保存到浏览器的下载位置：${outcome.where}`);
      }
    } catch (e) {
      alert(String((e as Error).message));
    }
  };

  /**
   * 等文档服务确认所有本地修改;超时(离线、连接慢、同步已暂停)就不写,告诉用户为什么。
   */
  const settledOrExplain = async () => {
    try {
      await whenSaved(10_000);
    } catch {
      throw new Error("还有修改没等到文档服务确认（可能离线、连接慢，或同步已暂停），这次没有保存。等连上、处理完再保存。");
    }
  };

  /**
   * 打包保存:.procp = 编排 + 项目用到的素材(A1)。
   *
   * 和保存项目同一条规矩 —— pickSaveTarget 要用户手势,所以它必须是第一个 await,
   * 装包(从本地内容库按哈希取素材)只能排在挑好落点之后。包里素材按内容哈希去重,
   * 同一份素材被几条片段引用也只有一份字节。
   */
  const savePackedProject = async () => {
    const fileName = `${name}${PROCP_EXT}`;
    let target: FileSystemFileHandle | null = null;
    try {
      target = await pickSaveTarget(fileName, "PromptCut 打包项目", { "application/zip": [PROCP_EXT] });
    } catch (e) {
      if ((e as Error)?.name === "AbortError") return; // 用户取消,不是错误
      alert(String((e as Error).message));
      return;
    }
    try {
      await settledOrExplain();
      const blob = await packProcp();
      if (target) {
        const writable = await target.createWritable();
        await writable.write(blob);
        await writable.close();
      } else {
        // 这个 WebView 没有文件系统访问 API,退回浏览器下载
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = fileName;
        a.click();
        URL.revokeObjectURL(a.href);
        alert(`当前环境不支持选择目录，已保存到浏览器的下载位置：${fileName}`);
      }
    } catch (e) {
      alert(String((e as Error).message));
    }
  };

  /**
   * 导出视频。
   *
   * 和保存项目同一套路子:showSaveFilePicker 要用户手势,所以先弹「另存为」拿到
   * 落点,再开始渲染——渲染要几十秒,那之后手势早过期了。用户取消选位置就整个不导出。
   *
   * 挑不出位置(WebView 没这个 API)也照样能导:文件留在服务端的产物目录,
   * 结束时给一个「打开产物目录」。
   */
  const exportProject = async () => {
    const suggested = `${name}.mp4`;
    let target: FileSystemFileHandle | null = null;
    try {
      target = await pickSaveTarget(suggested, "MP4 视频", { "video/mp4": [".mp4"] });
    } catch (e) {
      if ((e as Error)?.name === "AbortError") return; // 用户取消,不是错误
      throw e;
    }

    setExportState({
      phase: "running",
      done: 0,
      // Seed a visible total immediately; the server also seeds this before
      // spawning Chrome, so the dialog never presents a misleading 0/0.
      total: Math.max(1, Math.floor(project.duration * (project.fps || 30))),
      target: target ? target.name : "产物目录（本机不支持选择位置）",
      startedAt: Date.now(),
    });

    try {
      const { outDir, id } = await exportVideo({
        onStart: (jobId) => {
          exportIdRef.current = jobId;
          setExportState((st) => (st ? { ...st, id: jobId } : st));
        },
        onProgress: (done, total, stage) =>
          setExportState((s) => (s && s.phase === "running" ? { ...s, done, total, stage } : s)),
      });

      // 渲染完了才把成品搬到用户选的位置;没选就留在产物目录里
      if (target) {
        const w = await target.createWritable();
        try {
          await streamExportFile(id, "preview.mp4", w);
          await w.close();
        } catch (error) {
          await w.abort?.();
          throw error;
        }
      }
      setExportState((s) => (s ? { ...s, phase: "done", outDir, done: s.total || 1, total: s.total || 1 } : s));
    } catch (e) {
      const err = e as Error & { cancelled?: boolean };
      setExportState((s) =>
        s ? { ...s, phase: err.cancelled ? "cancelled" : "error", message: err.message } : s,
      );
    } finally {
      exportIdRef.current = null;
    }
  };

  /** 新建项目:清空当前编排,并断开草稿绑定(保存时会新开一份) */
  const createProject = () => {
    if (dirty && !confirm("当前项目还有未保存的改动，新建会丢掉它们。继续？")) return;
    newProject();
    setActiveDraftId(null);
  };

  /**
   * 顶栏「打开项目…」。.proc 外面有一层 {format, project, ai} 的壳,importProjectFile
   * 只认裸 Project 和 {cards} 编排,拿它开 .proc 会直接报「无法识别」—— 所以 .proc 走
   * loadProc(连剧本和对话一起灌回去),其余的旧 JSON 才交给 importProjectFile。
   */
  const openProjectFile = async (file: File) => {
    if (dirty && !confirm("当前项目还有未保存的改动，打开别的项目会丢掉它们。继续？")) return;
    // .procp 是「编排 + 素材」的 zip 包(A1):先把素材按哈希拆进本地内容库,
    // 再拿里面那条 project.proc 走和 .proc 完全一样的路。不能先 file.text() ——
    // 那会把一个可能几 GB 的 zip 整份读进页面。
    if (await isProcpFile(file)) {
      actions.loadProject(await loadProcpFile(file), file.name.replace(/\.procp$/i, PROC_EXT));
      setActiveDraftId(null);
      forgetSaveTarget();
      return;
    }
    const text = await file.text();
    let isProc = false;
    try { isProc = JSON.parse(text)?.format === PROC_FORMAT; } catch { /* 交给下面报错 */ }
    if (isProc) actions.loadProject(loadProc(text), file.name);
    else await importProjectFile(file);
    // 从文件打开的不属于任何草稿;保存时重新问落点,别覆盖上一个项目的文件
    setActiveDraftId(null);
    forgetSaveTarget();
  };

  /** 回到开始页。Shell 在监听这个事件 */
  const goHome = () => {
    if (dirty && !confirm("当前项目还有未保存的改动，回首页会丢掉它们。继续？")) return;
    window.dispatchEvent(new Event("pc-go-home"));
  };

  /**
   * 把一份 .proc(通常是 Skill 的结果)三方合并进当前项目。
   *
   * 这个入口**没有基线**(手头只有一个文件,不知道两边是从哪儿分岔的),合并退化成
   * 「把对方多出来的加进来」:自己的一张卡都不动,同一个 id 上内容对不上就记冲突、保留自己的。
   * 从 Skill 对话框里合并会带上启动时的真快照,那时才分得清「谁改的」和「谁删的」。
   *
   * (曾经这里是拿当前项目当基线的 —— 那样「我有、对方没有」的每张卡都被判成对方删掉的,
   * 挑一份不相干的 .proc 会把整个项目清空替换。见 io/combineImport.ts。)
   */
  const mergeFromFile = async (file: File) => {
    try {
      const report = applyCombine(await file.text(), null);
      alert(`已把「${file.name}」合并到当前项目(记得保存):
${summarizeCombine(report)}

没有基线快照,所以只做了「加进来」:你原有的卡一张都没删。
两边同一张卡改得不一样时保留的是你的,上面会列成冲突。`);
    } catch (e) {
      alert(e instanceof Error ? e.message : "合并失败");
    }
  };

  // 标题栏菜单和顶栏里的按钮共用同一套动作，避免维护两份文件/导出逻辑。
  // WindowTitleBar 只负责呈现菜单，通过这个事件把选择交回编辑器。
  useEffect(() => {
    const onCommand = (event: Event) => {
      const command = (event as CustomEvent<string>).detail;
      switch (command) {
        case "new-project": createProject(); break;
        case "open-project": projectInput.current?.click(); break;
        case "save-project": if (!viewOnly) void saveProject(); break;
        case "export-video": void run(exportProject)(); break;
        case "go-home": goHome(); break;
        case "undo": actions.undo(); break;
        case "redo": actions.redo(); break;
        case "open-skin": setSkinOpen(true); break;
        case "open-voice": openVoiceSettings(); break;
        case "merge-project": mergeInput.current?.click(); break;
        case "shortcuts": alert("空格 播放/暂停\nCtrl/Cmd + Z 撤销\nCtrl/Cmd + Shift + Z 重做\nCtrl/Cmd + Y 重做\nDelete 删除选中片段"); break;
        case "about": alert("PromptCut\nAI 视频编辑器"); break;
      }
    };
    window.addEventListener("pc-titlebar-command", onCommand);
    return () => window.removeEventListener("pc-titlebar-command", onCommand);
  }, [viewOnly, dirty, name, project]);

  const toggleMoreMenu = () => {
    if (!menuOpen && moreBtnRef.current) {
      setMoreBtnRect(moreBtnRef.current.getBoundingClientRect());
    }
    setMenuOpen((prev) => !prev);
  };

  return (
    <div ref={barRef} className="pc-bar pc-bar--main">
      <Logo size={22} />
      {renaming ? (
        <input
          ref={renameInputRef}
          className="pc-projname pc-projname--editing"
          value={draftName}
          maxLength={80}
          placeholder="未命名"
          onChange={(e) => setDraftName(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            else if (e.key === "Escape") cancelRename();
          }}
        />
      ) : (
        <button
          type="button"
          className="pc-projname pc-projname--btn"
          title="点击重命名项目"
          onClick={startRename}
        >
          {name}
          {dirty && <span className="pc-dirty"> *</span>}
        </button>
      )}
      <span className="pc-bar-sep" />

      {/* A · 编辑控制:撤销与重做恒为纯图标态 */}
      <div className="pc-bar-group">
        {/* 禁用的按钮收不到悬停,提示挂在外面那层上(稿件:悬停提示含不可点时) */}
        <span title="撤销 (Ctrl+Z) —— 只撤你自己在这个页面做的" data-pc="undo-btn">
          <Btn onClick={() => actions.undo()} label="撤销" title="撤销 (Ctrl+Z) —— 只撤你自己在这个页面做的" icon={<IconUndo />} collapsed disabled={!canUndo} />
        </span>
        <span title="重做 (Ctrl+Shift+Z / Ctrl+Y) —— 恢复刚撤销的操作（有新操作后即失效）" data-pc="redo-btn">
          <Btn onClick={() => actions.redo()} label="重做" title="重做 (Ctrl+Shift+Z / Ctrl+Y) —— 恢复刚撤销的操作（有新操作后即失效）" icon={<IconRedo />} collapsed disabled={!canRedo} />
        </span>
      </div>
      <span className="pc-bar-sep" />

      {/*
        A' · AI 的浏览器页签(只在桌面壳里出现)。agent 撞上登录 / 验证码时不弹窗,
        这个页签闪并冒气泡,用户点过去才切到浏览器面板。任何宽度都在:它是 agent 和人之间的
        交接口,收进「⋯」里就没人看见闪了。
      */}
      <AgentBrowserTab />

      {/*
        B · 模式与项目设置。
        「传统式 / 对话式 / SKILL」是一个整体的三选一控件(ModeSwitch),不是下拉框 ——
        三个模式互斥,滑块在哪一格就是哪一格,一眼看得出还有哪两个可以去;下拉框收起来
        只看得见当前值。SKILL 也不该混进一个叫「布局」的下拉里,它根本不是布局。
        皮肤仍然只住在「⋯」里。
      */}
      {tier !== "narrow" && (
        <div className="pc-bar-group">
          <ModeSwitch onOpenSkill={() => setSkillOpen(true)} />
        </div>
      )}
      {/* 「⋯」任何宽度都在:皮肤只住在这里面,收起来就没入口了 */}
      <div className="pc-bar-group">
        <button
          ref={moreBtnRef}
          type="button"
          className="pc-btn pc-btn--icon"
          title="更多设置"
          aria-haspopup="true"
          aria-expanded={menuOpen}
          onClick={toggleMoreMenu}
        >
          <IconMore />
        </button>
      </div>

      {/* ⋯ 弹出浮层菜单 */}
      {menuOpen && createPortal(
        <div
          ref={menuRef}
          className="pc-more-menu"
          style={{
            top: (moreBtnRect?.bottom ?? 36) + 4,
            // 菜单挂在按钮右端往左展开,窄窗口下不会顶出屏幕
            left: Math.max(8, Math.min((moreBtnRect?.right ?? 0) - 200, window.innerWidth - 208)),
          }}
        >
          <button
            type="button"
            className="pc-btn"
            style={{ width: "100%", justifyContent: "flex-start" }}
            title="皮肤"
            onClick={() => {
              setMenuOpen(false);
              setSkinOpen(true);
            }}
          >
            <IconPalette />
            <span className="pc-btn-label">皮肤…</span>
          </button>
          {/* Skill 模式已经挪到条上的三选一控件里了(ModeSwitch),这里不再重复 */}
          <button
            type="button"
            className="pc-btn"
            style={{ width: "100%", justifyContent: "flex-start" }}
            title="挑一份 .proc,把它的改动三方合并进当前项目"
            onClick={() => {
              setMenuOpen(false);
              mergeInput.current?.click();
            }}
          >
            <IconImport />
            <span className="pc-btn-label">合并 Skill 结果…</span>
          </button>
          {/* 模式开关只在窄档收进来,宽档它还在条上;项目设置已经住进「项目」菜单 */}
          {tier === "narrow" && (
            <div className="pc-more-menu-row">
              <ModeSwitch onOpenSkill={() => { setMenuOpen(false); setSkillOpen(true); }} />
            </div>
          )}
        </div>,
        document.body,
      )}

      {/* 「项目」下拉菜单:挂在按钮下方,和 ⋯ 一样走 portal */}
      {projOpen && createPortal(
        <div
          ref={projMenuRef}
          className="pc-proj-menu"
          role="menu"
          style={{
            top: (projRect?.bottom ?? 36) + 6,
            left: Math.max(8, Math.min(projRect?.left ?? 0, window.innerWidth - 248)),
          }}
        >
          <button type="button" role="menuitem" className="pc-proj-item" onClick={() => { setProjOpen(false); createProject(); }}>
            <IconNew />
            <span className="pc-proj-text"><b>新建项目</b><small>开一个空项目</small></span>
          </button>
          <button type="button" role="menuitem" className="pc-proj-item" onClick={() => { setProjOpen(false); projectInput.current?.click(); }}>
            <IconOpen />
            <span className="pc-proj-text"><b>打开项目…</b><small>{PROC_EXT} 项目文件</small></span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="pc-proj-item"
            disabled={viewOnly}
            title={viewOnly ? "只读查看模式:改不了这个项目" : undefined}
            onClick={() => { setProjOpen(false); void saveProject(); }}
          >
            <IconSave />
            <span className="pc-proj-text"><b>保存项目</b><small>{dirty ? "有没保存的改动" : "已是最新"}</small></span>
            {dirty && <span className="pc-proj-dirty" />}
          </button>
          <button
            type="button"
            role="menuitem"
            className="pc-proj-item"
            disabled={viewOnly}
            title={viewOnly ? "只读查看模式:改不了这个项目" : "编排和素材打成一个包,换台机器直接打开"}
            onClick={() => { setProjOpen(false); void savePackedProject(); }}
          >
            <IconSave />
            <span className="pc-proj-text"><b>打包保存…</b><small>{PROCP_EXT} 连素材一起</small></span>
          </button>
          <div className="pc-proj-sep" role="separator" />
          <button type="button" role="menuitem" className="pc-proj-item" data-pc="menu-new-shared" disabled={viewOnly} onClick={() => { setProjOpen(false); setNewSharedOpen(true); }}>
            <IconNew />
            <span className="pc-proj-text"><b>新建共享项目</b><small>和他人一起编辑</small></span>
          </button>
          <button type="button" role="menuitem" className="pc-proj-item" data-pc="menu-open-shared" disabled={viewOnly} onClick={() => { setProjOpen(false); setOpenSharedOpen(true); }}>
            <IconOpen />
            <span className="pc-proj-text"><b>打开共享项目</b><small>加入已有项目</small></span>
          </button>
          <button type="button" role="menuitem" className="pc-proj-item" data-pc="menu-backups" onClick={() => { setProjOpen(false); setBackupsOpen(true); }}>
            <IconSave />
            <span className="pc-proj-text"><b>本地备份…</b><small>被覆盖、离线丢弃的修改</small></span>
          </button>
          <div className="pc-proj-sep" role="separator" />
          <button type="button" role="menuitem" className="pc-proj-item" onClick={() => { setProjOpen(false); setSettingsOpen(true); }}>
            <IconSettings />
            <span className="pc-proj-text"><b>项目设置…</b><small>尺寸、帧率、主题</small></span>
          </button>
        </div>,
        document.body,
      )}

      <span className="ml-auto" />

      {/* C6.5:同步已暂停 / 离线 / 共享项目的成员按钮 */}
      <div className="pc-bar-group">
        <SyncChips />
      </div>

      {/* 只读查看:告诉人这份是看的不是改的。真正拦住写盘的是服务端那道
          (server/vite-plugin-view-gate.ts),这里只是别让人白点一下才发现 */}
      {viewOnly && (
        <span className="pc-viewonly-badge" title="这个页面是用只读链接打开的:能看,不能改。项目由 Skill 任务里的 agent 负责修改。">
          只读查看
        </span>
      )}

      {/* C · 文件操作条:打开/保存参与中档收起,导出为主按钮永远不收起。
          导入视频已迁到左栏「素材 → 视频」的 + 按钮,顶栏不再重复 */}
      <div className="pc-bar-group">
        <Btn onClick={goHome} label="首页" icon={<IconHome />} collapsed={tier !== "wide"} />
        {/* 新建 / 打开 / 保存 / 项目设置收在这一个按钮里,点开才出子菜单(见 toggleProjMenu) */}
        <button
          ref={projBtnRef}
          type="button"
          className={`pc-btn pc-proj-btn${projOpen ? " is-open" : ""}`}
          title="项目:新建、打开、保存、设置"
          aria-haspopup="menu"
          aria-expanded={projOpen}
          onClick={toggleProjMenu}
        >
          <IconOpen />
          <span className="pc-btn-label">项目</span>
          <svg className="pc-proj-caret" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {dirty && <span className="pc-proj-dirty" title="有没保存的改动" />}
        </button>
        {/* 配音设置:开子窗口,和开始页配音卡的「设置」是同一个 */}
        <Btn onClick={openVoiceSettings} label="配音设置" icon={<IconVoice />} collapsed={tier !== "wide"} />
        <Btn
          onClick={run(exportProject)}
          label="导出视频"
          icon={<IconExport />}
          primary
          collapsed={false}
        />
      </div>

      <input
        ref={projectInput}
        type="file"
        accept={`${PROC_EXT},${PROCP_EXT},.json`}
        hidden
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) run(() => openProjectFile(f))(); }}
      />

      {/* 项目设置对话框 */}
      <SkinDialog open={skinOpen} onClose={() => setSkinOpen(false)} />
      <SkillDialog open={skillOpen} onClose={() => setSkillOpen(false)} />
      <input
        ref={mergeInput}
        type="file"
        accept={`${PROC_EXT},${PROCP_EXT},.json`}
        hidden
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void mergeFromFile(f); }}
      />
      <NewSharedDialog open={newSharedOpen} onClose={() => setNewSharedOpen(false)} />
      <OpenSharedDialog open={openSharedOpen} onClose={() => setOpenSharedOpen(false)} />
      <BackupsDialog open={backupsOpen} onClose={() => setBackupsOpen(false)} />
      <ProjectSettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
      <ExportDialog
        state={exportState}
        onCancel={() => {
          // 先把界面切成「取消中」的观感,服务端杀进程要一会儿;真正的
          // cancelled 状态由 SSE 回来时那一路负责写
          if (exportIdRef.current) void cancelExport(exportIdRef.current);
        }}
        onClose={() => setExportState(null)}
        onReveal={() => {
          if (exportState?.id) void revealExport(exportState.id);
        }}
      />
    </div>
  );
}
