/**
 * 预览工具栏。
 * 位于预览画面上方，包含选择、移动、文字三种交互工具按钮。
 * 提供当前激活工具的状态及切换回调。
 */
import React from "react";
import { IconCursor, IconText, IconMove } from "../../ui/icons";
import "../../ui/toolbar.css";

export type ToolType = "select" | "text" | "move";

export function ToolBar({ tool, onToolChange }: { tool: ToolType; onToolChange: (tool: ToolType) => void }) {
  return (
    <div className="pc-bar" style={{ justifyContent: "center" }}>
      <button
        className="pc-btn pc-btn--icon"
        aria-pressed={tool === "select"}
        onClick={() => onToolChange("select")}
        title="选择"
        style={tool === "select" ? { background: "var(--ui-accent)", color: "var(--ui-accent-fg)", borderColor: "var(--ui-accent)" } : {}}
      >
        <IconCursor />
      </button>
      <button
        className="pc-btn pc-btn--icon"
        aria-pressed={tool === "move"}
        onClick={() => onToolChange("move")}
        title="移动"
        style={tool === "move" ? { background: "var(--ui-accent)", color: "var(--ui-accent-fg)", borderColor: "var(--ui-accent)" } : {}}
      >
        <IconMove />
      </button>
      <button
        className="pc-btn pc-btn--icon"
        aria-pressed={tool === "text"}
        onClick={() => onToolChange("text")}
        title="文字"
        style={tool === "text" ? { background: "var(--ui-accent)", color: "var(--ui-accent-fg)", borderColor: "var(--ui-accent)" } : {}}
      >
        <IconText />
      </button>
    </div>
  );
}
