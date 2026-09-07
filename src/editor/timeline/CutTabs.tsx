import { useEffect, useRef, useState } from "react";
import { actions, useStore } from "../../store/project";
import { listCuts } from "../../kernel/cuts";
import "./cut-tabs.css";

/**
 * 时间轴顶部的剪辑选项栏:一个项目里可以有多条时间轴(剪辑),这里切换。
 * 单击切换、双击改名、悬停出 × 删除(有内容的先确认)、右边 + 新建。
 * 数据全在 project.cuts / activeCutId 上(见 kernel/project.ts 的 Cut),这里只是个视图。
 */
export function CutTabs() {
  const project = useStore((s) => s.project);
  const cuts = listCuts(project);
  const [editing, setEditing] = useState<string | null>(null);

  return (
    <div className="pc-tl-cuts" data-pc="cut-tabs" role="tablist" aria-label="剪辑">
      {cuts.map((c) => (
        <Tab
          key={c.id}
          id={c.id}
          name={c.name}
          active={c.active}
          clipCount={c.clipCount}
          canRemove={cuts.length > 1}
          editing={editing === c.id}
          onEdit={() => setEditing(c.id)}
          onDone={() => setEditing(null)}
        />
      ))}
      <button type="button" className="pc-tl-cut-add" title="新建剪辑" onClick={() => actions.addCut()}>
        +
      </button>
    </div>
  );
}

function Tab({
  id, name, active, clipCount, canRemove, editing, onEdit, onDone,
}: {
  id: string; name: string; active: boolean; clipCount: number; canRemove: boolean;
  editing: boolean; onEdit: () => void; onDone: () => void;
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

  return (
    <div
      role="tab"
      aria-selected={active}
      className={`pc-tl-cut${active ? " is-on" : ""}`}
      onClick={() => { if (!active) actions.switchCut(id); }}
      onDoubleClick={onEdit}
      title={editing ? undefined : "单击切换,双击改名"}
    >
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            else if (e.key === "Escape") onDone();
          }}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span className="pc-tl-cut-name">{name}</span>
      )}
      {canRemove && !editing && (
        <button type="button" className="pc-tl-cut-x" title="删除这条剪辑" onClick={remove} aria-label={`删除 ${name}`}>
          ×
        </button>
      )}
    </div>
  );
}
