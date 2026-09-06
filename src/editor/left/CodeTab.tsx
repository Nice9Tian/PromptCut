import { useState, useRef, useEffect } from "react";
import { actions } from "../../store/project";
import { getCard } from "../../kernel/registry";
import type { TrackClip } from "../../kernel/project";

export function CodeTab({ clip }: { clip: TrackClip }) {
  const current = JSON.stringify({ cardId: clip.cardId, start: clip.start, end: clip.end, params: clip.params }, null, 2);
  const lastCurrent = useRef(current);

  const [draft, setDraft] = useState(current);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [applied, setApplied] = useState(false);

  const card = getCard(clip.cardId);
  /**
   * 卡片声明了、但这个 clip 里没有的参数。
   * 正常情况下是空的 —— 参数在写入时就展开成全量了(见 store 的 addCardClip)。
   * 非空说明这张卡后来新增了参数,而这个 clip 是更早建的:它现在靠 Stage 那层
   * 兜底的 defaults 在渲染,值没有存在 clip 里。把它显出来,而不是让人对着
   * 一份看起来完整、实则少了东西的 JSON 猜。
   */
  const missing = (card?.controls ?? []).map((c) => c.key).filter((k) => !(k in (clip.params ?? {})));

  useEffect(() => {
    if (current !== lastCurrent.current) {
      if (draft === lastCurrent.current) {
        setDraft(current);
      }
      lastCurrent.current = current;
      setErrorMsg(null);
    }
  }, [current, draft]);

  const dirty = draft !== current;

  const apply = () => {
    let parsed: any;
    try {
      parsed = JSON.parse(draft);
    } catch (e: any) {
      setErrorMsg(`JSON 不合法: ${e.message}`);
      return;
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      setErrorMsg("最外层要是一个对象 { ... }");
      return;
    }

    if ("cardId" in parsed) {
      if (typeof parsed.cardId !== "string" || !getCard(parsed.cardId)) {
        setErrorMsg(`没有这张卡: ${parsed.cardId}`);
        return;
      }
    }

    if ("start" in parsed || "end" in parsed) {
      const s = "start" in parsed ? parsed.start : clip.start;
      const e = "end" in parsed ? parsed.end : clip.end;
      if (typeof s !== "number" || !Number.isFinite(s) || typeof e !== "number" || !Number.isFinite(e) || e <= s) {
        setErrorMsg("start / end 要是数字且 end > start");
        return;
      }
    }

    if ("params" in parsed) {
      if (typeof parsed.params !== "object" || parsed.params === null || Array.isArray(parsed.params)) {
        setErrorMsg("params 要是一个对象");
        return;
      }
    }

    if ("cardId" in parsed && parsed.cardId !== clip.cardId) {
      actions.setClipCard(clip.id, parsed.cardId);
    }
    
    if (("start" in parsed && parsed.start !== clip.start) || ("end" in parsed && parsed.end !== clip.end)) {
      const moveOpts: any = {};
      if ("start" in parsed && parsed.start !== clip.start) moveOpts.start = parsed.start;
      if ("end" in parsed && parsed.end !== clip.end) moveOpts.end = parsed.end;
      if (Object.keys(moveOpts).length > 0) {
        actions.moveClip(clip.id, moveOpts);
      }
    }

    if ("params" in parsed) {
      actions.setClipParams(clip.id, parsed.params, { merge: false });
    }

    setErrorMsg(null);
    setApplied(true);
    setTimeout(() => setApplied(false), 2000);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      apply();
    }
    if (e.key === "Tab") {
      e.preventDefault();
      const el = e.currentTarget;
      const start = el.selectionStart;
      const end = el.selectionEnd;
      const val = el.value;
      const nextVal = val.substring(0, start) + "  " + val.substring(end);
      setDraft(nextVal);
      setTimeout(() => {
        el.selectionStart = el.selectionEnd = start + 2;
      }, 0);
    }
  };

  const handleCopy = () => {
    try {
      navigator.clipboard.writeText(draft);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {}
  };

  const handleReset = () => {
    // 写回整套默认值,而不是清空成 {} —— 清空会让 clip 退回「靠兜底渲染」的隐式状态,
    // 正是这次要消灭的东西。
    const defaults = { ...(card?.defaults ?? {}) };
    actions.setClipParams(clip.id, defaults, { merge: false });
    const nextCurrent = JSON.stringify({ cardId: clip.cardId, start: clip.start, end: clip.end, params: defaults }, null, 2);
    setDraft(nextCurrent);
    lastCurrent.current = nextCurrent;
    setErrorMsg(null);
  };

  return (
    <div className="flex flex-col h-full p-2">
      <div className="flex items-center gap-2 mb-2 shrink-0 flex-wrap">
        <button
          onClick={handleCopy}
          className="text-[11px] px-2 py-1 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded border border-neutral-700"
        >
          {copied ? "✓ 已复制" : "复制"}
        </button>
        <button
          onClick={handleReset}
          className="text-[11px] px-2 py-1 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded border border-neutral-700"
        >
          重置为默认
        </button>
        {missing.length > 0 && (
          <button
            onClick={handleReset}
            title={`这张卡后来新增了参数,当前 clip 里没有:${missing.join(", ")}。点「重置为默认」把它们补齐(会一并丢掉已有的改动)`}
            className="text-[11px] px-2 py-1 bg-amber-950 hover:bg-amber-900 text-amber-400 rounded border border-amber-800"
          >
            缺 {missing.length} 项参数
          </button>
        )}
        {applied && <span className="text-[11px] text-green-500 ml-auto">已应用</span>}
      </div>

      <textarea
        data-pc="code-editor"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={apply}
        onKeyDown={onKeyDown}
        spellCheck={false}
        className={`w-full h-full font-mono text-[11px] leading-relaxed bg-neutral-950 border rounded p-2 outline-none resize-none text-neutral-200 ${errorMsg ? 'border-red-500' : 'border-neutral-800'}`}
      />

      <div data-pc="code-status" className="mt-2 shrink-0 h-4">
        {errorMsg ? (
          <div className="text-[10px] text-red-500 truncate" title={errorMsg}>{errorMsg}</div>
        ) : dirty ? (
          <div className="text-[10px] text-neutral-400">有未应用的修改 · Ctrl+Enter 应用 / 失焦应用</div>
        ) : missing.length > 0 ? (
          <div className="text-[10px] text-amber-500 truncate" title={missing.join(", ")}>
            缺 {missing.length} 项参数,正靠默认值兜底渲染:{missing.join(", ")}
          </div>
        ) : (
          <div className="text-[10px] text-neutral-500">这就是渲染用的全部参数 · 可改:cardId / start / end / params</div>
        )}
      </div>
    </div>
  );
}
