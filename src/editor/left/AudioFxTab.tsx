import { useState, useEffect } from "react";
import { actions, getState, useStore } from "../../store/project";
import { findClip } from "../../kernel/project";
import { AUDIO_FX_KINDS, AUDIO_FX_PRESETS, describeAudioFx, isAudioFxAnimated } from "../../kernel/audioFx.mjs";
import { createAudioFxTools, audioFxUsesOf } from "../right/audioFxTools";

/** 和 Agent 的 apply_audio_fx / remove_audio_fx 同一份校验 */
const tools = createAudioFxTools({ getState, actions });

const btn =
  "shrink-0 px-1.5 py-0.5 rounded text-[11px] border border-neutral-800 text-neutral-400 hover:text-neutral-100 hover:border-neutral-600 disabled:opacity-40 disabled:hover:text-neutral-400 disabled:hover:border-neutral-800";

/**
 * 素材库「音频效果」页的列表部分:项目的音频效果库。
 * 效果大多是 Agent 用 create_audio_fx 建的;这里让人看得到、能挂到选中的视频 / 音频片段上复用、能删。
 */
export function AudioFxTab({ search }: { search: string }) {
  const project = useStore((s) => s.project);
  const selection = useStore((s) => s.selection);
  const [armed, setArmed] = useState<string | null>(null);
  const [flashMsg, setFlashMsg] = useState<string | null>(null);

  // 本地 2 秒消失的小条
  useEffect(() => {
    if (!flashMsg) return;
    const t = setTimeout(() => setFlashMsg(null), 2000);
    return () => clearTimeout(t);
  }, [flashMsg]);

  const flash = (text: string) => setFlashMsg(text);

  const rawFx = project.audioFx ?? [];
  const lowerSearch = search.toLowerCase();
  const filtered = lowerSearch
    ? rawFx.filter((f) => 
        f.name.toLowerCase().includes(lowerSearch) || 
        (f.description && f.description.toLowerCase().includes(lowerSearch)) ||
        describeAudioFx(f).toLowerCase().includes(lowerSearch)
      )
    : rawFx;

  const sel = selection[0] ? findClip(project, selection[0]) : null;
  const selClip = sel && sel.clip.mediaId && !sel.clip.cardId ? sel.clip : null;
  const selMedia = selClip ? project.media.find(m => m.id === selClip.mediaId) : null;
  const canApply = selClip && selMedia && selMedia.kind !== "image";

  const run = (fn: () => unknown, ok: string) => {
    try {
      fn();
      flash(ok);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex-1 min-h-0 overflow-y-auto pc-l-scroll relative" data-pc="audiofx">
      {flashMsg && (
        <div className="absolute top-2 left-2 right-2 bg-neutral-800 border border-neutral-700 text-neutral-200 text-[11px] px-2 py-1.5 rounded shadow-lg z-10 break-words">
          {flashMsg}
        </div>
      )}

      <div className="px-2 pt-2">
        <div className="text-[11px] text-neutral-500 leading-relaxed mb-2">
          效果大多由 Agent 用 create_audio_fx 建；这里能看、能复用、能删；预览和导出用同一套 Web Audio，听到的就是导出的。
        </div>

        <div className="text-[11px] uppercase tracking-wide text-neutral-500 px-1 py-1 flex justify-between">
          <span>效果库</span>
          <span>({filtered.length})</span>
        </div>
        {rawFx.length === 0 ? (
          <div className="px-1 text-[11.5px] text-neutral-500 leading-relaxed">
            还没有音频效果。让 Agent 建一个（比如「把配乐压低给人声让路」「给结尾的字加大厅混响」），或从下面的预设新建。
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-1 text-[11.5px] text-neutral-500 leading-relaxed">
            没搜到匹配的效果。
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {filtered.map((f) => {
              const uses = audioFxUsesOf(project, f.id);
              const on = !!selClip && selClip.audioFx?.id === f.id;
              return (
                <div key={f.id} data-pc-audiofx={f.id} className="flex items-center gap-2 rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5">
                  <div className="flex-1 min-w-0">
                    <div className="text-[11.5px] text-neutral-200 truncate" title={f.description ?? f.name}>
                      {f.name}
                      {isAudioFxAnimated(f) && <span className="ml-1 text-[10px] text-neutral-500">随时间变化</span>}
                    </div>
                    <div className="text-[10.5px] text-neutral-500 truncate" title={describeAudioFx(f)}>
                      {describeAudioFx(f)}
                      {uses.length ? ` · 用在 ${uses.length} 段` : ""}
                    </div>
                  </div>
                  <button
                    type="button"
                    className={btn}
                    disabled={!canApply}
                    title={canApply ? (on ? "从选中的片段上摘掉" : "挂到选中的片段上(每段只挂一个,会替换原来的)") : "先在时间轴上选中一段视频或声音"}
                    onClick={() =>
                      canApply &&
                      (on
                        ? run(() => tools.applyAudioFx({ clipId: selClip.id, fxId: "" }), `已从选中的片段摘掉「${f.name}」`)
                        : run(() => tools.applyAudioFx({ clipId: selClip.id, fxId: f.id }), `已把「${f.name}」挂到选中的片段`))
                    }
                  >
                    {on ? "摘掉" : "挂到选中"}
                  </button>
                  <button
                    type="button"
                    className={btn}
                    title={uses.length ? `用在 ${uses.length} 段上,删了会一起摘掉` : "从效果库删掉"}
                    onClick={() => {
                      if (uses.length && armed !== f.id) {
                        setArmed(f.id);
                        flash(`「${f.name}」用在 ${uses.length} 段上;再点一次「确认删除」会把这些段上的它一起摘掉`);
                        return;
                      }
                      setArmed(null);
                      run(() => tools.removeAudioFx({ fxId: f.id, force: uses.length > 0, reason: "用户在素材库里删除" }), `已删除「${f.name}」`);
                    }}
                  >
                    {armed === f.id ? "确认删除" : "删除"}
                  </button>
                </div>
              );
            })}
          </div>
        )}

        <div className="mt-4 mb-2">
          <div className="text-[11px] uppercase tracking-wide text-neutral-500 px-1 py-1">
            从预设新建
          </div>
          <div className="flex flex-col gap-1">
            {AUDIO_FX_PRESETS.map((preset, idx) => (
              <div key={idx} className="flex items-center gap-2 rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5">
                <div className="flex-1 min-w-0">
                  <div className="text-[11.5px] text-neutral-200 truncate">{preset.name}</div>
                  {preset.description && <div className="text-[10.5px] text-neutral-500 truncate">{preset.description}</div>}
                </div>
                <button
                  type="button"
                  className={btn}
                  onClick={() => 
                    run(
                      () => tools.createAudioFx({ ...preset, createdBy: "user", ...(canApply ? { clipId: selClip.id } : null) }), 
                      canApply ? `已新建「${preset.name}」并挂到选中片段` : `已新建「${preset.name}」`
                    )
                  }
                >
                  {canApply ? "新建并挂到选中" : "新建"}
                </button>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-4 mb-4 text-[11px] text-neutral-400">
          <details>
            <summary className="cursor-pointer hover:text-neutral-200 px-1 py-1 select-none">
              效果种类 (点击展开)
            </summary>
            <div className="mt-2 flex flex-col gap-2 pl-2 border-l border-neutral-800">
              {Object.entries(AUDIO_FX_KINDS).map(([kind, spec]) => (
                <div key={kind}>
                  <div className="text-neutral-300 font-mono text-[10px]">{kind} <span className="text-neutral-500 ml-1">{spec.label}</span></div>
                  <div className="text-[10px] text-neutral-500 mb-0.5">{spec.hint}</div>
                  <div className="text-[10px] text-neutral-400 flex flex-wrap gap-x-3 gap-y-0.5">
                    {Object.entries(spec.params).map(([pk, ps]) => (
                      <span key={pk}>{pk} ({ps.min}~{ps.max}{ps.unit ? ` ${ps.unit}` : ""})</span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </details>
        </div>
      </div>
    </div>
  );
}
