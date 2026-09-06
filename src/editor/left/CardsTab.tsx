import { forwardRef, useImperativeHandle, useMemo, useRef } from "react";
import { allCards } from "../../kernel/registry";
import { CardCell } from "./CardCell";

export interface CardsTabHandle {
  scrollToTop: () => void;
}

export interface CardsTabProps {
  search: string;
}

/** 素材 → 卡片: 动效卡网格(拖到时间轴或点一下加到播放头) */
export const CardsTab = forwardRef<CardsTabHandle, CardsTabProps>(function CardsTab(
  { search },
  ref,
) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useImperativeHandle(ref, () => ({
    scrollToTop: () => {
      if (scrollRef.current) {
        scrollRef.current.scrollTop = 0;
      }
    },
  }));

  const cards = useMemo(() => {
    const q = search.toLowerCase();
    const all = allCards().filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q) ||
        c.id.toLowerCase().includes(q),
    );
    return {
      magic: all.filter((c) => c.source === "magicui"),
      native: all.filter((c) => c.source === "native"),
      // AI 或用户现场建的卡。放在最前面:刚建出来的东西要立刻看得见,
      // 否则建完只有 AI 知道有这张卡,用户在卡库里翻不到也改不了。
      user: all.filter((c) => c.source === "user"),
      empty: all.length === 0,
    };
  }, [search]);

  return (
    <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto pc-l-scroll pb-4 pt-1">
      {cards.empty && <div className="p-4 text-center text-xs text-neutral-500">没有匹配的卡片</div>}

      {cards.user.length > 0 && (
        <div className="mb-2">
          <div className="text-[11px] uppercase tracking-wide text-neutral-500 px-2 py-1 flex justify-between">
            <span>新建</span>
            <span>({cards.user.length})</span>
          </div>
          <div className="grid grid-cols-2 gap-1.5 px-2">
            {cards.user.map((def) => (
              <CardCell key={def.id} def={def} />
            ))}
          </div>
        </div>
      )}

      {cards.magic.length > 0 && (
        <div className="mb-2">
          <div className="text-[11px] uppercase tracking-wide text-neutral-500 px-2 py-1 flex justify-between">
            <span>Magic UI</span>
            <span>({cards.magic.length})</span>
          </div>
          <div className="grid grid-cols-2 gap-1.5 px-2">
            {cards.magic.map((def) => (
              <CardCell key={def.id} def={def} />
            ))}
          </div>
        </div>
      )}

      {cards.native.length > 0 && (
        <div className="mb-2">
          <div className="text-[11px] uppercase tracking-wide text-neutral-500 px-2 py-1 flex justify-between">
            <span>自家</span>
            <span>({cards.native.length})</span>
          </div>
          <div className="grid grid-cols-2 gap-1.5 px-2">
            {cards.native.map((def) => (
              <CardCell key={def.id} def={def} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
});
