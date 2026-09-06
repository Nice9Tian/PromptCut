import { useMemo } from "react";
import type { CardDef, CardProps } from "../../kernel/types";
import { WordRotate } from "./vendor/word-rotate";

interface Params {
  words: string;
  prefix: string;
}

function WordRotateCard({ params }: CardProps<Params>) {
  const wordsToPass = useMemo(() => {
    const wordsArray = params.words.split("|").map(w => w.trim()).filter(Boolean);
    return wordsArray.length > 0 ? wordsArray : ["无数据"];
  }, [params.words]);

  return (
    <div className="absolute inset-0 flex items-center justify-center bg-transparent" style={{ fontFamily: "var(--pc-font, system-ui, sans-serif)" }}>
      <div className="flex items-center gap-8 text-[96px] font-bold" style={{ color: "var(--pc-fg, #f3f4f6)", textShadow: "var(--pc-text-shadow, 0 4px 24px rgba(0,0,0,0.75))" }}>
        <span>{params.prefix}</span>
        <WordRotate words={wordsToPass} duration={1000} className="" />
      </div>
    </div>
  );
}

export const wordRotateCard: CardDef<Params> = {
  id: "mu-word-rotate",
  name: "文字轮换",
  description: "多个词语循环轮换",
  source: "magicui",
  defaults: { words: "优秀|卓越|完美|无瑕", prefix: "你是" },
  controls: [
    { key: "words", label: "轮换词(用|分隔)", type: "text" },
    { key: "prefix", label: "前缀", type: "text" },
  ],
  Component: WordRotateCard,
};
