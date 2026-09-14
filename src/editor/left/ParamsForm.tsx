import { useState, useEffect } from "react";
import { actions } from "../../store/project";
import type { CardDef, Control } from "../../kernel/types";
import { ASSET_TARGET } from "../../cards/catalogAssets";
import type { TrackClip } from "../../kernel/project";
import { SpeakerPicker } from "./SpeakerPicker";

function isSpeakerVideoControl(ctrl: Control): boolean {
  if (ctrl.type !== "text") return false;
  const keyLower = ctrl.key.toLowerCase();
  const keyMatch = /speaker|speech|talking|talkinghead|cam|video|口播/.test(keyLower);
  const labelMatch = ctrl.label.includes("口播") || ctrl.label.includes("视频");
  return keyMatch || labelMatch;
}

export function ParamsForm({ clip, cardDef }: { clip: TrackClip; cardDef: CardDef<any> | undefined }) {
  const [pickerCtrlKey, setPickerCtrlKey] = useState<string | null>(null);

  if (!cardDef || !cardDef.controls || cardDef.controls.length === 0) {
    return (
      <div className="p-4 text-center text-xs pc-left-muted">
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

    el.classList.add("pc-left-strong");
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
      el.classList.remove("pc-left-strong");
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
          <div key={ctrl.key} className="flex items-center gap-2 px-3 py-1">
            {ctrl.type === "number" ? (
              <div
                data-pc-drag={ctrl.key}
                className="w-20 shrink-0 text-[11px] pc-left-muted truncate cursor-ew-resize select-none"
                title={`${ctrl.label} (左右拖动可以微调)`}
                onPointerDown={(e) => handlePointerDownNumber(e, ctrl.key, Number(val) || 0, ctrl.step, ctrl.min, ctrl.max)}
              >
                {ctrl.label}
              </div>
            ) : (
              <div className="w-20 shrink-0 text-[11px] pc-left-muted truncate" title={ctrl.label}>
                {ctrl.label}
              </div>
            )}

            <div className="flex-1 min-w-0 flex items-center gap-2">
              {ctrl.type === "text" && (
                isSpeakerVideoControl(ctrl) ? (
                  <div className="flex w-full items-center gap-1">
                    <input
                      data-pc-param={ctrl.key}
                      type="text"
                      value={String(val ?? "")}
                      onChange={e => actions.setClipParams(clip.id, { [ctrl.key]: e.target.value })}
                      className="flex-1 pc-left-input"
                    />
                    <button
                      type="button"
                      data-pc-pick={ctrl.key}
                      onClick={() => setPickerCtrlKey(ctrl.key)}
                      title="选择口播视频"
                      className="pc-left-btn is-icon"
                    >
                      …
                    </button>
                  </div>
                ) : (
                  <input
                    data-pc-param={ctrl.key}
                    type="text"
                    value={String(val ?? "")}
                    onChange={e => actions.setClipParams(clip.id, { [ctrl.key]: e.target.value })}
                    className="w-full pc-left-input"
                  />
                )
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
                  className="w-full pc-left-input"
                />
              )}

              {ctrl.type === "select" && (
                <select
                  data-pc-param={ctrl.key}
                  value={String(val ?? "")}
                  onChange={e => actions.setClipParams(clip.id, { [ctrl.key]: e.target.value })}
                  className="w-full pc-left-select"
                >
                  {ctrl.options.map((o: { value: string; label: string }) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              )}

              {ctrl.type === "asset" && (
                <div className="flex w-full flex-col gap-1">
                  <select
                    data-pc-param={ctrl.key}
                    value={ctrl.options.some((o) => o.value === String(val ?? "")) ? String(val) : ""}
                    onChange={e => actions.setClipParams(clip.id, { ...(e.target.value ? ASSET_TARGET[ctrl.kind].extra : {}), [ctrl.key]: e.target.value })}
                    className="w-full pc-left-select"
                    title="软件自带的素材;要用别的就在下面手填"
                  >
                    <option value="">{String(val ?? "").trim() && !ctrl.options.some((o) => o.value === String(val)) ? "(自定义,见下)" : "— 不用素材 —"}</option>
                    {ctrl.options.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                  <input
                    data-pc-param-custom={ctrl.key}
                    type="text"
                    value={String(val ?? "")}
                    placeholder="或手填 URL / JSON"
                    onChange={e => actions.setClipParams(clip.id, { [ctrl.key]: e.target.value })}
                    className="w-full pc-left-input"
                  />
                </div>
              )}

              {ctrl.type === "color" && (
                <ColorControl clipId={clip.id} ctrlKey={ctrl.key} value={String(val ?? "")} isColorOk={isColorOk} isHex={isHex} />
              )}
            </div>
          </div>
        );
      })}

      <div className="mt-4 px-3">
        <button
          type="button"
          onClick={() => actions.setClipParams(clip.id, {}, { merge: false })}
          className="pc-left-btn"
        >
          重置为默认
        </button>
      </div>

      {pickerCtrlKey && (
        <SpeakerPicker
          open={true}
          onClose={() => setPickerCtrlKey(null)}
          onSelect={(url) => {
            actions.setClipParams(clip.id, { [pickerCtrlKey]: url });
          }}
        />
      )}
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
        className="pc-left-color"
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
        className={`flex-1 pc-left-input${!isColorOk(local) ? " is-error" : ""}`}
      />
    </div>
  );
}
