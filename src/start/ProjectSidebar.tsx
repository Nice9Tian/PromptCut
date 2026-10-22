/**
 * 左侧栏:全部项目。
 *
 * 右边那一排只给「最近的几个」,所以完整的一份放这里 —— 按文件夹收拢,点文件夹就把右边筛成
 * 这个文件夹里的项目。搜索只筛这一栏(右边那排跟着当前文件夹走,不跟搜索走),免得一边打字
 * 一边整页都在跳。
 *
 * 待办(业务层):文件夹现在语义里还没有这个概念,新建文件夹、把项目拖进文件夹都只是界面;
 * 真要做得先按「对齐」把这条二级语义(用户看得见的新能力)dry run 给用户过目。
 */
import { useState } from "react";
import type { JSX } from "react";
import { Logo } from "../ui/Logo";
import { hueOf } from "./hue";
import type { MockFolder, MockProject } from "./mockProjects";

/** 右边那排现在显示哪一堆 */
export type Scope = { kind: "all" } | { kind: "folder"; id: string } | { kind: "loose" };

export const scopeKeyOf = (s: Scope): string => (s.kind === "folder" ? `folder:${s.id}` : s.kind);

function FolderIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
      <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h9A1.5 1.5 0 0 1 21 10v7.5A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z" />
    </svg>
  );
}

function FilmIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
      <rect x="3.5" y="5.5" width="17" height="13" rx="2" />
      <path d="M8 5.5v13M16 5.5v13" />
    </svg>
  );
}

export function ProjectSidebar(props: {
  folders: MockFolder[];
  projects: MockProject[];
  scope: Scope;
  onScope: (s: Scope) => void;
  onCreate: () => void;
  onOpen: (id: string) => void;
  accountName: string | null;
  onSignOut: () => void;
}): JSX.Element {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState("");

  const q = query.trim().toLowerCase();
  const match = (p: MockProject) => !q || p.name.toLowerCase().includes(q);
  const inFolder = (id: string) => props.projects.filter((p) => p.folderId === id && match(p));
  const loose = props.projects.filter((p) => p.folderId === null && match(p));
  const current = props.scope;
  const isAt = (s: Scope) =>
    s.kind === current.kind && (s.kind !== "folder" || (current.kind === "folder" && s.id === current.id));

  const projectRow = (p: MockProject) => (
    <button
      key={p.id}
      type="button"
      className="ps-row is-child"
      data-pc="start-side-project"
      data-project={p.id}
      title={p.name}
      onClick={() => props.onOpen(p.id)}
    >
      <span className="ps-row-icon"><FilmIcon /></span>
      <span className="ps-row-name">{p.name}</span>
    </button>
  );

  return (
    <aside className="ps-side" data-pc="start-side">
      <div className="ps-side-head">
        <Logo size={20} />
        <span className="ps-side-brand">PromptCut</span>
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
          placeholder="搜项目名"
          aria-label="搜项目名"
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
            aria-current={isAt({ kind: "all" })}
            onClick={() => props.onScope({ kind: "all" })}
          >
            <span className="ps-row-icon"><FilmIcon /></span>
            <span className="ps-row-name">全部项目</span>
            <span className="ps-row-count">{props.projects.length}</span>
          </button>
        </div>

        <div className="ps-side-group">
          <div className="ps-side-label">文件夹</div>
          {props.folders.map((f) => {
            const rows = inFolder(f.id);
            // 搜索时自动展开命中的文件夹:不然搜到了却看不见在哪
            const expanded = q ? rows.length > 0 : !!open[f.id];
            return (
              <div key={f.id}>
                <button
                  type="button"
                  className="ps-row"
                  data-pc="start-scope-folder"
                  data-folder={f.id}
                  aria-current={isAt({ kind: "folder", id: f.id })}
                  onClick={() => {
                    props.onScope({ kind: "folder", id: f.id });
                    setOpen((o) => ({ ...o, [f.id]: !o[f.id] }));
                  }}
                >
                  <span className="ps-row-caret" data-open={expanded} aria-hidden="true">›</span>
                  <span className="ps-row-icon"><FolderIcon /></span>
                  <span className="ps-row-name">{f.name}</span>
                  <span className="ps-row-count">{rows.length}</span>
                </button>
                {expanded && rows.map(projectRow)}
              </div>
            );
          })}
          <button type="button" className="ps-row" data-pc="start-new-folder" title="待办：文件夹还没有业务层">
            <span className="ps-row-icon" aria-hidden="true">＋</span>
            <span className="ps-row-name ps-muted">新建文件夹</span>
          </button>
        </div>

        <div className="ps-side-group">
          <div className="ps-side-label">未分组</div>
          <button
            type="button"
            className="ps-row"
            data-pc="start-scope-loose"
            aria-current={isAt({ kind: "loose" })}
            onClick={() => props.onScope({ kind: "loose" })}
          >
            <span className="ps-row-icon"><FilmIcon /></span>
            <span className="ps-row-name">没放进文件夹</span>
            <span className="ps-row-count">{loose.length}</span>
          </button>
          {loose.map(projectRow)}
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
