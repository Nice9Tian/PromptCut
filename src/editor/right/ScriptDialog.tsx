import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { getScript, setScript } from "../../ai/script";
import "./ScriptDialog.css";

/**
 * 剧本编辑窗。
 *
 * 挂在 body 上(portal):右栏是 overflow:hidden 的,不挂出去会被裁掉。
 * 编辑期间只改本地草稿,点保存才写进 store —— 中途改了一半就被 AI 读走
 * 是更糟的体验。
 */
export function ScriptDialog(props: { open: boolean; onClose: () => void }) {
  const { open, onClose } = props;
  const [draft, setDraft] = useState("");

  // 每次打开都从 store 取最新的:AI 可能在上一轮里改过剧本
  useEffect(() => {
    if (open) setDraft(getScript());
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
      // Ctrl/Cmd+Enter 保存并关闭,和别处的输入框一致
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); setScript(draft); onClose(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, draft, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="scr-backdrop" onClick={onClose}>
      <div className="scr-dialog" role="dialog" aria-modal="true" aria-label="剧本" onClick={(e) => e.stopPropagation()}>
        <div className="scr-title">剧本</div>
        <div className="scr-hint">
          写清这条片子要讲什么、按什么顺序讲。它会**每一轮**都附在 AI 的系统提示里，
          用来把多轮执行拉回主线；留空就不附加。
        </div>
        <textarea
          className="scr-text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
          autoFocus
          placeholder={"例：\n1. 开场 5 秒讲清痛点，用金句卡\n2. 中段按「问题 → 数据 → 方案」推进，数据段配趋势图\n3. 结尾回扣开头那句话"}
        />
        <div className="scr-actions">
          <span className="scr-count">{draft.length} 字</span>
          <button className="scr-btn" onClick={() => { setDraft(""); }}>清空</button>
          <button className="scr-btn" onClick={onClose}>取消</button>
          <button className="scr-btn is-primary" onClick={() => { setScript(draft); onClose(); }}>
            保存
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
