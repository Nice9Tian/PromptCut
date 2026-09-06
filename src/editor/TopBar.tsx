import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { actions, useStore } from "../store/project";
import { exportProjectJson, exportVideo, importProjectFile } from "./io";
import { useSkin } from "../skins/useSkin";
import { skinGroups } from "../skins/skins";
import { Logo } from "../ui/Logo";
import {
  IconExport,
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

  const saveProject = () => {
    try {
      const json = exportProjectJson();
      const blob = new Blob([json], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${name}.promptcut.json`;
      a.click();
    } catch (e) {
      alert(String((e as Error).message));
    }
  };

  const toggleMoreMenu = () => {
    if (!menuOpen && moreBtnRef.current) {
      setMoreBtnRect(moreBtnRef.current.getBoundingClientRect());
    }
    setMenuOpen((prev) => !prev);
  };

  return (
    <div ref={barRef} className="pc-bar">
      <Logo size={22} />
      <span className="pc-projname">
        {name}
        {dirty && <span className="pc-dirty"> *</span>}
      </span>
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
          onClick={run(() =>
            exportVideo({ onProgress: (d, n) => console.log(`export ${d}/${n}`) }).then((r) =>
              alert(`导出完成:${r.outDir}`),
            ),
          )}
          label="导出视频"
          icon={<IconExport />}
          primary
          collapsed={false}
        />
      </div>

      <input
        ref={projectInput}
        type="file"
        accept=".json"
        hidden
        onChange={(e) => e.target.files?.[0] && run(() => importProjectFile(e.target.files![0]))()}
      />

      {/* 项目设置对话框 */}
      <ProjectSettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  );
}
