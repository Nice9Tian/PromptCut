import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { actions, useStore } from "../store/project";
import { cancelExport, exportVideo, fetchExportFile, revealExport, importProjectFile } from "./io";
import { newProject, pickSaveTarget, serializeProc, writeProcToDisk, PROC_EXT } from "./io/proc";
import { ExportDialog, type ExportState } from "./ExportDialog";
import { ensureActiveDraftId, saveDraft, setActiveDraftId } from "./io/drafts";
import { useSkin } from "../skins/useSkin";
import { skinGroups } from "../skins/skins";
import { Logo } from "../ui/Logo";
import {
  IconExport,
  IconHome,
  IconNew,
  IconMore,
  IconOpen,
  IconRedo,
  IconSave,
  IconSettings,
  IconUndo,
} from "../ui/icons";
import { type LayoutMode, setLayoutMode, useLayoutMode } from "./layoutMode";
import { ProjectSettingsDialog } from "./ProjectSettingsDialog";
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
}: {
  onClick: () => void;
  label: string;
  icon?: React.ReactNode;
  primary?: boolean;
  collapsed?: boolean;
}) {
  return (
    <button
      title={label}
      onClick={onClick}
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
  const [menuOpen, setMenuOpen] = useState(false);
  const [moreBtnRect, setMoreBtnRect] = useState<DOMRect | null>(null);

  const name = useStore((s) => s.project.name);
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

  const { skinId, setSkin } = useSkin();
  const layoutMode = useLayoutMode();

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

  // 档位切回 wide/icon 时自动收起更多菜单
  useEffect(() => {
    if (tier !== "narrow" && menuOpen) {
      setMenuOpen(false);
    }
  }, [tier, menuOpen]);

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
      const text = serializeProc();
      const outcome = await writeProcToDisk(text, fileName);
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
      total: 0,
      target: target ? target.name : "产物目录（本机不支持选择位置）",
      startedAt: Date.now(),
    });

    try {
      const { outDir, id } = await exportVideo({
        onStart: (jobId) => {
          exportIdRef.current = jobId;
          setExportState((st) => (st ? { ...st, id: jobId } : st));
        },
        onProgress: (done, total) =>
          setExportState((s) => (s && s.phase === "running" ? { ...s, done, total } : s)),
      });

      // 渲染完了才把成品搬到用户选的位置;没选就留在产物目录里
      if (target) {
        const blob = await fetchExportFile(id, "preview.mp4");
        const w = await target.createWritable();
        await w.write(blob);
        await w.close();
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

  /** 回到开始页。Shell 在监听这个事件 */
  const goHome = () => {
    if (dirty && !confirm("当前项目还有未保存的改动，回首页会丢掉它们。继续？")) return;
    window.dispatchEvent(new Event("pc-go-home"));
  };

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
        <Btn onClick={() => actions.undo()} label="撤销" icon={<IconUndo />} collapsed />
        <Btn onClick={() => actions.redo()} label="重做" icon={<IconRedo />} collapsed />
      </div>
      <span className="pc-bar-sep" />

      {/* B · 外观与布局:宽档/中档在顶栏显示,窄档整组收进 ⋯ 弹出菜单 */}
      {tier !== "narrow" ? (
        <div className="pc-bar-group">
          <label className="pc-bar-label" title="皮肤">皮肤</label>
          <select
            value={skinId}
            onChange={(e) => setSkin(e.target.value)}
            className="pc-select"
            title="选择皮肤"
          >
            {skinGroups().map((g) => (
              <optgroup key={g.group} label={g.group}>
                {g.items.map((sk) => (
                  <option key={sk.id} value={sk.id}>
                    {sk.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <label className="pc-bar-label" title="布局">布局</label>
          <select
            value={layoutMode}
            onChange={(e) => setLayoutMode(e.target.value as LayoutMode)}
            className="pc-select"
            title="选择布局模式"
          >
            <option value="classic">传统式</option>
            <option value="chat">对话式</option>
          </select>
          <Btn
            onClick={() => setSettingsOpen(true)}
            label="项目设置"
            icon={<IconSettings />}
            collapsed={tier !== "wide"}
          />
        </div>
      ) : (
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
      )}

      {/* ⋯ 弹出浮层菜单 */}
      {menuOpen && tier === "narrow" && createPortal(
        <div
          ref={menuRef}
          className="pc-more-menu"
          style={{
            top: (moreBtnRect?.bottom ?? 36) + 4,
            left: Math.max(8, moreBtnRect?.left ?? 0),
          }}
        >
          <div className="pc-more-menu-row">
            <label className="pc-bar-label" title="皮肤">皮肤</label>
            <select
              value={skinId}
              onChange={(e) => setSkin(e.target.value)}
              className="pc-select"
              title="选择皮肤"
            >
              {skinGroups().map((g) => (
                <optgroup key={g.group} label={g.group}>
                  {g.items.map((sk) => (
                    <option key={sk.id} value={sk.id}>
                      {sk.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
          <div className="pc-more-menu-row">
            <label className="pc-bar-label" title="布局">布局</label>
            <select
              value={layoutMode}
              onChange={(e) => setLayoutMode(e.target.value as LayoutMode)}
              className="pc-select"
              title="选择布局模式"
            >
              <option value="classic">传统式</option>
              <option value="chat">对话式</option>
            </select>
          </div>
          <button
            type="button"
            className="pc-btn"
            style={{ width: "100%", justifyContent: "flex-start" }}
            title="项目设置"
            onClick={() => {
              setMenuOpen(false);
              setSettingsOpen(true);
            }}
          >
            <IconSettings />
            <span className="pc-btn-label">项目设置</span>
          </button>
        </div>,
        document.body,
      )}

      <span className="ml-auto" />

      {/* C · 文件操作条:打开/保存参与中档收起,导出为主按钮永远不收起。
          导入视频已迁到左栏「素材 → 视频」的 + 按钮,顶栏不再重复 */}
      <div className="pc-bar-group">
        <Btn onClick={goHome} label="首页" icon={<IconHome />} collapsed={tier !== "wide"} />
        <Btn onClick={createProject} label="新建项目" icon={<IconNew />} collapsed={tier !== "wide"} />
        <Btn
          onClick={() => projectInput.current?.click()}
          label="打开项目"
          icon={<IconOpen />}
          collapsed={tier !== "wide"}
        />
        <Btn
          onClick={saveProject}
          label="保存项目"
          icon={<IconSave />}
          collapsed={tier !== "wide"}
        />
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
        accept={`${PROC_EXT},.json`}
        hidden
        onChange={(e) => e.target.files?.[0] && run(() => importProjectFile(e.target.files![0]))()}
      />

      {/* 项目设置对话框 */}
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
