/**
 * 聊天页右边的拓展栏(用户 2026-10-23 定):标题栏右上角那颗按钮开关它。
 *
 * 三段,都能折叠 —— 形式参考用户给的那张 IDE 面板图(分段标题 + 段里一行行),内容按软件里已有的说法来:
 *   1. **画面**:播放这一版看一遍。传输控件(播放/暂停、拖动、时间)是真的,画面本身是占位色块;
 *   2. **这次改动**:一行一次操作,写「类别 · 工具名 · 耗时」加结果里的那句话 —— 和编辑器里操作详情的
 *      头一行同一个写法(`src/editor/right/chat/iconRuns.ts` 的 `KIND_LABEL`);每行一个「撤销这步」,
 *      文案和 `src/editor/sync/AgentUndoButton.tsx` 一致(撤完变「已撤销」);
 *   3. **修改前 / 修改后**:选中上面那一行带前后画面的改动,这里切着看。两个标签的叫法照
 *      `src/editor/right/chat/OpDetailPreview.tsx` 里的「修改前」「修改后」。
 *
 * **这一版只跑界面**:画面是按 id 哈希出来的色块,改动是 `mockChat.ts` 里写死的,「撤销这步」只改这一页上的
 * 样子。真画面要由预渲染或即时渲染给(`product/rendering.md`),改动清单和撤销要接云端文档服务。
 */
import { useEffect, useRef, useState } from "react";
import type { JSX, RefObject } from "react";
import { hueOf } from "./hue";
import { changesOf, type MockChange } from "./mockChat";

/** 假的片长(秒):传输控件按它走 */
const DURATION = 15;

/**
 * 「这次改动」那一段先归档,默认不显示 —— **这是用户 2026-10-23 要求的**,
 * 用户给的理由:改动已经显示在每次聊天的气泡里了(Agent 消息下面那一块「Agent 操作」),右边再列一遍是重复。
 *
 * 段落本身、假数据、「撤销这步」都原样留着,把这一行改回 true 就回来。
 * 记录另见 `docs/plan/user-decisions-2026-10-23.md`。
 */
const SHOW_CHANGES = false;

function section(
  key: string,
  title: string,
  open: boolean,
  toggle: () => void,
  body: JSX.Element,
  right?: JSX.Element,
): JSX.Element {
  return (
    // 钩子名带 `sec-`:不带的话「画面」这一段会和里面那颗播放键(`start-ext-play`)撞同一个名字
    <section className="ps-ext-sec" data-pc={`start-ext-sec-${key}`} data-open={open}>
      <div className="ps-ext-head">
        <button type="button" className="ps-ext-toggle" aria-expanded={open} onClick={toggle}>
          <span className="ps-ext-caret" data-open={open} aria-hidden="true">›</span>
          {title}
        </button>
        {right}
      </div>
      {open && <div className="ps-ext-body">{body}</div>}
    </section>
  );
}

/** 占位画面:和缩略图同一路子,色相由种子哈希出来,不配图片 */
function Frame(props: { seed: string; label?: string; innerRef?: RefObject<HTMLDivElement | null>; children?: JSX.Element }): JSX.Element {
  const hue = hueOf(props.seed);
  return (
    <div
      ref={props.innerRef}
      className="ps-ext-frame"
      style={{ background: `linear-gradient(145deg, hsl(${hue} 52% 40%), hsl(${(hue + 38) % 360} 48% 24%))` }}
    >
      {props.label && <span className="ps-ext-frame-tag">{props.label}</span>}
      {props.children}
    </div>
  );
}

