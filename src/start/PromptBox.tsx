/**
 * 开始页顶上那个输入框:写一句话就建一个项目。
 *
 * 这一版只跑界面 —— 按回车或点箭头把文字交给上层,上层现在只显示一行「待办」。
 *
 * 待办(业务层):这句话该交给 Agent 的「生产」流程(`workflow/production.md`),由它建项目、拟剧本、
 * 排卡片;在线浏览器里项目一律是放云端的多用户协作项目(`product/platforms.md`「能新建放云端的项目」),
 * 所以真接起来时这里要先确认已登录,未登录的走登录页。
 */
import { useRef, useState } from "react";
import type { JSX } from "react";
import type { MockProject } from "./mockProjects";

const RATIOS: MockProject["ratio"][] = ["16:9", "9:16", "1:1"];
/** 和 CSS 里的 max-height 对齐:再长就自己滚,不把首屏顶走 */
const MAX_H = 180;

export function PromptBox(props: { onSubmit: (text: string, ratio: MockProject["ratio"]) => void }): JSX.Element {
  const [text, setText] = useState("");
  const [ratio, setRatio] = useState<MockProject["ratio"]>("16:9");
  const area = useRef<HTMLTextAreaElement>(null);

  // 输入框跟着内容长高。不用 rows:换行、粘贴一大段都要立刻对
  const fit = () => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_H)}px`;
  };

  const send = () => {
    const t = text.trim();
    if (!t) return;
    props.onSubmit(t, ratio);
    setText("");
    // 清空之后高度也要缩回去,否则留着一个空的大框
    requestAnimationFrame(fit);
  };

  return (
    <div className="ps-prompt" data-pc="start-prompt">
      <textarea
        ref={area}
        className="ps-prompt-input"
        data-pc="start-prompt-input"
        value={text}
        placeholder="说一句你想要的片子：主题、镜头、或者直接把文案贴进来"
        aria-label="描述你想要的片子"
        onChange={(e) => {
          setText(e.target.value);
          fit();
        }}
        onKeyDown={(e) => {
          // 回车发送、Shift+回车换行;输入法组合中的回车不算(中文输入按回车是在选字)
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          }
        }}
      />
      <div className="ps-prompt-foot">
        <button type="button" className="ps-chip" title="待办：挑素材要编辑器那边的素材库">
          <span aria-hidden="true">＋</span>素材
        </button>
        {RATIOS.map((r) => (
          <button
            key={r}
            type="button"
            className="ps-chip"
            aria-pressed={r === ratio}
            onClick={() => setRatio(r)}
          >
            {r}
          </button>
        ))}
        <button
          type="button"
          className="ps-prompt-send"
          data-pc="start-prompt-send"
          disabled={!text.trim()}
          aria-label="按这句话新建项目"
          onClick={send}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 19V5M5 12l7-7 7 7" />
          </svg>
        </button>
      </div>
    </div>
  );
}
