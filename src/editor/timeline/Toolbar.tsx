/**
 * 时间轴顶部工具条:控制时间轴的轨道行高。
 * - 提供小(28px)、中(44px)、大(72px)三档预览模式切换。
 * - 档位选择持久化到 localStorage。
 */
import { useTimelineContext } from "./TimelineContext";
import { type RowSize, ROW_SIZE_H } from "./utils";

export function Toolbar() {
  const { rowSize, setRowSize } = useTimelineContext();
  
  const options: { label: string; value: RowSize }[] = [
    { label: "小", value: "small" },
    { label: "中", value: "medium" },
    { label: "大", value: "large" },
  ];

  return (
    <div className="shrink-0 flex items-center h-[28px] bg-neutral-950 border-b border-neutral-800 px-2 gap-3 text-xs text-neutral-400 select-none">
      <div className="flex bg-neutral-900 rounded p-0.5 border border-neutral-800">
        {options.map((opt) => (
          <button
            key={opt.value}
            className={`px-2 py-0.5 rounded text-[11px] transition-colors ${
              rowSize === opt.value
                ? "bg-neutral-700 text-white shadow-sm"
                : "hover:bg-neutral-800 hover:text-neutral-300"
            }`}
            onClick={() => setRowSize(opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </div>
      <div className="text-[10px] text-neutral-600 pointer-events-none">
        行高: {ROW_SIZE_H[rowSize]}px
      </div>
    </div>
  );
}
