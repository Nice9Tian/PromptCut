import "./debug";
import "./left.css";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentType } from "react";
import { onCaptionsRequest } from "./captionsBus";
import { setRailCollapsed, toggleRailCollapsed, useRailCollapsed } from "../sideRails";
import { playEnter } from "../enterMotion";
import { readStored, writeStored } from "./stored";
import { RailIconCaptions, RailIconEdit, RailIconEffects, RailIconLibrary } from "./railIcons";
import { LibrarySection } from "./LibrarySection";
import { EffectsSection } from "./EffectsSection";
import { EditSection } from "./EditSection";
import { CaptionsSection } from "./CaptionsSection";

/**
 * 左栏 = 竖向 rail + 抽屉卡片。
 *
 *   rail   素材库 / 特效 / 编辑 / 字幕
 *          点另一项 = 切换分区(收起着就顺手展开);点当前已选中项 = 收起 / 展开抽屉(sideRails)
 *   抽屉   四个分区常驻挂载,只用行内 display 显隐 —— 切来切去不丢滚动位置、搜索词和草稿。
 *          收起时整块 display:none,整列宽度由 Editor.tsx 按 sideRails 算。
 *
 * 选中分区记在 localStorage `pc.left.section`(默认 library)。
 * 时间轴 / 素材库右键「转写字幕」走 captionsBus:切到字幕分区、展开抽屉、聚焦那份素材。
 */
type Section = "library" | "effects" | "edit" | "captions";

const SECTIONS: { key: Section; label: string; Icon: ComponentType }[] = [
  { key: "library", label: "素材库", Icon: RailIconLibrary },
  { key: "effects", label: "特效", Icon: RailIconEffects },
  { key: "edit", label: "编辑", Icon: RailIconEdit },
  { key: "captions", label: "字幕", Icon: RailIconCaptions },
];
const SECTION_KEYS = SECTIONS.map((s) => s.key);
const SECTION_STORE = "pc.left.section";

export function LeftPanel() {
  const collapsed = useRailCollapsed("left");
  const [section, setSection] = useState<Section>(() => readStored(SECTION_STORE, SECTION_KEYS, "library"));
  const [captionMediaId, setCaptionMediaId] = useState<string | null>(null);
  const [revealToken, setRevealToken] = useState(0);

  const pick = useCallback((next: Section) => {
    setSection(next);
    writeStored(SECTION_STORE, next);
  }, []);

  const onRail = (key: Section) => {
    if (key === section) {
      toggleRailCollapsed("left");
      return;
    }
    pick(key);
    setRailCollapsed("left", false);
  };

  // 时间轴上右键「转写字幕」也走这里:切到字幕分区、把抽屉拉出来、聚焦那份素材
  useEffect(
    () =>
      onCaptionsRequest((id) => {
        pick("captions");
        setRailCollapsed("left", false);
        setCaptionMediaId(id);
        setRevealToken((n) => n + 1);
      }),
    [pick],
  );

  // 切分区时新露出来的那一块淡入、上浮一点(enterMotion)。
  // 收起着切、或者切的同时把抽屉展开了,交给抽屉自己的展开动画(left.css),不叠两层
  const paneRefs = useRef<Partial<Record<Section, HTMLDivElement | null>>>({});
  const prevShown = useRef({ section, collapsed });
  useLayoutEffect(() => {
    const prev = prevShown.current;
    prevShown.current = { section, collapsed };
    if (prev.section === section || collapsed || prev.collapsed) return;
    playEnter(paneRefs.current[section], "pc-enter-rise");
  }, [section, collapsed]);

  const shown = (key: Section) => ({ display: section === key ? "flex" : "none" });

  return (
    <div data-pc="left" className="pc-left">
      <nav className="pc-rail pc-rail--left" data-pc="left-rail" aria-label="左栏分区">
        {SECTIONS.map(({ key, label, Icon }) => {
          const on = section === key;
          return (
            <button
              key={key}
              type="button"
              data-pc-rail={key}
              className={`pc-rail-item${on ? " is-on" : ""}`}
              aria-pressed={on}
              aria-expanded={on ? !collapsed : undefined}
              title={on ? (collapsed ? `展开「${label}」` : `收起「${label}」`) : label}
              onClick={() => onRail(key)}
            >
              <Icon />
              <span>{label}</span>
            </button>
          );
        })}
      </nav>

      <div
        className="pc-card-surface pc-left-drawer"
        data-pc="left-drawer"
        data-pc-collapsed={collapsed ? "" : undefined}
        style={{ display: collapsed ? "none" : "flex" }}
      >
        <div className="pc-left-pane" ref={(el) => { paneRefs.current.library = el; }} style={shown("library")}>
          <LibrarySection />
        </div>
        <div className="pc-left-pane" ref={(el) => { paneRefs.current.effects = el; }} style={shown("effects")}>
          <EffectsSection />
        </div>
        <div className="pc-left-pane" ref={(el) => { paneRefs.current.edit = el; }} style={shown("edit")}>
          <EditSection />
        </div>
        <div className="pc-left-pane" ref={(el) => { paneRefs.current.captions = el; }} style={shown("captions")}>
          <CaptionsSection
            mediaId={captionMediaId}
            onPick={setCaptionMediaId}
            revealToken={revealToken}
            onGoImport={() => pick("library")}
          />
        </div>
      </div>
    </div>
  );
}
