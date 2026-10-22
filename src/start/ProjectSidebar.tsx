/**
 * 左侧栏:全部项目,三级结构(用户 2026-10-23 定的形状)。
 *
 *   分组
 *     ├ 项目
 *     │   └ 项目 Agent(这个项目里的 Agent 对话)
 *     └ 分组 Agent(跨这个分组里几个项目的对话)
 *
 * 三种东西各有自己的前置图标:分组是叠起来的方块,项目是取景框,Agent 是一颗星芒并染上 Agent 专属色
 * (`--ui-agent`,和编辑器 rail 上的 Agent 头像同一个色)。层级用缩进和一条竖导线表示,不画逐行的拐角 ——
 * 拐角要分「最后一个」和「中间的」,行一多就容易错位。
 *
 * 每一行都能右键(重命名 / 置顶 / 归档 / 删除,见 `RowMenu.tsx`)、都能拖着排序。**置顶和排序都只在
 * 自己同级里生效**:分组里的项目 A 置顶,只在那个分组里顶上去(规则与纯函数在 `treeState.ts`)。
 * 右边那条缝能拖,改侧栏宽度,记在本机(`sideWidth.ts`)。
 *
 * 点分组把右边那排筛成这个分组里的项目;点项目、点 Agent 现在只给一行「待办」。
 * 搜索只筛这一栏(右边那排跟着当前分组走,不跟搜索走),免得一边打字一边整页都在跳。
 */
import { useRef, useState } from "react";
import type { JSX, PointerEvent as ReactPointerEvent } from "react";
import { RowMenu, type MenuAt } from "./RowMenu";
import { SIDE_WIDTH, clampSideWidth } from "./sideWidth";
import type { TreeKind } from "./treeKind";
import { ordered, visible, type Place } from "./treeState";
import type { MockAgentChat, MockGroup, MockProject } from "./mockProjects";

/** 右边那排现在显示哪一堆 */
export type Scope = { kind: "all" } | { kind: "group"; id: string } | { kind: "loose" };

export const scopeKeyOf = (s: Scope): string => (s.kind === "group" ? `group:${s.id}` : s.kind);

/** 侧栏对外要的一组改动。全由 `OnlineStart` 拿着状态去做,这一栏只管什么时候调 */
export interface TreeOps {
  rename: (kind: TreeKind, id: string, name: string) => void;
  pin: (kind: TreeKind, id: string) => void;
  archive: (kind: TreeKind, id: string) => void;
  remove: (kind: TreeKind, id: string) => void;
  reorder: (kind: TreeKind, dragId: string, overId: string, place: Place) => void;
}

/** 分组:两片叠起来的方块 */
function GroupIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
      <rect x="3" y="7" width="13" height="13" rx="2" />
      <path d="M7.5 7V5.5A1.5 1.5 0 0 1 9 4h10.5A1.5 1.5 0 0 1 21 5.5V16a1.5 1.5 0 0 1-1.5 1.5H18" />
    </svg>
  );
}

/** 项目:取景框 */
function ProjectIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
      <rect x="3.5" y="5.5" width="17" height="13" rx="2" />
      <path d="M8 5.5v13M16 5.5v13" />
    </svg>
  );
}

/** Agent:星芒 */
function AgentIcon(): JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2.8c.5 4.3 2.1 6.1 6.4 6.6-4.3.5-5.9 2.3-6.4 6.6-.5-4.3-2.1-6.1-6.4-6.6 4.3-.5 5.9-2.3 6.4-6.6Z" />
      <path d="M18.4 15.2c.3 2.3 1.1 3.2 3.4 3.5-2.3.3-3.1 1.2-3.4 3.5-.3-2.3-1.1-3.2-3.4-3.5 2.3-.3 3.1-1.2 3.4-3.5Z" opacity="0.65" />
    </svg>
  );
}

/** 全部项目:网格 */
function AllIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </svg>
  );
}

