import { useState } from "react";
import { actions, getState, useStore } from "../../store/project";
import type { TrackClip } from "../../kernel/project";
import { describeFilter, type FilterParamSpec } from "../../kernel/filters.mjs";
import { createFilterTools } from "../right/filterTools";

/** 和 Agent 的 apply_filter 同一份校验 */
const tools = createFilterTools({ getState, actions });

const stepOf = (spec: FilterParamSpec) => {
  const span = spec.max !== undefined && spec.min !== undefined ? spec.max - spec.min : Math.abs(spec.default) || 1;
  return span <= 2 ? 0.01 : span <= 20 ? 0.1 : 1;
};

/** 编辑页里素材段的滤镜一栏:从滤镜库挑一个挂上,再逐段调它声明的参数 */
export function ClipFilterForm({ clip }: { clip: TrackClip }) {
  const filters = useStore((s) => s.project.filters) ?? [];
  const [err, setErr] = useState<string | null>(null);
  const cur = clip.filter ? filters.find((f) => f.id === clip.filter!.id) : undefined;

  const apply = (filterId: string, params?: Record<string, number>) => {
    try {
      tools.applyFilter({ clipId: clip.id, filterId, params });
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="mt-2 pt-2 border-t border-neutral-800" data-pc="clip-filter">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-neutral-400 shrink-0">滤镜</span>
        <select
          data-pc="clip-filter-select"
          value={cur?.id ?? ""}
          onChange={(e) => apply(e.target.value)}
          className="h-6 flex-1 min-w-0 text-xs bg-neutral-900 border border-neutral-800 rounded px-1 text-neutral-200 outline-none"
        >
          <option value="">无</option>
          {filters.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      </div>
      {filters.length === 0 && <div className="text-neutral-500">滤镜库是空的:让 Agent 建一个,会出现在「转场/滤镜」页</div>}
      {cur && (
        <div className="text-neutral-500 mb-1 truncate" title={describeFilter(cur)}>
          {describeFilter(cur)}
        </div>
      )}
      {cur?.params &&
        Object.entries(cur.params).map(([k, spec]) => (
          <label key={k} className="flex items-center gap-2 mb-1">
            <span className="w-16 truncate text-neutral-400" title={k}>
              {spec.label ?? k}
            </span>
            <input
              data-pc={`clip-filter-param-${k}`}
              type="number"
              step={stepOf(spec)}
              min={spec.min}
              max={spec.max}
              value={clip.filter?.params?.[k] ?? spec.default}
              onChange={(e) => {
                // 打「-」的瞬间 value 是空串,Number("") 是 0 —— 不能当成提交了 0,不然负数永远打不进去
                if (e.target.value === "" || e.target.value === "-") return;
                const n = Number(e.target.value);
                // 只带声明过的键:update_filter 删掉过的参数还留在片段上的话,整栏都会被「没有参数 X」卡住
                const kept = Object.fromEntries(Object.entries(clip.filter?.params ?? {}).filter(([key]) => cur.params && key in cur.params));
                if (Number.isFinite(n)) apply(cur.id, { ...kept, [k]: n });
              }}
              className="w-20 h-6 px-1 bg-neutral-900 border border-neutral-800 rounded text-neutral-200 outline-none"
            />
          </label>
        ))}
      {err && <div className="text-red-400 mt-1">{err}</div>}
    </div>
  );
}
