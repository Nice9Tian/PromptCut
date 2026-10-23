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
 * 点分组把右边那排筛成这个分组里的项目;点项目进这个项目(连上云端文档服务,`OnlineStart.tsx` 的 `openProject`),
 * 进了之后它底下列出当前账号看得到的项目 Agent(云端 Agent 对话)和一行「新对话」;点 Agent 进聊天页。
 * 只有此刻连着的那个项目列得出对话(对话要凭这个项目的身份向云端 Agent 服务要),别的项目点进去才列。
 * 搜索只筛这一栏(右边那排跟着当前分组走,不跟搜索走),免得一边打字一边整页都在跳。
 *
 * 2026-10-23 接业务层:项目来自云端项目列表(桌面版是本机草稿),对话来自云端 Agent 服务(桌面版是本机 Agent)。
 * 分组分两套、互相放不进:本地分组装本机草稿项目、存本机;云端分组装云端项目、存云端(`vibeOrg.ts` 文件头)。
 * 每个分组、每个项目都带 `realm`,右键「移到分组」里另一套的分组置灰并说明。「分组 Agent」语义里没有,这一版不做。
 * 归档的东西收在最下面「已归档」那张卡里,右键能取消归档。
 */
import { useRef, useState } from "react";
import type { JSX } from "react";
import type { ReactNode } from "react";
import { RowMenu, type MenuAt, type MenuBlock } from "./RowMenu";
import { SIDE_WIDTH } from "./sideWidth";
import { WidthGrip } from "./WidthGrip";
import type { TreeKind } from "./treeKind";
import { ordered, visible, type Place } from "./treeState";
import type { VibeChat, VibeGroup, VibeProject } from "./types";
import { moveTargetsFor } from "./vibeOrg";

/**
 * 整块筛选用的那两行(「全部项目」和「没放进分组」)先归档,默认不显示 —— **用户 2026-10-23 要求的**:
 * 「这个块不需要,归档他」「这两个也不需要,直接按条目显示项目」。代码留着,改回 true 就回来;
 * 记录另见 `docs/plan/user-decisions-2026-10-23.md`。
 *
 * 它们没了之后:没放进分组的项目在「项目」那张卡里直接一条条列出来;要筛回「全部」靠顶栏那颗房子
 * (`OnlineStart.tsx` 的 `onHome` 一并把作用域设回 all)。
 */
const SHOW_SCOPE_ROWS = false;

/** 右边那排现在显示哪一堆 */
export type Scope = { kind: "all" } | { kind: "group"; id: string } | { kind: "loose" };

export const scopeKeyOf = (s: Scope): string => (s.kind === "group" ? `group:${s.id}` : s.kind);