const mmss = (sec: number) =>
  `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;

export function ChatSidePanel(props: { chatId: string; projectSeed: string; onNote: (text: string) => void }): JSX.Element {
  const changes = changesOf(props.chatId);
  const diffs = changes.filter((c) => c.hasDiff);

  const [open, setOpen] = useState({ play: true, changes: true, diff: true });
  const [playing, setPlaying] = useState(false);
  const [at, setAt] = useState(0);
  const [undone, setUndone] = useState<Record<string, boolean>>({});
  const [picked, setPicked] = useState<string | null>(diffs[0]?.id ?? null);
  const [side, setSide] = useState<"before" | "after">("after");
  const [full, setFull] = useState(false);
  const timer = useRef<number | null>(null);
  const frame = useRef<HTMLDivElement>(null);

  // 全屏可能由用户自己按 Esc 退出,按钮的样子要跟着变,所以听浏览器的事件而不是只记自己点过
  useEffect(() => {
    const onChange = () => setFull(document.fullscreenElement === frame.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFull = () => {
    const el = frame.current;
    if (!el) return;
    const done = document.fullscreenElement ? document.exitFullscreen() : el.requestFullscreen();
    // 页面被嵌在不许全屏的框里时会被拒,如实说一句,不要抛进控制台
    void Promise.resolve(done).catch(() => props.onNote("这个浏览器不让这一页进全屏。"));
  };

  // 换一条对话:播放、选中、撤销状态都重来
  useEffect(() => {
    setPlaying(false);
    setAt(0);
    setUndone({});
    setPicked(changesOf(props.chatId).find((c) => c.hasDiff)?.id ?? null);
    setSide("after");
  }, [props.chatId]);

  // 走时间。到头就停,不循环
  useEffect(() => {
    if (!playing) return;
    timer.current = window.setInterval(() => {
      setAt((t) => {
        const next = t + 0.1;
        if (next >= DURATION) {
          setPlaying(false);
          return DURATION;
        }
        return next;
      });
    }, 100);
    return () => {
      if (timer.current !== null) window.clearInterval(timer.current);
      timer.current = null;
    };
  }, [playing]);

  const changeRow = (c: MockChange) => (
    <div key={c.id} className="ps-ext-row" data-pc="start-ext-change" data-change={c.id} data-picked={picked === c.id || undefined}>
      <button
        type="button"
        className="ps-ext-row-main"
        aria-label={`${c.kind} ${c.tool}${c.note ? `，${c.note}` : ""}`}
        onClick={() => {
          if (c.hasDiff) {
            setPicked(c.id);
            setOpen((o) => ({ ...o, diff: true }));
          } else {
            props.onNote(`这一步没有前后画面可比（${c.kind} · ${c.tool}）。`);
          }
        }}
      >
        <span className="ps-ext-row-top">
          <span className="ps-ext-kind">{c.kind}</span>
          <span className="ps-ext-tool">{c.tool}</span>
          <span className="ps-ext-ms">{c.ms} ms</span>
        </span>
        {c.note && <span className="ps-ext-note">{c.note}</span>}
      </button>
      <button
        type="button"
        className="ps-ext-undo"
        data-pc="start-ext-undo"
        disabled={!!undone[c.id]}
        onClick={() => {
          setUndone((u) => ({ ...u, [c.id]: true }));
          props.onNote("待办：撤销要以页面身份提交逆操作、进用户自己的撤销栈（见 src/editor/sync/AgentUndoButton.tsx）。");
        }}
      >
        {undone[c.id] ? "已撤销" : "撤销这步"}
      </button>
    </div>
  );

  const pickedChange = diffs.find((c) => c.id === picked) ?? null;

  return (
    <aside className="ps-ext" data-pc="start-ext">
      {section(
        "play",
        "画面",
        open.play,
        () => setOpen((o) => ({ ...o, play: !o.play })),
        <>
          {/* 播放条叠在画面里(用户 2026-10-23 定):省掉画框下面那一条的高度 */}
          <Frame seed={props.projectSeed} innerRef={frame}>
            <>
              <button
                type="button"
                className="ps-ext-play"
                data-pc="start-ext-play"
                aria-label={playing ? "暂停" : "播放"}
                onClick={() => setPlaying((p) => !p)}
              >
                {playing ? (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6.5" y="5" width="4" height="14" rx="1" /><rect x="13.5" y="5" width="4" height="14" rx="1" /></svg>
                ) : (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.6 19 12 7 19.4z" /></svg>
                )}
              </button>
              <div className="ps-ext-transport">
                <input
                  type="range"
                  className="ps-ext-scrub"
                  data-pc="start-ext-scrub"
                  min={0}
                  max={DURATION}
                  step={0.1}
                  value={at}
                  aria-label="进度"
                  onChange={(e) => setAt(Number(e.target.value))}
                />
                <span className="ps-ext-time">{mmss(at)} / {mmss(DURATION)}</span>
                <button
                  type="button"
                  className="ps-ext-full"
                  data-pc="start-ext-fullscreen"
                  aria-label={full ? "退出全屏" : "全屏"}
                  aria-pressed={full}
                  onClick={toggleFull}
                >
                  {full ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M9 3v6H3M15 3v6h6M9 21v-6H3M15 21v-6h6" />
                    </svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 9V3h6M21 9V3h-6M3 15v6h6M21 15v6h-6" />
                    </svg>
                  )}
                </button>
              </div>
            </>
          </Frame>
          <p className="ps-ext-todo">待办：真画面由预渲染或即时渲染给（product/rendering.md），这里现在是占位色块。</p>
        </>,
      )}

      {SHOW_CHANGES &&
        section(
          "changes",
          "这次改动",
          open.changes,
          () => setOpen((o) => ({ ...o, changes: !o.changes })),
          changes.length > 0 ? (
            <div className="ps-ext-rows">{changes.map(changeRow)}</div>
          ) : (
            <p className="ps-ext-todo">这条对话还没有改动。</p>
          ),
          <span className="ps-ext-count">{changes.length}</span>,
        )}

      {section(
        "diff",
        "修改前 / 修改后",
        open.diff,
        () => setOpen((o) => ({ ...o, diff: !o.diff })),
        pickedChange ? (
          <>
            <div className="ps-ext-seg" role="group" aria-label="看改前还是改后">
              {(["before", "after"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  className="ps-ext-seg-btn"
                  data-pc={`start-ext-${s}`}
                  aria-pressed={side === s}
                  onClick={() => setSide(s)}
                >
                  {s === "before" ? "修改前" : "修改后"}
                </button>
              ))}
            </div>
            <Frame
              seed={`${pickedChange.id}-${side}`}
              label={side === "before" ? "修改前" : "修改后"}
            />
            <p className="ps-ext-note">{pickedChange.note}</p>
          </>
        ) : (
          <p className="ps-ext-todo">这条对话还没有带前后画面的改动。</p>
        ),
      )}
    </aside>
  );
}
