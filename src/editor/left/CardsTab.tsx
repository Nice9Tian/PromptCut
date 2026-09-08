import { forwardRef, useImperativeHandle, useMemo, useRef, useState } from "react";
import { allCards } from "../../kernel/registry";
import { CardCell } from "./CardCell";
import { PartCell } from "./PartCell";
import { allParts } from "../../parts/registry";
import { assetCardKind, featuredParticleIds } from "../../cards/assets";

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

  const [allParticles, setAllParticles] = useState(false);

  // 部件库:组合卡的零件。按名字、说明、标签搜
  const parts = useMemo(() => {
    const q = search.toLowerCase().trim();
    return allParts().filter((p) => !q || p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q) || p.id.includes(q) || (p.tags ?? []).some((t) => t.toLowerCase().includes(q)));
  }, [search]);

  const cards = useMemo(() => {
    const q = search.toLowerCase();
    const all = allCards().filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q) ||
        c.id.toLowerCase().includes(q) ||
        (c.source === "asset" && (c.tags ?? []).some((t) => t.toLowerCase().includes(q))),
    );
    return {
      magic: all.filter((c) => c.source === "magicui"),
      native: all.filter((c) => c.source === "native"),
      // AI 或用户现场建的卡。放在最前面:刚建出来的东西要立刻看得见,
      // 否则建完只有 AI 知道有这张卡,用户在卡库里翻不到也改不了。
      user: all.filter((c) => c.source === "user"),
      // 素材封装卡:素材目录翻译出来的 Lottie / 粒子卡(src/cards/assets),按种类分两组。
      // 素材卡还按标签搜:「雪花」「星空」这种词在 tags 里,不在 name / description 里
      lottie: all.filter((c) => assetCardKind(c) === "lottie"),
      particles: all.filter((c) => assetCardKind(c) === "particles"),
      empty: all.length === 0,
    };
  }, [search]);

  return (
    <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto pc-l-scroll pb-4 pt-1">
      {cards.empty && parts.length === 0 && <div className="p-4 text-center text-xs text-neutral-500">没有匹配的卡片</div>}

      {parts.length > 0 && (
        <div className="mb-2">
          <div className="text-[11px] uppercase tracking-wide text-neutral-500 px-2 py-1 flex justify-between" title="组合卡的零件:点一下加进选中的组合卡,没选中就在播放头新建一张组合卡">
            <span>部件库</span>
            <span>({parts.length})</span>
          </div>
          <div className="grid grid-cols-2 gap-1.5 px-2">
            {parts.map((def) => (
              <PartCell key={def.id} def={def} />
            ))}
          </div>
        </div>
      )}

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

      {cards.lottie.length > 0 && (
        <div className="mb-2">
          <div className="text-[11px] uppercase tracking-wide text-neutral-500 px-2 py-1 flex justify-between">
            <span>动效素材 · Lottie</span>
            <span>({cards.lottie.length})</span>
          </div>
          <div className="grid grid-cols-2 gap-1.5 px-2">
            {cards.lottie.map((def) => (
              <CardCell key={def.id} def={def} />
            ))}
          </div>
        </div>
      )}

      {cards.particles.length > 0 && (() => {
        const searching = search.trim() !== "";
        const shown = searching || allParticles ? cards.particles : cards.particles.filter((c) => featuredParticleIds.has(c.id));
        const hidden = cards.particles.length - shown.length;
        return (
          <div className="mb-2">
            <div className="text-[11px] uppercase tracking-wide text-neutral-500 px-2 py-1 flex justify-between">
              <span>动效素材 · 粒子背景</span>
              <span>({shown.length}/{cards.particles.length})</span>
            </div>
            <div className="grid grid-cols-2 gap-1.5 px-2">
              {shown.map((def) => (
                <CardCell key={def.id} def={def} />
              ))}
            </div>
            {!searching && (hidden > 0 || allParticles) && (
              <button
                type="button"
                className="mx-2 mt-1 text-[10px] text-neutral-400 hover:text-neutral-200 underline decoration-dotted"
                onClick={() => setAllParticles((v) => !v)}
              >
                {allParticles ? "只看精选" : `还有 ${hidden} 种,全部展开`}
              </button>
            )}
          </div>
        );
      })()}

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
