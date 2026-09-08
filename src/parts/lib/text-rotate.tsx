import { useMemo } from "react";
import type { PartDef, PartProps } from "../types";
import { WordRotate } from "../../cards/magicui/vendor/word-rotate";

/**
 * 文字轮换:从 mu-word-rotate 拆出。
 * 前缀文字加上可无限轮换的后缀词汇。
 */
interface Params {
  prefix: string;
  words: string;
  holdMs: number;
}

function RotatePart({ params }: PartProps<Params>) {
  const wordsToPass = useMemo(() => {
    const wordsArray = params.words.split("|").map(w => w.trim()).filter(Boolean);
    return wordsArray.length > 0 ? wordsArray : ["无数据"];
  }, [params.words]);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        boxSizing: "border-box",
        fontFamily: "var(--pc-font, system-ui, sans-serif)",
      }}
    >
      <div
        className="flex items-center gap-8 text-[96px] font-bold"
        style={{
          color: "var(--pc-fg, #f3f4f6)",
          textShadow: "var(--pc-text-shadow, 0 4px 24px rgba(0,0,0,0.75))",
        }}
      >
        <span>{params.prefix}</span>
        <WordRotate words={wordsToPass} duration={params.holdMs} className="" />
      </div>
    </div>
  );
}

export const textRotate: PartDef<Params> = {
  id: "text-rotate",
  name: "文字轮换",
  description: "多个词语循环轮换播放",
  useWhen: "一个固定前缀后面跟多个同级词汇不停循环轮换时使用，适合并列排比；该部件会无限循环播放。",
  tags: ["轮换", "排比", "词语", "循环"],
  role: "text",
  from: "mu-word-rotate",
  defaults: {
    prefix: "你是",
    words: "优秀|卓越|完美|无瑕",
    holdMs: 1000,
  },
  controls: [
    { key: "prefix", label: "前缀", type: "text" },
    { key: "words", label: "轮换词(用|分隔)", type: "text", required: true },
    { key: "holdMs", label: "每词停留(ms)", type: "number", min: 100, max: 5000, step: 100 },
  ],
  defaultFrame: { x: 360, y: 440, w: 1200, h: 200 },
  settleMs: () => 250,
  after: "loop",
  Component: RotatePart,
};