/** 侧栏对外要的一组改动。全由 `OnlineStart` 拿着状态去做,这一栏只管什么时候调 */
export interface TreeOps {
  rename: (kind: TreeKind, id: string, name: string) => void;
  pin: (kind: TreeKind, id: string) => void;
  /** 归档 / 取消归档(按它现在的状态切) */
  archive: (kind: TreeKind, id: string) => void;
  remove: (kind: TreeKind, id: string) => void;
  reorder: (kind: TreeKind, dragId: string, overId: string, place: Place) => void;
  /** 项目移到某个分组(null 是移出分组) */
  move: (projectId: string, groupId: string | null) => void;
  /** 这一行哪几项做不了、为什么 */
  blocked: (kind: TreeKind, id: string) => { rename?: MenuBlock; remove?: MenuBlock };
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
  groups: VibeGroup[];
  projects: VibeProject[];
  /** 此刻连着的那个项目里看得到的对话(别的项目没连上,列不出) */
  chats: VibeChat[];
  /** 此刻连着的项目;它那一行展开、底下列对话 */
  connectedId: string | null;
  scope: Scope;
  onScope: (s: Scope) => void;
  onCreate: () => void;
  /** 新建项目做不了(没登录、游客已经建过)时的说明 */
  createBlocked?: string | null;
  onOpen: (id: string) => void;
  onOpenChat: (chat: VibeChat) => void;
  onNewChat: (projectId: string) => void;
  onNewGroup: () => void;
  /**
   * 「新建分组」那一行悬停时说的话:这一套分组存在哪、装什么(本地分组 / 云端分组,见 `vibeOrg.ts` 文件头)
   */
  groupNote?: string;
  /** 新建分组做不了(游客没有分组)时的说明;给了就置灰并挂在悬停上 */
  newGroupBlocked?: string | null;
  /** 「分组」那张卡里「新建分组」下面的一行状态(云端分组没同步上时);没有就不显示 */
  groupStatus?: string | null;
  /** 「项目」那张卡顶上的一行状态(正在取列表、取不到、重试);没有就不显示 */
  notice?: ReactNode;
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
  const [open, setOpen] = useState<Record<string, boolean>>({});
  /** 每张卡收起来没有(用户 2026-10-23:每一个块都可以收起,和右边那条拓展栏一样)。缺省都是开的 */
  const [cards, setCards] = useState<Record<string, boolean>>({});
  const cardOpen = (k: string) => cards[k] !== false;
  const toggleCard = (k: string) => setCards((c) => ({ ...c, [k]: !cardOpen(k) }));
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

  const chatsOfProject = (id: string) => ordered(allChats.filter((c) => c.projectId === id));
  /** 项目自己名字命中,或它底下哪条对话命中,都算要显示 */
  const projectShows = (p: VibeProject) => hit(p.name) || chatsOfProject(p.id).some((c) => hit(c.name));
  const projectsOf = (groupId: string | null) =>
    ordered(allProjects.filter((p) => p.groupId === groupId && projectShows(p)));

  /** 同级的键:分组一级,同一分组里的项目一级,挂在同一个项目(或分组)上的对话各一级 */
  const chatSib = (c: VibeChat) => `chat:p:${c.projectId}`;
  const projectSib = (p: VibeProject) => `project:${p.realm}:${p.groupId ?? "loose"}`;
  const archivedGroups = props.groups.filter((g) => g.archived);
  const archivedProjects = props.projects.filter((p) => p.archived);
  const archivedChats = props.chats.filter((c) => c.archived);
  const archivedCount = archivedGroups.length + archivedProjects.length + archivedChats.length;

  const current = props.scope;
  const isAt = (s: Scope) =>
    s.kind === current.kind && (s.kind !== "group" || (current.kind === "group" && s.id === current.id));

  /** 一张卡的头:和右边那条拓展栏的段头同一套(`.ps-card-*`),点了收起里面那一截 */
  const cardHead = (key: string, title: string, count: number): JSX.Element => (
    <div className="ps-card-head">
      <button
        type="button"
        className="ps-card-toggle"
        data-pc="start-side-card"
        data-card={key}
        aria-expanded={cardOpen(key)}
        onClick={() => toggleCard(key)}
      >
        <span className="ps-card-caret" data-open={cardOpen(key)} aria-hidden="true">›</span>
        {title}
      </button>
      <span className="ps-card-count">{count}</span>
    </div>
  );

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

  const chatRow = (chat: VibeChat) =>
    row({
      kind: "chat",
      id: chat.id,
      name: chat.state === "running" ? `${chat.name} · 进行中` : chat.visibility === "private" ? `${chat.name} · 私有${chat.readOnly ? "（只读）" : ""}` : chat.name,
      pinned: !!chat.pinned,
      sib: chatSib(chat),
      icon: <AgentIcon />,
      className: "is-agent",
      current: props.openChatId === chat.id,
      pc: "start-side-agent",
      label: `Agent 对话 ${chat.name}${chat.visibility === "private" ? "，私有" : ""}${chat.pinned ? "（已置顶）" : ""}`,
      onClick: () => props.onOpenChat(chat),
    });

