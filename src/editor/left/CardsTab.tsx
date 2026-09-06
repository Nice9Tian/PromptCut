import { useMemo, useState } from "react";
import { allCards } from "../../kernel/registry";
import { CardCell } from "./CardCell";

/** 素材 → 卡片:搜索 + 动效卡网格(拖到时间轴或点一下加到播放头) */
export function CardsTab() {
  const [search, setSearch] = useState("");

  const cards = useMemo(() => {
    const q = search.toLowerCase();
    const all = allCards().filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q) ||
        c.id.toLowerCase().includes(q),
    );
    return { magic: all.filter((c) => c.source === "magicui"), native: all.filter((c) => c.source === "native"), empty: all.length === 0 };
  }, [search]);

  return (
    <div className="flex-1 min-h-0 flex flex-col pc-l-scroll">
      <div className="flex-none p-2 border-b border-neutral-800">
        <div className="relative">
          <input
            data-pc="search"
            className="w-full h-7 px-2 rounded bg-neutral-900 border border-neutral-800 text-xs text-neutral-100 placeholder:text-neutral-600 outline-none focus:border-neutral-600 pr-6"
            placeholder="搜索卡片…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button
              className="absolute right-1 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center text-neutral-500 hover:text-neutral-300"
              onClick={() => setSearch("")}
            >
              ✕
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto pc-l-scroll pb-4">
        {cards.empty && <div className="p-4 text-center text-xs text-neutral-500">没有匹配的卡片</div>}

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
    </div>
  );
}
