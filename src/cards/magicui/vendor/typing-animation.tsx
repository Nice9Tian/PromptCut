/**
 * 来源: 复刻自 Magic UI (https://magicui.design/docs/components/typing-animation)
 * MIT License
 * 
 * 本地改动:
 * - 移除了 setInterval/setTimeout，改用 requestAnimationFrame + performance.now()。
 * - 去除了 clsx/tailwind-merge，使用 cn.ts。
 * - 移除了 text-4xl 和 leading-[5rem] 以避免与传入字号冲突，并暴露 style prop。
 */
import { useEffect, useState } from "react";
import { cn } from "./cn";

interface TypingAnimationProps {
  text: string;
  duration?: number;
  className?: string;
  style?: React.CSSProperties;
}

export function TypingAnimation({
  text,
  duration = 200,
  className,
  style,
}: TypingAnimationProps) {
  const [displayedText, setDisplayedText] = useState<string>("");

  useEffect(() => {
    let rAF: number;
    const startTime = performance.now();
    let i = 0;

    const tick = (now: number) => {
      const elapsed = now - startTime;
      const targetLength = Math.floor(elapsed / duration);
      
      if (targetLength > i && i < text.length) {
        setDisplayedText(text.substring(0, targetLength));
        i = targetLength;
      }
      
      if (i < text.length) {
        rAF = requestAnimationFrame(tick);
      } else {
        setDisplayedText(text); // Ensure it completes
      }
    };
    rAF = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(rAF);
  }, [text, duration]);

  return (
    <h1
      className={cn(
        "font-display text-center font-bold tracking-[-0.02em] drop-shadow-sm",
        className,
      )}
      style={style}
    >
      {displayedText}
    </h1>
  );
}