  /** 一个项目,连同它底下的项目 Agent */
  const newChatRow = (projectId: string) => (
    <button key="new-chat" type="button" className="ps-row is-agent" data-pc="start-side-new-chat" aria-label="新对话" onClick={() => props.onNewChat(projectId)}>
      <span className="ps-row-caret" data-empty aria-hidden="true">›</span>
      <span className="ps-row-icon is-agent" aria-hidden="true">＋</span>
      <span className="ps-row-name ps-muted">新对话</span>
    </button>
  );

  const projectBlock = (p: VibeProject) => {
    const chats = chatsOfProject(p.id);
    const connected = props.connectedId === p.id;
    // 搜索时自动展开命中的那一支:不然搜到了却看不见在哪。连着的那个项目缺省展开(收起要自己点)
    const expanded = q ? chats.some((c) => hit(c.name)) : connected && open[p.id] !== false;
    return (
      <div key={p.id}>
        {row({
          kind: "project",
          id: p.id,
          name: p.name,
          pinned: !!p.pinned,
          sib: projectSib(p),
          icon: <ProjectIcon />,
          expanded: connected ? expanded : undefined,
          current: connected && !props.openChatId,
          pc: "start-side-project",
          label: `项目 ${p.name}${chats.length ? `，${chats.length} 个 Agent 对话` : ""}${p.pinned ? "，已置顶" : ""}`,
          onClick: () => {
            if (connected) setOpen((o) => ({ ...o, [p.id]: o[p.id] === false }));
            props.onOpen(p.id);
          },
        })}
        {expanded && <div className="ps-sub">{chats.map(chatRow)}{newChatRow(p.id)}</div>}
      </div>
    );
  };

  /** 「已归档」那张卡里的一行:点了、右键都出菜单(取消归档、删除),不进去 */
  const archivedRow = (kind: TreeKind, id: string, name: string, icon: JSX.Element) => (
    <button key={`${kind}:${id}`} type="button" className={`ps-row is-archived${kind === "chat" ? " is-agent" : ""}`} data-pc="start-side-archived-row"
      data-kind={kind} data-id={id} aria-label={`已归档的${kind === "group" ? "分组" : kind === "project" ? "项目" : "对话"} ${name}`} title={`${name}（右键取消归档）`}
      onClick={(e) => setMenu({ id, kind, name, pinned: false, x: e.clientX, y: e.clientY })}
      onContextMenu={(e) => { e.preventDefault(); setMenu({ id, kind, name, pinned: false, x: e.clientX, y: e.clientY }); }}>
      <span className="ps-row-caret" data-empty aria-hidden="true">›</span>
      <span className={`ps-row-icon${kind === "chat" ? " is-agent" : ""}`}>{icon}</span>
      <span className="ps-row-name ps-muted">{name}</span>
    </button>
  );

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
      <button type="button" className="ps-side-new" data-pc="start-side-new" disabled={!!props.createBlocked} title={props.createBlocked ?? undefined} onClick={props.onCreate}>
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
        {SHOW_SCOPE_ROWS && (
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
        )}

