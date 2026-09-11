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

/** 编辑分页的内容。参数 / 代码这一级由左栏的二级分页栏控制,这里只按 tab 渲染。 */
export function Inspector({ tab }: { tab: "form" | "code" }) {
  const selId = useStore(s => s.selection[0]);
  const project = useStore(s => s.project);

  const hit = selId ? findClip(project, selId) : null;

  if (!hit) {
    return (
      <div className="flex-1 flex items-center justify-center p-4 text-center text-xs text-neutral-500">
        在时间轴上点一个片段,或点上面的卡片添加一个
      </div>
    );
  }

  const { clip } = hit;

  if (clip.mediaId && !clip.cardId) {
    const media = project.media.find(m => m.id === clip.mediaId);
    return (
      <div className="flex-1 flex flex-col p-2 text-xs">
        <div className="text-neutral-400 mb-2">标签: <span className="text-neutral-200">{clip.label || "无"}</span></div>
        <div className="flex items-center gap-2 mb-2">
          <span>开始</span>
          <input 
            data-pc="clip-start"
            type="number" step={0.1} min={0} 
            value={clip.start} 
            onChange={e => { const v = Number(e.target.value); if (Number.isFinite(v)) actions.moveClip(clip.id, { start: v }); }}
            className="w-16 h-6 px-1 bg-neutral-900 border border-neutral-800 rounded text-neutral-200 outline-none"
          />
          <span>结束</span>
          <input 
            data-pc="clip-end"
            type="number" step={0.1} min={0} 
            value={clip.end} 
            onChange={e => { const v = Number(e.target.value); if (Number.isFinite(v)) actions.moveClip(clip.id, { end: v }); }}
            className="w-16 h-6 px-1 bg-neutral-900 border border-neutral-800 rounded text-neutral-200 outline-none"
          />
          <span className="text-neutral-500">{(clip.end - clip.start).toFixed(2)}s</span>
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
      <div className="p-2 border-b border-neutral-800 flex flex-col gap-2 shrink-0">
        <div className="flex items-center justify-between">
          <div className="font-bold text-xs text-neutral-200 truncate pr-2">{cardDef?.name ?? clip.cardId}</div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-neutral-500 shrink-0">换卡会清空参数</span>
            <select 
              data-pc="switch-card"
              value={clip.cardId}
              onChange={e => actions.setClipCard(clip.id, e.target.value)}
              className="h-6 text-xs bg-neutral-900 border border-neutral-800 rounded px-1 text-neutral-200 outline-none w-24 shrink-0"
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
        
        <div className="flex items-center gap-2 text-xs text-neutral-400">
          <span>开始</span>
          <input 
            data-pc="clip-start"
            type="number" step={0.1} min={0} 
            value={clip.start} 
            onChange={e => { const v = Number(e.target.value); if (Number.isFinite(v)) actions.moveClip(clip.id, { start: v }); }}
            className="w-16 h-6 px-1 bg-neutral-900 border border-neutral-800 rounded text-neutral-200 outline-none"
          />
          <span>结束</span>
          <input 
            data-pc="clip-end"
            type="number" step={0.1} min={0} 
            value={clip.end} 
            onChange={e => { const v = Number(e.target.value); if (Number.isFinite(v)) actions.moveClip(clip.id, { end: v }); }}
            className="w-16 h-6 px-1 bg-neutral-900 border border-neutral-800 rounded text-neutral-200 outline-none"
          />
          <span className="text-neutral-500 ml-auto">{(clip.end - clip.start).toFixed(2)}s</span>
        </div>
      </div>
      
      <div className="flex-1 min-h-0 overflow-y-auto pc-l-scroll">
        {tab === "form" && (isComposite(clip) ? <PartsForm clip={clip} /> : <ParamsForm clip={clip} cardDef={cardDef} />)}
        {/* 三维排在卡片参数后面:它改的是「这张卡摆在哪」,不是卡片自己的内容 */}
        {tab === "form" && <Frame3DForm clip={clip} />}
        {tab === "code" && <CodeTab clip={clip} />}
      </div>
    </div>
  );
}
