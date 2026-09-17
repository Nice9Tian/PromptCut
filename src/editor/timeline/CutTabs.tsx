import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { actions, useStore } from "../../store/project";
import { listCuts } from "../../kernel/cuts";
import { CUTS_ITEM } from "../dock/railLayout";
import { beginRailPointer } from "../dock/railDrag";
import { RAIL_MORE_H, RailMoreButton, RailOverflowMenu, useRoomBelow } from "../dock/railOverflow";
import { shortLabel } from "../right/chat/RightRail";
import "./cut-tabs.css";

/** 一格剪辑:56 高的 rail 项 + 4 间距 */
const CUT_ROW_H = 60;
/** 底下「+」32 高 + 4 间距 */
const ADD_H = 36;

/** 胶片:圆角方块里一格画面,两侧各三个齿孔 */
function IconFilm() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="2" width="12" height="12" rx="1.6" />
      <path d="M5 2v12M11 2v12" />
      <path d="M2 5h3M2 8h3M2 11h3M11 5h3M11 8h3M11 11h3" strokeWidth="1.1" />
    </svg>
  );
}

/**
 * 侧边 rail 上的剪辑组:一个项目里可以有多条时间轴(剪辑),每条一格 rail 项(和 Agent 分页同一个样子:
 * 上面一个方形胶片图标、下面名字),单击切换、双击改名、悬停出 × 删除(有内容的先确认),底下「+」新建。
 * 数据全在 project.cuts / activeCutId 上(见 kernel/project.ts 的 Cut),这里只是个视图。
 *
 * 整组是 rail 上的一项(railLayout 的 CUTS_ITEM):按住组里任何一格拖动,整组一起挪到别的位置 / 另一条 rail
 * (外层带 data-pc-dock-group,railDrag 克隆整组当跟手图标)。它没有页面,不会成为选中项、也不开抽屉。
 *
 * 位置:它画在 rail 贴着时间轴卡片的那一截里(RailBar part="tail"),顶边就是时间轴卡片的顶边,
 * 那一截顶上一道小横线和上半部分分开。到时间轴底边放不下的剪辑收进「▾」(railOverflow);当前剪辑总是留在外面。
 */
export function CutsRailGroup() {
  const project = useStore((s) => s.project);
  const cuts = listCuts(project);
  const [editing, setEditing] = useState<string | null>(null);
  const grab = (e: ReactPointerEvent<HTMLElement>) => beginRailPointer(e, CUTS_ITEM);

  const ref = useRef<HTMLDivElement>(null);
  const room = useRoomBelow(ref, () => ref.current?.parentElement);
  const fitAll = Math.floor((room - ADD_H) / CUT_ROW_H);
  const rows = cuts.length <= fitAll ? cuts.length : Math.max(1, Math.floor((room - ADD_H - RAIL_MORE_H) / CUT_ROW_H));

  // 当前剪辑不在前几格里就顶掉最后一格
  let shown = cuts;
  let hidden: typeof cuts = [];
  if (cuts.length > rows) {
    shown = cuts.slice(0, rows);
    const active = cuts.find((c) => c.active);
    if (active && !shown.includes(active)) shown = [...shown.slice(0, rows - 1), active];
    hidden = cuts.filter((c) => !shown.includes(c));
  }

  const [menuOpen, setMenuOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (hidden.length === 0) setMenuOpen(false);
  }, [hidden.length]);

  const tab = (c: (typeof cuts)[number], inMenu: boolean) => (
    <Tab
      key={c.id}
      inMenu={inMenu}
      id={c.id}
      name={c.name}
      active={c.active}
      clipCount={c.clipCount}
      canRemove={cuts.length > 1}
      editing={editing === c.id}
      onEdit={() => setEditing(c.id)}
      onDone={() => setEditing(null)}
      onGrab={grab}
      onPicked={() => setMenuOpen(false)}
    />
  );

  return (
    <div
      ref={ref}
      className="pc-dock-slot pc-rail-cuts"
      data-pc-dock-item={CUTS_ITEM}
      data-pc-dock-group=""
      data-pc="cut-tabs"
      role="tablist"
      aria-label="剪辑"
      aria-orientation="vertical"
    >
      {shown.map((c) => tab(c, false))}
      {hidden.length > 0 && (
        <RailMoreButton
          ref={moreRef}
          dataPc="cut-more"
          count={hidden.length}
          open={menuOpen}
          title={`还有 ${hidden.length} 条剪辑`}
          onPointerDown={grab}
          onToggle={() => setMenuOpen((v) => !v)}
        />
      )}
      <button
        type="button"
        className="pc-rail-item pc-dock-add pc-rail-cut-add"
        data-pc="cut-add"
        title="新建剪辑"
        aria-label="新建剪辑"
        onPointerDown={grab}
        onClick={() => actions.addCut()}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
          <path d="M8 3v10M3 8h10" />
        </svg>
      </button>
      {menuOpen && hidden.length > 0 && (
        <RailOverflowMenu dataPc="cut-menu" anchor={moreRef.current} onClose={() => setMenuOpen(false)}>
          {hidden.map((c) => tab(c, true))}
        </RailOverflowMenu>
      )}
    </div>
  );
}