        <div className="ps-side-group" data-open={cardOpen("groups")}>
          {cardHead("groups", "分组", groups.length)}
          {cardOpen("groups") && <div className="ps-side-body">
          {groups.map((g) => {
            const rows = projectsOf(g.id);
            const expanded = q ? rows.length > 0 : !!open[g.id];
            return (
              <div key={g.id}>
                {row({
                  kind: "group",
                  id: g.id,
                  name: g.name,
                  pinned: !!g.pinned,
                  sib: `group:${g.realm}`,
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
                    {rows.length === 0 && <p className="ps-side-hint">分组是空的：在项目上右键「移到分组」。</p>}
                  </div>
                )}
              </div>
            );
          })}
          <button type="button" className="ps-row" data-pc="start-new-group" aria-label="新建分组" disabled={!!props.newGroupBlocked}
            title={props.newGroupBlocked ?? props.groupNote} onClick={props.onNewGroup}>
            <span className="ps-row-caret" data-empty aria-hidden="true">›</span>
            <span className="ps-row-icon" aria-hidden="true">＋</span>
            <span className="ps-row-name ps-muted">新建分组</span>
          </button>
          {props.groupStatus && <div className="ps-side-hint" role="status" data-pc="start-group-status">{props.groupStatus}</div>}
          </div>}
        </div>

        <div className="ps-side-group" data-open={cardOpen("projects")}>
          {cardHead("projects", "项目", projectsOf(null).length)}
          {cardOpen("projects") && <div className="ps-side-body">
          {SHOW_SCOPE_ROWS && (
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
          )}
          {props.notice && <div className="ps-side-hint" role="status" data-pc="start-side-notice">{props.notice}</div>}
          {/* 没放进分组的项目直接一条条列,不再套在「没放进分组」那一行底下(用户 2026-10-23) */}
          {projectsOf(null).map(projectBlock)}
          </div>}
        </div>

        {archivedCount > 0 && (
          <div className="ps-side-group" data-open={cards.archived === true} data-pc="start-side-archived">
            {/* 已归档缺省收着:平时不占地方,要找回来才点开 */}
            <div className="ps-card-head">
              <button type="button" className="ps-card-toggle" data-pc="start-side-card" data-card="archived" aria-expanded={cards.archived === true}
                onClick={() => setCards((c) => ({ ...c, archived: c.archived !== true }))}>
                <span className="ps-card-caret" data-open={cards.archived === true} aria-hidden="true">›</span>
                已归档
              </button>
              <span className="ps-card-count">{archivedCount}</span>
            </div>
            {cards.archived === true && <div className="ps-side-body">
              {archivedGroups.map((g) => archivedRow("group", g.id, g.name, <GroupIcon />))}
              {archivedProjects.map((p) => archivedRow("project", p.id, p.name, <ProjectIcon />))}
              {archivedChats.map((c) => archivedRow("chat", c.id, c.name, <AgentIcon />))}
              <p className="ps-side-hint">右键「取消归档」放回原处。</p>
            </div>}
          </div>
        )}
      </div>

      </div>

      {/* 右边那条缝:平时不画线,鼠标压上来才亮(`WidthGrip.tsx`)。收起时没有 */}
      {!props.collapsed && (
        <WidthGrip
          spec={SIDE_WIDTH}
          side="right"
          width={props.width}
          label="侧栏宽度"
          pc="start-side-grip"
          onWidth={props.onWidth}
          onWidthCommit={props.onWidthCommit}
          onWidthNudge={props.onWidthNudge}
        />
      )}

      {menu && (() => {
        const blocked = props.ops.blocked(menu.kind, menu.id);
        const project = menu.kind === "project" ? props.projects.find((p) => p.id === menu.id) : undefined;
        const archived = menu.kind === "group" ? !!props.groups.find((g) => g.id === menu.id)?.archived
          : menu.kind === "project" ? !!project?.archived : !!props.chats.find((c) => c.id === menu.id)?.archived;
        // 别的套的分组也列,置灰并说明(本地项目放不进云端分组,云端项目放不进本地分组)
        const moveTargets = project && !archived ? moveTargetsFor(project, props.groups) : undefined;
        return (
          <RowMenu
            at={menu}
            archived={archived}
            renameBlocked={blocked.rename}
            deleteBlocked={blocked.remove}
            moveTargets={moveTargets}
            onMove={(gid) => props.ops.move(menu.id, gid)}
            onClose={() => setMenu(null)}
            onRename={() => setRenaming({ kind: menu.kind, id: menu.id, name: menu.name })}
            onPin={() => props.ops.pin(menu.kind, menu.id)}
            onArchive={() => props.ops.archive(menu.kind, menu.id)}
            onDelete={() => props.ops.remove(menu.kind, menu.id)}
          />
        );
      })()}
    </aside>
  );
}
