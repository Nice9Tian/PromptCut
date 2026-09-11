import { useEffect, useState } from "react";
import type { JSX } from "react";
import { createPortal } from "react-dom";
import { KIND_LABEL } from "./io/mediaKinds";
import { onMediaMigrations, takeMediaMigrations, type MediaKindMigration } from "./io/mediaMigrationBus";

export function MediaMigrationDialog(): JSX.Element | null {
  const [items, setItems] = useState<MediaKindMigration[]>([]);
  const headless = (() => {
    try { return new URLSearchParams(location.search).has("headless"); } catch { return false; }
  })();
  useEffect(() => {
    const pull = () => setItems((old) => [...old, ...takeMediaMigrations()]);
    pull();
    return onMediaMigrations(pull);
  }, []);
  // 无头实例是给导出 / Agent 用的，不应让一个只给人看的确认层挡住画面。
  if (headless || !items.length) return null;
  return createPortal(
    <div className="pc-dialog-mask" role="presentation">
      <div className="pc-dialog" role="dialog" aria-modal="true" aria-labelledby="pc-media-migration-title">
        <div id="pc-media-migration-title" className="pc-dialog-title">已自动整理素材分类</div>
        <div className="pc-dialog-body">
          <p className="text-neutral-300 text-sm mb-3">发现旧项目中有素材分类与文件扩展名不一致，已移动到对应分页：</p>
          <div className="max-h-64 overflow-y-auto rounded border border-neutral-700">
            {items.map((item, index) => (
              <div key={`${item.id}-${index}`} className="flex items-center justify-between gap-3 px-3 py-2 border-b last:border-b-0 border-neutral-800 text-xs">
                <span className="truncate text-neutral-200" title={item.name}>{item.name}</span>
                <span className="shrink-0 text-neutral-400">{KIND_LABEL[item.from]} → {KIND_LABEL[item.to]}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="pc-dialog-foot">
          <button type="button" className="pc-dialog-opt is-on" onClick={() => setItems([])}>确定</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
