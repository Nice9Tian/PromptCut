import { useEffect, useState } from "react";
import type { JSX } from "react";
import { prerenderUrl, usePrerenderBase, withBase } from "../../render/prerender";

/**
 * 聊天栏里一步工具的「看得见的结果」:当时返回的位图、改了哪几个参数、前后两段动图。
 *
 * 记录由执行工具的那一方交给服务端存着(src/ai/mcpExecutor.ts 的 withVisual,或者服务端直接执行的
 * 看图工具),工具结果最前面带一个 visualId。四家的工具结果摘要都保留开头那一截,所以这里从摘要里
 * 认 id 就够了,不用关心这一步是 API 直连还是 agy / Claude / Codex 跑的。
 *
 * 记录和动图都存在**预渲染进程**上(/api/ai/visual 在那边),所以地址前面拼预渲染的源:
 * 动图第一次打开要现渲几秒到几十秒,挂在编辑器自己的源上会占着它的连接。
 */
export function visualIdOf(summary?: string): string | null {
  const m = /"visualId"\s*:\s*"(v-[0-9a-z]{6,40})"/.exec(summary || "");
  return m ? m[1] : null;
}

export interface VisualRecord {
  tool: string;
  images?: { url: string; label?: string }[];
  before?: { gif: string };
  after?: { gif: string };
  diff?: { key: string; from: string; to: string }[];
}

/**
 * 记录的模块级缓存:同一个 id 只取一次。
 *
 * 气泡里的操作详细预览控件(chat/OpDetailPreview.tsx)要把一条消息看过的画面一起列出来,点开操作清单时
 * ToolVisual 又要显示同一份记录;各取各的话,一条消息几十次操作就是几十个重复请求。
 * 存的是 Promise,同一时刻好几处要同一个 id 也只发一次请求。
 * 取失败的不留在缓存里 —— 和原来每次挂载都重新取一样,下次打开还能再试。
 */
const inflight = new Map<string, Promise<VisualRecord>>();
const loaded = new Map<string, VisualRecord>();

export function loadVisualRecord(id: string): Promise<VisualRecord> {
  const hit = inflight.get(id);
  if (hit) return hit;
  const p = prerenderUrl(`/api/ai/visual/${id}.json`)
    .then((u) => fetch(u))
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((d) => {
      const rec = (d?.record ?? d) as VisualRecord;
      loaded.set(id, rec);
      return rec;
    });
  inflight.set(id, p);
  p.catch(() => {
    if (inflight.get(id) === p) inflight.delete(id);
  });
  return p;
}

/** 已经取回来的记录,同步读;还没取回来或者取失败时是 undefined */
export function peekVisualRecord(id: string): VisualRecord | undefined {
  return loaded.get(id);
}

/** 取一份记录给界面用:缓存里有就直接给(不闪「正在取回」),没有就去取,取失败把原因带出来 */
export function useVisualRecord(id: string | null): { rec: VisualRecord | null; err: string } {
  const [state, setState] = useState<{ id: string | null; rec: VisualRecord | null; err: string }>(
    () => ({ id, rec: (id && loaded.get(id)) || null, err: "" }),
  );

  useEffect(() => {
    if (!id) return;
    let alive = true;
    loadVisualRecord(id).then(
      (rec) => {
        if (alive) setState((s) => (s.id === id && s.rec === rec && !s.err ? s : { id, rec, err: "" }));
      },
      (e) => {
        if (alive) setState({ id, rec: null, err: String(e?.message || e) });
      },
    );
    return () => { alive = false; };
  }, [id]);

  // id 换了、效果还没跑到:别拿上一个 id 的结果冒充这一个
  if (state.id !== id) return { rec: (id && loaded.get(id)) || null, err: "" };
  return { rec: state.rec, err: state.err };
}

export function ToolVisual({ id }: { id: string }): JSX.Element {
  const { rec, err } = useVisualRecord(id);
  const base = usePrerenderBase();

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
              <img src={withBase(base, im.url)} alt={im.label || `画面 ${i + 1}`} loading="lazy" />
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
          {rec.before ? <Gif src={withBase(base, rec.before.gif)} label={beforeLabel} /> : null}
          {rec.before && rec.after ? <div className="ai-visual-arrow" aria-hidden>→</div> : null}
          {rec.after ? <Gif src={withBase(base, rec.after.gif)} label={afterLabel} /> : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 动图第一次打开时服务端才去渲(8 帧 + 编码),要等几秒到几十秒 —— 转圈,失败了能重试。
 * 轮播也用它;挂载即开始加载,所以别在还没翻到的页里挂它。
 */
/** onSettled:动图出来或确定失败时调(操作详细预览控件靠它判断这一页渲染好没有,好了才让翻过去) */
export function Gif({ src, label, onSettled }: { src: string; label: string; onSettled?: () => void }): JSX.Element {
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
              onLoad={() => { setState("ok"); onSettled?.(); }}
              onError={() => { setState("err"); onSettled?.(); }}
            />
          </>
        )}
      </div>
      <figcaption>{label}{state === "loading" ? " · 正在渲染…" : ""}</figcaption>
    </figure>
  );
}
