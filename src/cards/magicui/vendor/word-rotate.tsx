/**
 * 来源: 复刻自 Magic UI (https://magicui.design/docs/components/word-rotate)
 * MIT License
 * 
 * 本地改动:
 * - 移除了 setInterval，改用 requestAnimationFrame + performance.now() 轮播。
 * - 从 motion/react 导入。
 * - 使用本地 cn。
 */
import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { cn } from "./cn";

interface WordRotateProps {
  words: string[];
  duration?: number;
  framerProps?: any;
  className?: string;
}

export function WordRotate({
  words,
  duration = 2500,
  framerProps = {
    initial: { opacity: 0, y: -50 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: 50 },
    transition: { duration: 0.25, ease: "easeOut" },
  },
  className,
}: WordRotateProps) {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    let rAF: number;
    let lastTick = performance.now();

    const tick = (now: number) => {
      if (now - lastTick >= duration) {
        setIndex((i) => (i + 1) % words.length);
        lastTick = now;
      }
      rAF = requestAnimationFrame(tick);
    };

    rAF = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rAF);
  }, [words, duration]);

  return (
    <div className="overflow-hidden py-2">
      <AnimatePresence mode="wait">
        <motion.h1
          key={words[index]}
          className={cn(className)}
          {...framerProps}
        >
          {words[index]}
        </motion.h1>
      </AnimatePresence>
    </div>
  );
}
