import { useState } from "react";
import { actions, getState, useStore } from "../../store/project";
import { findClip } from "../../kernel/project";
import { cssFilter, describeFilter, isAnimated, resolveOps, type FilterDef } from "../../kernel/filters.mjs";
import { createFilterTools, usesOf } from "../right/filterTools";

/** 和 Agent 的 apply_filter / remove_filter 同一份校验(锁定的序列、卡片段、还挂着就删要确认) */
const tools = createFilterTools({ getState, actions });

const btn =
  "shrink-0 px-1.5 py-0.5 rounded text-[11px] border border-neutral-800 text-neutral-400 hover:text-neutral-100 hover:border-neutral-600 disabled:opacity-40 disabled:hover:text-neutral-400 disabled:hover:border-neutral-800";

/**
 * 素材库「转场/滤镜」页的滤镜部分:项目的滤镜库。
 * 滤镜大多是 Agent 用 create_filter 建的;这里让人看得到、能挂到选中的视频 / 图片片段上复用、能删。
 */
export function FiltersSection({ flash }: { flash: (text: string) => void }) {
  const project = useStore((s) => s.project);
  const selection = useStore((s) => s.selection);
  const [armed, setArmed] = useState<string | null>(null);
  const filters = project.filters ?? [];
  const sel = selection[0] ? findClip(project, selection[0]) : null;
  const selClip = sel && sel.clip.mediaId && !sel.clip.cardId ? sel.clip : null;

  const run = (fn: () => unknown, ok: string) => {
    try {
      fn();
      flash(ok);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="px-2 pt-2" data-pc="filters">
      <div className="text-[11px] uppercase tracking-wide text-neutral-500 px-1 py-1 flex justify-between">
        <span>滤镜</span>
        <span>({filters.length})</span>
      </div>
      {filters.length === 0 ? (
        <div className="px-1 text-[11.5px] text-neutral-500 leading-relaxed">
          还没有滤镜。
          <br />
          让 Agent 建一个(比如「给夜景那几段做个冷色调」),它会出现在这里,之后能挂到任意视频 / 图片片段上复用。
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          {filters.map((f) => {
            const uses = usesOf(project, f.id);
            const on = !!selClip && selClip.filter?.id === f.id;
            return (
              <div key={f.id} data-pc-filter={f.id} className="flex items-center gap-2 rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5">
                <Swatch def={f} />
                <div className="flex-1 min-w-0">
                  <div className="text-[11.5px] text-neutral-200 truncate" title={f.description ?? f.name}>
                    {f.name}
                    {isAnimated(f) && <span className="ml-1 text-[10px] text-neutral-500">随时间变化</span>}
                  </div>
                  <div className="text-[10.5px] text-neutral-500 truncate" title={describeFilter(f)}>
                    {describeFilter(f)}
                    {uses.length ? ` · 用在 ${uses.length} 段` : ""}
                  </div>
                </div>
                <button
                  type="button"
                  className={btn}
                  disabled={!selClip}
                  title={selClip ? (on ? "从选中的片段上摘掉" : "挂到选中的片段上(每段只挂一个,会替换原来的)") : "先在时间轴上选中一段视频或图片"}
                  onClick={() =>
                    selClip &&
                    (on
                      ? run(() => tools.applyFilter({ clipId: selClip.id, filterId: "" }), `已从选中的片段摘掉「${f.name}」`)
                      : run(() => tools.applyFilter({ clipId: selClip.id, filterId: f.id }), `已把「${f.name}」挂到选中的片段`))
                  }
                >
                  {on ? "摘掉" : "挂到选中"}
                </button>
                <button
                  type="button"
                  className={btn}
                  title={uses.length ? `用在 ${uses.length} 段上,删了会一起摘掉` : "从滤镜库删掉"}
                  onClick={() => {
                    if (uses.length && armed !== f.id) {
                      setArmed(f.id);
                      flash(`「${f.name}」用在 ${uses.length} 段上;再点一次「确认删除」会把这些段上的它一起摘掉`);
                      return;
                    }
                    setArmed(null);
                    run(() => tools.removeFilter({ filterId: f.id, force: uses.length > 0, reason: "用户在素材库里删除" }), `已删除「${f.name}」`);
                  }}
                >
                  {armed === f.id ? "确认删除" : "删除"}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** 一小块彩色样片套上滤镜(片段 1 秒处的样子),一眼看出冷暖、黑白、糊不糊 */
function Swatch({ def }: { def: FilterDef }) {
  const css = cssFilter(resolveOps(def, undefined, 1, 2), 0.25);
  return (
    <div
      aria-hidden="true"
      className="shrink-0 rounded-sm"
      style={{
        width: 28,
        height: 20,
        background: "linear-gradient(135deg, #e8553a 0%, #f2c14e 35%, #3fa9f5 70%, #2d6a4f 100%)",
        filter: css || undefined,
      }}
    />
  );
}