function Tab({
  inMenu, id, name, active, clipCount, canRemove, editing, onEdit, onDone, onGrab, onPicked,
}: {
  /** 子窗口里的一行(不能拖,点了关窗口);否则是 rail 上的一格(拖它挪整组) */
  inMenu: boolean;
  id: string; name: string; active: boolean; clipCount: number; canRemove: boolean;
  editing: boolean; onEdit: () => void; onDone: () => void;
  onGrab: (e: ReactPointerEvent<HTMLElement>) => void;
  onPicked: () => void;
}) {
  const [draft, setDraft] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      setDraft(name);
      // 等 input 挂上再选中全文
      requestAnimationFrame(() => inputRef.current?.select());
    }
  }, [editing, name]);

  const commit = () => {
    const next = draft.trim();
    if (next && next !== name) actions.renameCut(id, next);
    onDone();
  };

  const remove = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (clipCount > 0 && !window.confirm(`「${name}」里有 ${clipCount} 段内容,确定删除这条剪辑?`)) return;
    actions.removeCut(id);
  };

  const switchTo = () => {
    if (!active) actions.switchCut(id);
  };

  return (
    <div className="pc-rr-tab pc-rail-cut-slot">
      <div
        role="tab"
        tabIndex={0}
        aria-selected={active}
        data-pc-cut={id}
        className={`pc-rail-item pc-rail-cut${active ? " is-on" : ""}`}
        onPointerDown={!inMenu && !editing ? onGrab : undefined}
        onClick={() => {
          if (editing) return;
          switchTo();
          if (inMenu) onPicked();
        }}
        onDoubleClick={onEdit}
        onKeyDown={(e) => {
          if (!editing && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            switchTo();
          }
        }}
        title={editing ? undefined : `${name}\n单击切换,双击改名${inMenu ? "" : ",拖动挪整组"}`}
      >
        <span className="pc-rail-cut-glyph" aria-hidden="true">
          <IconFilm />
        </span>
        {editing ? (
          <input
            ref={inputRef}
            className="pc-rail-cut-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") commit();
              else if (e.key === "Escape") onDone();
            }}
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="pc-rr-label pc-rail-cut-name">{inMenu ? name : shortLabel(name)}</span>
        )}
      </div>
      {canRemove && !editing && (
        <button
          type="button"
          className="pc-rr-x"
          title="删除这条剪辑"
          aria-label={`删除 ${name}`}
          // 点 × 不算开始拖动
          onPointerDown={(e) => e.stopPropagation()}
          onClick={remove}
        >
          ×
        </button>
      )}
    </div>
  );
}
