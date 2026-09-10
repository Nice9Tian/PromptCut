import { useEffect, useState } from "react";
import type { JSX } from "react";

/**
 * 聊天栏里一步工具的「看得见的结果」:当时返回的位图、改了哪几个参数、前后两段动图。
 *
 * 记录由执行工具的页面交给服务端存着(src/ai/mcpExecutor.ts 的 withVisual),工具结果最前面
 * 带一个 visualId。四家的工具结果摘要都保留开头那一截,所以这里从摘要里认 id 就够了,
 * 不用关心这一步是 API 直连还是 agy / Claude / Codex 跑的。
 */
export function visualIdOf(summary?: string): string | null {
  const m = /"visualId"\s*:\s*"(v-[0-9a-z]{6,40})"/.exec(summary || "");
  return m ? m[1] : null;
}

interface VisualRecord {
  tool: string;
  images?: { url: string; label?: string }[];
  before?: { gif: string };
  after?: { gif: string };
  diff?: { key: string; from: string; to: string }[];
}

export function ToolVisual({ id }: { id: string }): JSX.Element {
  const [rec, setRec] = useState<VisualRecord | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    let alive = true;
    fetch(`/api/ai/visual/${id}.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => { if (alive) setRec(d.record ?? d); })
      .catch((e) => { if (alive) setErr(String(e?.message || e)); });
    return () => { alive = false; };
  }, [id]);

  if (err) return <div className="ai-visual-note">这一步的画面取不回来了({err})</div>;
  if (!rec) return <div className="ai-visual-note">正在取回画面…</div>;

  const hasGif = !!(rec.before || rec.after);
  const afterLabel = rec.before ? "修改后" : rec.tool === "get_gif" ? "整段动效" : "新加的卡片";
  const beforeLabel = rec.after ? "修改前" : "删掉的卡片";

  return (
    <div className="ai-visual">
      {rec.images?.length ? (
        <div className="ai-visual-images">
          {rec.images.map((im, i) => (
            <figure key={i}>
              <img src={im.url} alt={im.label || `画面 ${i + 1}`} loading="lazy" />
              {im.label ? <figcaption>{im.label}</figcaption> : null}
            </figure>
          ))}
        </div>
      ) : null}

      {rec.diff?.length ? (
        <ul className="ai-visual-diff">
          {rec.diff.map((d) => (
            <li key={d.key}>
              <span className="k">{d.key}</span>
              <span className="from">{d.from}</span>
              <span className="arrow" aria-hidden>→</span>
              <span className="to">{d.to}</span>
            </li>
          ))}
        </ul>
      ) : rec.before && rec.after ? (
        <div className="ai-visual-note">参数没有变化(可能只改了别的轨道,或者这一步被夹回了原值)</div>
      ) : null}

      {hasGif ? (
        <div className="ai-visual-gifs">
          {rec.before ? <Gif src={rec.before.gif} label={beforeLabel} /> : null}
          {rec.before && rec.after ? <div className="ai-visual-arrow" aria-hidden>→</div> : null}
          {rec.after ? <Gif src={rec.after.gif} label={afterLabel} /> : null}
        </div>
      ) : null}
    </div>
  );
}

/** 动图第一次打开时服务端才去渲(8 帧 + 编码),要等几秒到几十秒 —— 转圈,失败了能重试 */
function Gif({ src, label }: { src: string; label: string }): JSX.Element {
  const [state, setState] = useState<"loading" | "ok" | "err">("loading");
  const [attempt, setAttempt] = useState(0);
  return (
    <figure className={`ai-visual-gif is-${state}`}>
      <div className="box">
        {state === "err" ? (
          <button type="button" onClick={() => { setState("loading"); setAttempt((n) => n + 1); }}>动图没做出来,点这里重试</button>
        ) : (
          <>
            {state === "loading" ? <span className="ai-spinner" aria-hidden /> : null}
            <img
              key={attempt}
              src={attempt ? `${src}?retry=${attempt}` : src}
              alt={label}
              onLoad={() => setState("ok")}
              onError={() => setState("err")}
            />
          </>
        )}
      </div>
      <figcaption>{label}{state === "loading" ? " · 正在渲染…" : ""}</figcaption>
    </figure>
  );
}
