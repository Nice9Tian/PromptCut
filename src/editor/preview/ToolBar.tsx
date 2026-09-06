/**
 * 预览工具行(配色诊断与修正 v2 整屏,中栏顶部)。
 * 直接铺在 L0 画布上,没有条底:三个 28 方工具钮(选中 L3 底 + 强调色描边),
 * 右侧是画幅 / 帧率的等宽小字和「适应窗口」小徽章。
 */
import { useStore } from "../../store/project";
import { IconCursor, IconText, IconMove } from "../../ui/icons";
import "./preview.css";

export type ToolType = "select" | "text" | "move";

const TOOLS: { key: ToolType; label: string; Icon: typeof IconCursor }[] = [
  { key: "select", label: "选择", Icon: IconCursor },
  { key: "move", label: "移动", Icon: IconMove },
  { key: "text", label: "文字", Icon: IconText },
];

export function ToolBar({ tool, onToolChange }: { tool: ToolType; onToolChange: (tool: ToolType) => void }) {
  const width = useStore((s) => s.project.width);
  const height = useStore((s) => s.project.height);
  const fps = useStore((s) => s.project.fps);
  return (
    <div className="pc-pv-tools" role="toolbar" aria-label="预览工具">
      {TOOLS.map(({ key, label, Icon }) => (
        <button
          key={key}
          type="button"
          className={`pc-pv-tool${tool === key ? " is-on" : ""}`}
          aria-pressed={tool === key}
          onClick={() => onToolChange(key)}
          title={label}
        >
          <Icon size={14} />
        </button>
      ))}
      <span className="pc-pv-meta">
        {width} × {height} · {fps} fps
      </span>
      <span className="pc-pv-badge">适应窗口</span>
    </div>
  );
}
