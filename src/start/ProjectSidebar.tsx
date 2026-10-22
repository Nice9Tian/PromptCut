/**
 * 左侧栏:全部项目,三级结构(用户 2026-10-23 定的形状)。
 *
 *   分组
 *     ├ 项目
 *     │   └ 项目 Agent(这个项目里的 Agent 对话)
 *     └ 分组 Agent(跨这个分组里几个项目的对话)
 *
 * 三种东西各有自己的前置图标:分组是叠起来的方块,项目是取景框,Agent 是一颗星芒并染上 Agent 专属色
 * (`--ui-agent`,和编辑器 rail 上的 Agent 头像同一个色,见 `src/skins/agentColor.ts`)。每一层用一条竖导线
 * 和缩进表示从属,不画逐行的拐角 —— 拐角要分「最后一个」和「中间的」,行一多就容易错位。
 *
 * 点分组把右边那排筛成这个分组里的项目;点项目、点 Agent 现在只给一行「待办」。
 * 搜索只筛这一栏(右边那排跟着当前分组走,不跟搜索走),免得一边打字一边整页都在跳。
 *
 * 待办(业务层):分组、分组 Agent 语义里都还没有,项目 Agent 对应现有的云端 Agent 对话但要按共有/私有
 * 过滤 —— 各自要接什么写在 `mockProjects.ts` 的文件头。
 */
import { useState } from "react";
import type { JSX } from "react";
import { Logo } from "../ui/Logo";
import { hueOf } from "./hue";
import type { MockAgentChat, MockGroup, MockProject } from "./mockProjects";

/** 右边那排现在显示哪一堆 */
export type Scope = { kind: "all" } | { kind: "group"; id: string } | { kind: "loose" };

export const scopeKeyOf = (s: Scope): string => (s.kind === "group" ? `group:${s.id}` : s.kind);

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

export function ProjectSidebar(props: {
  groups: MockGroup[];
  projects: MockProject[];
  chats: MockAgentChat[];
  scope: Scope;
  onScope: (s: Scope) => void;
  onCreate: () => void;
  onOpen: (id: string) => void;
  onOpenChat: (chat: MockAgentChat) => void;
  accountName: string | null;
  onSignOut: () => void;
}): JSX.Element {
  const [open, setOpen] = useState<Record<string, boolean>>({ "g-brand": true });
  const [query, setQuery] = useState("");

  const q = query.trim().toLowerCase();
  const hit = (text: string) => !q || text.toLowerCase().includes(q);
  const chatsOfProject = (id: string) => props.chats.filter((c) => c.on === "project" && c.projectId === id);
  const chatsOfGroup = (id: string) => props.chats.filter((c) => c.on === "group" && c.groupId === id);
  /** 项目自己名字命中,或它底下哪条 Agent 对话命中,都算这个项目要显示 */
  const projectShows = (p: MockProject) => hit(p.name) || chatsOfProject(p.id).some((c) => hit(c.title));
  const projectsOf = (groupId: string | null) =>
    props.projects.filter((p) => p.groupId === groupId && projectShows(p));

  const current = props.scope;
  const isAt = (s: Scope) =>
    s.kind === current.kind && (s.kind !== "group" || (current.kind === "group" && s.id === current.id));

  const chatRow = (chat: MockAgentChat) => (
    <button
      key={chat.id}
      type="button"
      className="ps-row is-agent"
      data-pc="start-side-agent"
      data-agent={chat.id}
      aria-label={`Agent 对话 ${chat.title}`}
      title={chat.title}
      onClick={() => props.onOpenChat(chat)}
    >
      <span className="ps-row-icon is-agent"><AgentIcon /></span>
      <span className="ps-row-name">{chat.title}</span>
    </button>
  );

  /** 一个项目,连同它底下的项目 Agent */
  const projectBlock = (p: MockProject) => {
    const chats = chatsOfProject(p.id);
    // 搜索时自动展开命中的那一支:不然搜到了却看不见在哪
    const expanded = q ? chats.some((c) => hit(c.title)) : !!open[p.id];
    return (
      <div key={p.id}>
        <button
          type="button"
          className="ps-row"
          data-pc="start-side-project"
          data-project={p.id}
          aria-label={`项目 ${p.name}${chats.length ? `，${chats.length} 个 Agent 对话` : ""}`}
          aria-expanded={chats.length ? expanded : undefined}
          title={p.name}
          onClick={() => {
            props.onOpen(p.id);
            if (chats.length) setOpen((o) => ({ ...o, [p.id]: !o[p.id] }));
          }}
        >
          <span className="ps-row-caret" data-open={expanded} data-empty={chats.length === 0} aria-hidden="true">›</span>
          <span className="ps-row-icon"><ProjectIcon /></span>
          <span className="ps-row-name">{p.name}</span>
        </button>
        {expanded && chats.length > 0 && <div className="ps-sub">{chats.map(chatRow)}</div>}
      </div>
    );
  };

  return (
    <aside className="ps-side" data-pc="start-side">
      <div className="ps-side-head">
        {/* Logo 自带字标,这里不要再写一遍产品名 */}
        <Logo size={20} />
      </div>

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
            aria-label={`全部项目，共 ${props.projects.length} 个`}
            aria-current={isAt({ kind: "all" })}
            onClick={() => props.onScope({ kind: "all" })}
          >
            <span className="ps-row-icon"><AllIcon /></span>
            <span className="ps-row-name">全部项目</span>
            <span className="ps-row-count">{props.projects.length}</span>
          </button>
        </div>

        <div className="ps-side-group">
          <div className="ps-side-label">分组</div>
          {props.groups.map((g) => {
            const rows = projectsOf(g.id);
            const groupChats = chatsOfGroup(g.id).filter((c) => hit(c.title));
            const expanded = q ? rows.length > 0 || groupChats.length > 0 : !!open[g.id];
            return (
              <div key={g.id}>
                <button
                  type="button"
                  className="ps-row"
                  data-pc="start-scope-group"
                  data-group={g.id}
                  aria-label={`分组 ${g.name}，${rows.length} 个项目`}
                  aria-expanded={expanded}
                  aria-current={isAt({ kind: "group", id: g.id })}
                  onClick={() => {
                    props.onScope({ kind: "group", id: g.id });
                    setOpen((o) => ({ ...o, [g.id]: !o[g.id] }));
                  }}
                >
                  <span className="ps-row-caret" data-open={expanded} aria-hidden="true">›</span>
                  <span className="ps-row-icon"><GroupIcon /></span>
                  <span className="ps-row-name">{g.name}</span>
                  <span className="ps-row-count">{rows.length}</span>
                </button>
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
            <span className="ps-row-icon"><AllIcon /></span>
            <span className="ps-row-name">没放进分组</span>
            <span className="ps-row-count">{projectsOf(null).length}</span>
          </button>
          <div className="ps-sub">{projectsOf(null).map(projectBlock)}</div>
        </div>
      </div>

      <div className="ps-side-foot">
        <span
          className="ps-avatar"
          style={{
            background: `hsl(${hueOf(props.accountName ?? "guest")} 45% 32%)`,
            color: `hsl(${hueOf(props.accountName ?? "guest")} 60% 88%)`,
          }}
          aria-hidden="true"
        >
          {(props.accountName ?? "?").slice(0, 1)}
        </span>
        <span className="ps-row-name" data-pc="start-account-name">{props.accountName ?? "未登录"}</span>
        <button type="button" className="ps-link" data-pc="start-sign-out" onClick={props.onSignOut}>
          退出
        </button>
      </div>
    </aside>
  );
}
