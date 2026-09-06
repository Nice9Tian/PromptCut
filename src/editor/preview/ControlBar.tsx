/**
 * 预览控制栏。
 * 放在预览窗口下方，包含播放、暂停、重播按钮，以及当前时间与总时长的显示。
 * 点击当前时间可以直接输入跳转到指定秒数。
 */
import React, { useEffect, useRef, useState } from "react";
import { actions, useStore } from "../../store/project";
import { IconPause, IconPlay, IconReplay } from "../../ui/icons";
import "../../ui/toolbar.css";

export function ControlBar() {
  const playing = useStore((s) => s.playing);
  const duration = useStore((s) => s.project.duration);
  const t = useStore((s) => s.t);
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const parseTime = (str: string) => {
    const s = str.trim();
    if (!s) return NaN;
    if (s.includes(":")) {
      const parts = s.split(":");
      if (parts.length === 2) {
        const m = parseFloat(parts[0]);
        const sec = parseFloat(parts[1]);
        if (!isNaN(m) && !isNaN(sec)) return m * 60 + sec;
      }
    }
    return parseFloat(s);
  };

  const submit = () => {
    if (!editing) return;
    setEditing(false);
    const parsed = parseTime(val);
    if (!isNaN(parsed)) {
      actions.seek(Math.max(0, Math.min(parsed, duration)));
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      submit();
    } else if (e.key === "Escape") {
      setEditing(false);
    }
  };

  return (
    <div className="pc-bar" style={{ justifyContent: "center", borderBottom: "none", borderTop: "1px solid var(--ui-border)" }}>
      <button className="pc-btn pc-btn--icon" onClick={() => actions.togglePlay()} title={playing ? "暂停" : "播放"}>
        {playing ? <IconPause /> : <IconPlay />}
      </button>
      <button className="pc-btn pc-btn--icon" onClick={() => actions.replay()} title="重播">
        <IconReplay />
      </button>
      
      <div className="pc-num" style={{ cursor: "text" }}>
        {editing ? (
          <input
            ref={inputRef}
            type="text"
            value={val}
            onChange={(e) => setVal(e.target.value)}
            onBlur={submit}
            onKeyDown={handleKeyDown}
            style={{ width: 60, background: "transparent", color: "inherit", border: "none", outline: "none", fontFamily: "inherit", textAlign: "right" }}
          />
        ) : (
          <span onClick={() => { setVal(t.toFixed(2)); setEditing(true); }} style={{ display: "inline-block", width: 60, textAlign: "right" }}>
            {t.toFixed(2)}
          </span>
        )}
        <span style={{ margin: "0 4px" }}>/</span>
        <span>{duration.toFixed(2)} s</span>
      </div>
    </div>
  );
}
