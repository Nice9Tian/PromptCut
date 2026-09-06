import { useState, useEffect } from "react";
import { actions } from "../../store/project";
import type { CardDef, Control } from "../../kernel/types";
import type { TrackClip } from "../../kernel/project";

export function ParamsForm({ clip, cardDef }: { clip: TrackClip, cardDef: CardDef<any> | undefined }) {
  if (!cardDef || !cardDef.controls || cardDef.controls.length === 0) {
    return (
      <div className="p-4 text-center text-xs text-neutral-500">
        这张卡没有可调参数
      </div>
    );
  }

  const merged = { ...cardDef.defaults, ...clip.params };

  const handlePointerDownNumber = (e: React.PointerEvent, key: string, current: number, step: number = 1, min?: number, max?: number) => {
    const el = e.currentTarget as HTMLDivElement;
    el.setPointerCapture(e.pointerId);
    
    const x0 = e.clientX;
    const v0 = current;
    
    el.classList.add("text-neutral-200");
    document.body.style.cursor = "ew-resize";

    const onMove = (moveEvent: PointerEvent) => {
      let next = v0 + (moveEvent.clientX - x0) * step;
      if (min !== undefined) next = Math.max(min, next);
      if (max !== undefined) next = Math.min(max, next);
      
      next = Math.round(next / step) * step;
      next = Number(next.toFixed(6));
      
      actions.setClipParams(clip.id, { [key]: next });
    };
    
    const onUp = (upEvent: PointerEvent) => {
      el.releasePointerCapture(upEvent.pointerId);
      el.classList.remove("text-neutral-200");
      document.body.style.cursor = "";
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
    };
    
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
  };

  const isBlank = (s: any) => s == null || String(s).trim() === "";
  const isHex = (s: any) => /^#([0-9A-Fa-f]{3}){1,2}$/.test(String(s));
  const isColorOk = (s: any) => isBlank(s) || isHex(s);

  return (
    <div className="flex flex-col py-2">
      {cardDef.controls.map((ctrl: Control) => {
        const val = merged[ctrl.key];
        
        return (
          <div key={ctrl.key} className="flex items-center gap-2 px-2 py-1">
            {ctrl.type === "number" ? (
              <div 
                data-pc-drag={ctrl.key}
                className="w-20 shrink-0 text-[11px] text-neutral-400 truncate cursor-ew-resize select-none" 
                title={`${ctrl.label} (左右拖动可以微调)`}
                onPointerDown={(e) => handlePointerDownNumber(e, ctrl.key, Number(val) || 0, ctrl.step, ctrl.min, ctrl.max)}
              >
                {ctrl.label}
              </div>
            ) : (
              <div className="w-20 shrink-0 text-[11px] text-neutral-400 truncate" title={ctrl.label}>
                {ctrl.label}
              </div>
            )}
            
            <div className="flex-1 min-w-0 flex items-center gap-2">
              {ctrl.type === "text" && (
                <input
                  data-pc-param={ctrl.key}
                  type="text"
                  value={String(val ?? "")}
                  onChange={e => actions.setClipParams(clip.id, { [ctrl.key]: e.target.value })}
                  className="w-full h-6 px-1.5 bg-neutral-900 border border-neutral-800 rounded text-xs text-neutral-200 outline-none focus:border-neutral-600"
                />
              )}
              
              {ctrl.type === "number" && (
                <input
                  data-pc-param={ctrl.key}
                  type="number"
                  min={ctrl.min}
                  max={ctrl.max}
                  step={ctrl.step ?? 1}
                  value={Number.isFinite(val) ? val : ""}
                  onChange={e => {
                    const v = Number(e.target.value);
                    if (Number.isFinite(v)) {
                      actions.setClipParams(clip.id, { [ctrl.key]: v });
                    }
                  }}
                  className="w-full h-6 px-1.5 bg-neutral-900 border border-neutral-800 rounded text-xs text-neutral-200 outline-none focus:border-neutral-600"
                />
              )}
              
              {ctrl.type === "select" && (
                <select
                  data-pc-param={ctrl.key}
                  value={String(val ?? "")}
                  onChange={e => actions.setClipParams(clip.id, { [ctrl.key]: e.target.value })}
                  className="w-full h-6 px-1 bg-neutral-900 border border-neutral-800 rounded text-xs text-neutral-200 outline-none focus:border-neutral-600"
                >
                  {ctrl.options.map((o: { value: string; label: string }) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              )}
              
              {ctrl.type === "color" && (
                <ColorControl clipId={clip.id} ctrlKey={ctrl.key} value={String(val ?? "")} isColorOk={isColorOk} isHex={isHex} />
              )}
            </div>
          </div>
        );
      })}
      
      <div className="mt-4 px-2">
        <button 
          onClick={() => actions.setClipParams(clip.id, {}, { merge: false })}
          className="text-[10px] px-2 py-1 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded border border-neutral-700"
        >
          重置为默认
        </button>
      </div>
    </div>
  );
}

function ColorControl({ clipId, ctrlKey, value, isColorOk, isHex }: { clipId: string, ctrlKey: string, value: string, isColorOk: (v: string) => boolean, isHex: (v: string) => boolean }) {
  const [local, setLocal] = useState(value);
  
  useEffect(() => {
    setLocal(value);
  }, [value]);
  
  return (
    <div className="flex w-full items-center gap-2">
      <input
        type="color"
        value={isHex(value) ? value : "#000000"}
        onChange={e => actions.setClipParams(clipId, { [ctrlKey]: e.target.value })}
        className="h-6 w-8 rounded border border-neutral-800 bg-transparent p-0 cursor-pointer"
      />
      <input
        data-pc-param={ctrlKey}
        type="text"
        value={local}
        onChange={e => {
          setLocal(e.target.value);
          if (isColorOk(e.target.value)) {
            actions.setClipParams(clipId, { [ctrlKey]: e.target.value });
          }
        }}
        className={`flex-1 h-6 px-1.5 bg-neutral-900 border rounded text-xs text-neutral-200 outline-none ${!isColorOk(local) ? 'border-red-500' : 'border-neutral-800 focus:border-neutral-600'}`}
      />
    </div>
  );
}
