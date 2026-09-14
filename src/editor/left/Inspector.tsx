import { useStore, actions } from "../../store/project";
import { findClip } from "../../kernel/project";
import { getCard, allCards } from "../../kernel/registry";
import { ParamsForm } from "./ParamsForm";
import { PartsForm } from "./PartsForm";
import { isComposite } from "../../kernel/envelope";
import { CodeTab } from "./CodeTab";
import { Frame3DForm } from "./Frame3DForm";
import { ClipFilterForm } from "./ClipFilterForm";
import { ClipAudioFxForm } from "./ClipAudioFxForm";

/**
 * 编辑分区的参数 / 代码两页。哪一页显示由分区头部的胶囊分页决定(tab),
 * 但两页在这里**都常驻挂载**、只切 display:代码框里没提交的草稿切到参数页再回来还在。
 * 片段头部(卡名、换卡、开始/结束)两页共用一份。
 */
export function Inspector({ tab }: { tab: "form" | "code" }) {
  const selId = useStore(s => s.selection[0]);
  const project = useStore(s => s.project);

  const hit = selId ? findClip(project, selId) : null;

  if (!hit) {
    return (
      <div className="flex-1 flex items-center justify-center p-4 text-center text-xs pc-left-muted">
        在时间轴上点一个片段,或在「动画」里点一张卡片添加一个
      </div>
    );
  }

  const { clip } = hit;

  if (clip.mediaId && !clip.cardId) {
    const media = project.media.find(m => m.id === clip.mediaId);
    return (
      <div className="flex-1 min-h-0 overflow-y-auto pc-left-scroll flex flex-col p-3 text-xs">
        <div className="pc-left-muted mb-2">标签: <span className="pc-left-strong">{clip.label || "无"}</span></div>
        <div className="flex items-center gap-2 mb-2 pc-left-muted">
          <span>开始</span>
          <input
            data-pc="clip-start"
            type="number" step={0.1} min={0}
            value={clip.start}
            onChange={e => { const v = Number(e.target.value); if (Number.isFinite(v)) actions.moveClip(clip.id, { start: v }); }}
            className="w-16 pc-left-input is-sm"
          />
          <span>结束</span>
          <input
            data-pc="clip-end"
            type="number" step={0.1} min={0}
            value={clip.end}
            onChange={e => { const v = Number(e.target.value); if (Number.isFinite(v)) actions.moveClip(clip.id, { end: v }); }}
            className="w-16 pc-left-input is-sm"
          />
          <span className="pc-left-faint">{(clip.end - clip.start).toFixed(2)}s</span>
        </div>
        {media && (media.kind === "video" || media.kind === "image") && <ClipFilterForm clip={clip} />}
        {media && (media.kind === "video" || media.kind === "audio") && <ClipAudioFxForm clip={clip} />}
      </div>
    );
  }

  const cardDef = getCard(clip.cardId);
  const magic = allCards().filter(c => c.source === "magicui");
  const native = allCards().filter(c => c.source === "native");
  const user = allCards().filter(c => c.source === "user");
  const asset = allCards().filter(c => c.source === "asset");

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="px-3 pb-2 pc-left-divider-b flex flex-col gap-2 shrink-0">
        <div className="flex items-center justify-between">
          <div className="font-semibold text-xs pc-left-strong truncate pr-2">{cardDef?.name ?? clip.cardId}</div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] pc-left-faint shrink-0">换卡会清空参数</span>
            <select
              data-pc="switch-card"
              value={clip.cardId}
              onChange={e => actions.setClipCard(clip.id, e.target.value)}
              className="pc-left-select is-sm w-24 shrink-0"
            >
              {user.length > 0 && (
                <optgroup label="新建">
                  {user.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </optgroup>
              )}
              {asset.length > 0 && (
                <optgroup label="动效素材">
                  {asset.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </optgroup>
              )}
              <optgroup label="Magic UI">
                {magic.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </optgroup>
              <optgroup label="自家">
                {native.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </optgroup>
            </select>
          </div>
        </div>

        <div className="flex items-center gap-2 text-xs pc-left-muted">
          <span>开始</span>
          <input
            data-pc="clip-start"
            type="number" step={0.1} min={0}
            value={clip.start}
            onChange={e => { const v = Number(e.target.value); if (Number.isFinite(v)) actions.moveClip(clip.id, { start: v }); }}
            className="w-16 pc-left-input is-sm"
          />
          <span>结束</span>
          <input
            data-pc="clip-end"
            type="number" step={0.1} min={0}
            value={clip.end}
            onChange={e => { const v = Number(e.target.value); if (Number.isFinite(v)) actions.moveClip(clip.id, { end: v }); }}
            className="w-16 pc-left-input is-sm"
          />
          <span className="pc-left-faint ml-auto">{(clip.end - clip.start).toFixed(2)}s</span>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto pc-left-scroll" style={{ display: tab === "form" ? "block" : "none" }}>
        {isComposite(clip) ? <PartsForm clip={clip} /> : <ParamsForm clip={clip} cardDef={cardDef} />}
        {/* 三维排在卡片参数后面:它改的是「这张卡摆在哪」,不是卡片自己的内容 */}
        <Frame3DForm clip={clip} />
      </div>
      <div className="flex-1 min-h-0 flex flex-col" style={{ display: tab === "code" ? "flex" : "none" }}>
        {/* 按片段 id 做 key:换了片段就换一份草稿,不会把上一段没提交的内容带过来 */}
        <CodeTab key={clip.id} clip={clip} />
      </div>
    </div>
  );
}