/** 置顶的那个小图钉 */
function PinIcon(): JSX.Element {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M14.2 2.3 21.7 9.8l-1.8 1.8-1.5-.5-3.6 3.6.4 3.3-1.7 1.7-4-4-4.6 4.6-1.1-1.1 4.6-4.6-4-4 1.7-1.7 3.3.4 3.6-3.6-.5-1.5z" />
    </svg>
  );
}

/** 一行要的全部东西。三种行共用这一个渲染器,否则右键、拖动、重命名要抄三遍 */
interface RowSpec {
  kind: TreeKind;
  id: string;
  name: string;
  pinned: boolean;
  /** 同级的键:只有键相同的两行之间才允许拖动排序 */
  sib: string;
  icon: JSX.Element;
  /** 有下一层时给箭头;`undefined` 是叶子(位置仍然留着,好对齐) */
  expanded?: boolean;
  count?: number;
  current?: boolean;
  className?: string;
  pc: string;
  label: string;
  onClick: () => void;
}

export function ProjectSidebar(props: {
  groups: MockGroup[];
  projects: MockProject[];
  chats: MockAgentChat[];
  scope: Scope;
  onScope: (s: Scope) => void;
  onCreate: () => void;
  onOpen: (id: string) => void;
  onOpenChat: (chat: MockAgentChat) => void;
  /** 聊天页正开着的那条对话:它那一行标成当前项 */
  openChatId: string | null;
  /** 收起来了没有。收起时整条滑出去、宽度收到 0,收起键在顶栏上 */
  collapsed: boolean;
  ops: TreeOps;
  width: number;
  onWidth: (px: number) => void;
  onWidthCommit: (px: number) => void;
  /**
   * 在当前宽度上加减。方向键必须走这一条,不能自己算 `width + step` ——
   * 按住方向键时连发的几下都在同一帧里,每一下读到的 `width` 都还是旧的,算出来是同一个数,宽度就卡住不动了。
   */
  onWidthNudge: (delta: number) => void;
}): JSX.Element {
  const [open, setOpen] = useState<Record<string, boolean>>({ "g-brand": true });
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<MenuAt | null>(null);
  const [renaming, setRenaming] = useState<{ kind: TreeKind; id: string; name: string } | null>(null);
  /** 正在拖的那一行;dragover 时读它判同级(dataTransfer 在 dragover 里读不到内容) */
  const drag = useRef<{ kind: TreeKind; id: string; sib: string } | null>(null);
  const [dropAt, setDropAt] = useState<{ id: string; place: Place } | null>(null);

  const q = query.trim().toLowerCase();
  const hit = (text: string) => !q || text.toLowerCase().includes(q);

  // 归档的不进树;显示顺序由 ordered 定(置顶的在自己这一段的最前面)
  const groups = ordered(visible(props.groups));
  const allProjects = visible(props.projects);
  const allChats = visible(props.chats);

  const chatsOfProject = (id: string) =>
    ordered(allChats.filter((c) => c.on === "project" && c.projectId === id));
  const chatsOfGroup = (id: string) =>
    ordered(allChats.filter((c) => c.on === "group" && c.groupId === id));
  /** 项目自己名字命中,或它底下哪条对话命中,都算要显示 */
  const projectShows = (p: MockProject) => hit(p.name) || chatsOfProject(p.id).some((c) => hit(c.name));
  const projectsOf = (groupId: string | null) =>
    ordered(allProjects.filter((p) => p.groupId === groupId && projectShows(p)));

  /** 同级的键:分组一级,同一分组里的项目一级,挂在同一个项目(或分组)上的对话各一级 */
  const chatSib = (c: MockAgentChat) => (c.on === "project" ? `chat:p:${c.projectId}` : `chat:g:${c.groupId}`);
  const projectSib = (p: MockProject) => `project:${p.groupId ?? "loose"}`;

  const current = props.scope;
  const isAt = (s: Scope) =>
    s.kind === current.kind && (s.kind !== "group" || (current.kind === "group" && s.id === current.id));

  /** 一行。右键、拖动、重命名都在这儿,三种行只是传进来的 spec 不同 */
  const row = (spec: RowSpec): JSX.Element => {
    const isRenaming = renaming?.kind === spec.kind && renaming.id === spec.id;
    const dropping = dropAt?.id === spec.id ? dropAt.place : null;
    const common = {
      "data-pc": spec.pc,
      "data-dragging": drag.current?.id === spec.id || undefined,
      "data-drop": dropping ?? undefined,
    };

    if (isRenaming) {
      // 改名时那一行换成输入框。<input> 不能放在 <button> 里,所以整行换成 div
      return (
        <div key={spec.id} className={`ps-row is-renaming${spec.className ? ` ${spec.className}` : ""}`} {...common}>
          <span className="ps-row-caret" data-empty={spec.expanded === undefined} aria-hidden="true">›</span>
          <span className={`ps-row-icon${spec.kind === "chat" ? " is-agent" : ""}`}>{spec.icon}</span>
          <input
            className="ps-rename"
            data-pc="start-rename-input"
            autoFocus
            defaultValue={spec.name}
            aria-label={`重命名${spec.name}`}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                props.ops.rename(spec.kind, spec.id, e.currentTarget.value);
                setRenaming(null);
              } else if (e.key === "Escape") {
                e.preventDefault();
                setRenaming(null);
              }
            }}
            // 点到别处就当改完了(和改名框里按回车一致);按 Esc 走上面那一支,不会走到这里
            onBlur={(e) => {
              props.ops.rename(spec.kind, spec.id, e.currentTarget.value);
              setRenaming(null);
            }}
          />
        </div>
      );
    }

    return (
      <button
        key={spec.id}
        type="button"
        className={`ps-row${spec.className ? ` ${spec.className}` : ""}`}
        {...common}
        data-group={spec.kind === "group" ? spec.id : undefined}
        data-project={spec.kind === "project" ? spec.id : undefined}
        data-agent={spec.kind === "chat" ? spec.id : undefined}
        aria-label={spec.label}
        aria-expanded={spec.expanded}
        aria-current={spec.current}
        title={spec.name}
        draggable
        onClick={spec.onClick}
        onContextMenu={(e) => {
          e.preventDefault();
          setRenaming(null);
          setMenu({ id: spec.id, kind: spec.kind, name: spec.name, pinned: spec.pinned, x: e.clientX, y: e.clientY });
        }}
        onDragStart={(e) => {
          drag.current = { kind: spec.kind, id: spec.id, sib: spec.sib };
          e.dataTransfer.effectAllowed = "move";
          // 有的浏览器不带数据就不开始拖
          e.dataTransfer.setData("text/plain", spec.id);
        }}
        onDragEnd={() => {
          drag.current = null;
          setDropAt(null);
        }}
        onDragOver={(e) => {
          const d = drag.current;
          // 只许同级之间排序:别的一律不接(不 preventDefault 就是不允许放)
          if (!d || d.id === spec.id || d.kind !== spec.kind || d.sib !== spec.sib) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          const box = e.currentTarget.getBoundingClientRect();
          setDropAt({ id: spec.id, place: e.clientY < box.top + box.height / 2 ? "before" : "after" });
        }}
        onDragLeave={() => setDropAt((at) => (at?.id === spec.id ? null : at))}
        onDrop={(e) => {
          const d = drag.current;
          if (!d || !dropAt) return;
          e.preventDefault();
          props.ops.reorder(spec.kind, d.id, spec.id, dropAt.place);
          drag.current = null;
          setDropAt(null);
        }}
      >
        <span className="ps-row-caret" data-empty={spec.expanded === undefined} data-open={spec.expanded} aria-hidden="true">›</span>
        <span className={`ps-row-icon${spec.kind === "chat" ? " is-agent" : ""}`}>{spec.icon}</span>
        <span className="ps-row-name">{spec.name}</span>
        {spec.pinned && <span className="ps-row-pin" title="已置顶"><PinIcon /></span>}
        {spec.count !== undefined && <span className="ps-row-count">{spec.count}</span>}
      </button>
    );
  };

  const chatRow = (chat: MockAgentChat) =>
    row({
      kind: "chat",
      id: chat.id,
      name: chat.name,
      pinned: !!chat.pinned,
      sib: chatSib(chat),
      icon: <AgentIcon />,
      className: "is-agent",
      current: props.openChatId === chat.id,
      pc: "start-side-agent",
      label: `Agent 对话 ${chat.name}${chat.pinned ? "（已置顶）" : ""}`,
      onClick: () => props.onOpenChat(chat),
    });

  /** 一个项目,连同它底下的项目 Agent */
  const projectBlock = (p: MockProject) => {
    const chats = chatsOfProject(p.id);
    // 搜索时自动展开命中的那一支:不然搜到了却看不见在哪
    const expanded = q ? chats.some((c) => hit(c.name)) : !!open[p.id];
    return (
      <div key={p.id}>
        {row({
          kind: "project",
          id: p.id,
          name: p.name,
          pinned: !!p.pinned,
          sib: projectSib(p),
          icon: <ProjectIcon />,
          expanded: chats.length ? expanded : undefined,
          pc: "start-side-project",
          label: `项目 ${p.name}${chats.length ? `，${chats.length} 个 Agent 对话` : ""}${p.pinned ? "，已置顶" : ""}`,
          onClick: () => {
            props.onOpen(p.id);
            if (chats.length) setOpen((o) => ({ ...o, [p.id]: !o[p.id] }));
          },
        })}
        {expanded && chats.length > 0 && <div className="ps-sub">{chats.map(chatRow)}</div>}
      </div>
    );
  };

  /** 拖右边那条缝改宽度 */
  const onGrip = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const grip = e.currentTarget;
    const startX = e.clientX;
    const startW = props.width;
    grip.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => props.onWidth(clampSideWidth(startW + (ev.clientX - startX)));
    const up = (ev: PointerEvent) => {
      props.onWidthCommit(clampSideWidth(startW + (ev.clientX - startX)));
      grip.releasePointerCapture(e.pointerId);
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
  };

  return (
    <aside
      className="ps-side"
      data-pc="start-side"
      data-collapsed={props.collapsed}
      /* 收起就是把 flex-basis 收到 0;宽度本来就是行内样式给的,收起也得走行内,不然类选择器压不过它 */
      style={{ flexBasis: props.collapsed ? 0 : `${props.width}px` }}
    >
      {/* 里面这一层钉住原来的宽度:收的时候内容整块滑出去,不会先被挤成一条再消失 */}
      <div className="ps-side-inner" style={{ width: `${props.width}px` }}>
      <button type="button" className="ps-side-new" data-pc="start-side-new" onClick={props.onCreate}>
        <span aria-hidden="true">＋</span>新建项目
      </button>

      <label className="ps-search">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <circle cx="11" cy="11" r="6.5" />
          <path d="m16 16 4.5 4.5" />
        </svg>
        <input
          type="search"
          value={query}
          placeholder="搜项目和对话"
          aria-label="搜项目和对话"
          data-pc="start-side-search"
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>

      <div className="ps-side-scroll">
        <div className="ps-side-group">
          <button
            type="button"
            className="ps-row"
            data-pc="start-scope-all"
            aria-label={`全部项目，共 ${allProjects.length} 个`}
            aria-current={isAt({ kind: "all" })}
            onClick={() => props.onScope({ kind: "all" })}
          >
            <span className="ps-row-caret" data-empty aria-hidden="true">›</span>
            <span className="ps-row-icon"><AllIcon /></span>
            <span className="ps-row-name">全部项目</span>
            <span className="ps-row-count">{allProjects.length}</span>
          </button>
        </div>

        <div className="ps-side-group">
          <div className="ps-side-label">分组</div>
          {groups.map((g) => {
            const rows = projectsOf(g.id);
            const groupChats = chatsOfGroup(g.id).filter((c) => hit(c.name));
            const expanded = q ? rows.length > 0 || groupChats.length > 0 : !!open[g.id];
            return (
              <div key={g.id}>
                {row({
                  kind: "group",
                  id: g.id,
                  name: g.name,
                  pinned: !!g.pinned,
                  sib: "group",
                  icon: <GroupIcon />,
                  expanded,
                  count: rows.length,
                  current: isAt({ kind: "group", id: g.id }),
                  pc: "start-scope-group",
                  label: `分组 ${g.name}，${rows.length} 个项目${g.pinned ? "，已置顶" : ""}`,
                  onClick: () => {
                    props.onScope({ kind: "group", id: g.id });
                    setOpen((o) => ({ ...o, [g.id]: !o[g.id] }));
                  },
                })}
                {expanded && (
                  <div className="ps-sub">
                    {rows.map(projectBlock)}
                    {groupChats.map(chatRow)}
                  </div>
                )}
              </div>
            );
          })}
          <button type="button" className="ps-row" data-pc="start-new-group" aria-label="新建分组" title="待办：分组还没有业务层">
            <span className="ps-row-caret" data-empty aria-hidden="true">›</span>
            <span className="ps-row-icon" aria-hidden="true">＋</span>
            <span className="ps-row-name ps-muted">新建分组</span>
          </button>
        </div>

        <div className="ps-side-group">
          <div className="ps-side-label">未分组</div>
          <button
            type="button"
            className="ps-row"
            data-pc="start-scope-loose"
            aria-label={`未分组，${projectsOf(null).length} 个项目`}
            aria-current={isAt({ kind: "loose" })}
            onClick={() => props.onScope({ kind: "loose" })}
          >
            <span className="ps-row-caret" data-empty aria-hidden="true">›</span>
            <span className="ps-row-icon"><AllIcon /></span>
            <span className="ps-row-name">没放进分组</span>
            <span className="ps-row-count">{projectsOf(null).length}</span>
          </button>
          <div className="ps-sub">{projectsOf(null).map(projectBlock)}</div>
        </div>
      </div>

      </div>

      {/* 右边那条缝:拖着改宽度,双击回到默认;方向键也能调(只能用鼠标就把键盘用户关在门外了)。收起时没有 */}
      {!props.collapsed && <div
        className="ps-side-grip"
        data-pc="start-side-grip"
        role="separator"
        aria-orientation="vertical"
        aria-label="侧栏宽度"
        aria-valuemin={SIDE_WIDTH.min}
        aria-valuemax={SIDE_WIDTH.max}
        aria-valuenow={props.width}
        tabIndex={0}
        onPointerDown={onGrip}
        onDoubleClick={() => props.onWidthCommit(SIDE_WIDTH.def)}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 32 : 8;
          if (e.key === "ArrowLeft") { e.preventDefault(); props.onWidthNudge(-step); }
          if (e.key === "ArrowRight") { e.preventDefault(); props.onWidthNudge(step); }
          if (e.key === "Home") { e.preventDefault(); props.onWidthCommit(SIDE_WIDTH.def); }
        }}
      />}

      {menu && (
        <RowMenu
          at={menu}
          onClose={() => setMenu(null)}
          onRename={() => setRenaming({ kind: menu.kind, id: menu.id, name: menu.name })}
          onPin={() => props.ops.pin(menu.kind, menu.id)}
          onArchive={() => props.ops.archive(menu.kind, menu.id)}
          onDelete={() => props.ops.remove(menu.kind, menu.id)}
        />
      )}
    </aside>
  );
}
