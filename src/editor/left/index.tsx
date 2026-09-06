import "./debug";
import "./left.css";
import { useState } from "react";
import { CardsTab } from "./CardsTab";
import { MediaTab } from "./MediaTab";
import { CaptionsTab } from "./CaptionsTab";
import { Inspector } from "./Inspector";

/**
 * 左栏:两级分页。
 *   顶级  素材 | 编辑
 *   二级  素材 → 卡片 / 视频 / 字幕     编辑 → 参数 / 代码
 * 分页选择记在 localStorage;各分页都常驻挂载(只是隐藏),切来切去不丢滚动位置和输入。
 */
type TopTab = "assets" | "edit";
type AssetTab = "cards" | "videos" | "captions";
type EditTab = "form" | "code";

const TOP_TABS: { key: TopTab; label: string }[] = [
  { key: "assets", label: "素材" },
  { key: "edit", label: "编辑" },
];
const ASSET_TABS: { key: AssetTab; label: string }[] = [
  { key: "cards", label: "卡片" },
  { key: "videos", label: "视频" },
  { key: "captions", label: "字幕" },
];
const EDIT_TABS: { key: EditTab; label: string }[] = [
  { key: "form", label: "参数" },
  { key: "code", label: "代码" },
];

function stored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key) as T | null;
    if (v && allowed.includes(v)) return v;
  } catch {}
  return fallback;
}

export function LeftPanel() {
  const [top, setTop] = useState<TopTab>(() => stored("pc.left.tab", ["assets", "edit"] as const, "assets"));
  const [assetTab, setAssetTab] = useState<AssetTab>(() =>
    stored("pc.left.assetTab", ["cards", "videos", "captions"] as const, "cards"),
  );
  const [editTab, setEditTab] = useState<EditTab>(() => stored("pc.left.editTab", ["form", "code"] as const, "form"));
  const [captionMediaId, setCaptionMediaId] = useState<string | null>(null);

  const pick = <T extends string>(key: string, set: (v: T) => void) => (v: T) => {
    set(v);
    try {
      localStorage.setItem(key, v);
    } catch {}
  };
  const pickTop = pick<TopTab>("pc.left.tab", setTop);
  const pickAsset = pick<AssetTab>("pc.left.assetTab", setAssetTab);
  const pickEdit = pick<EditTab>("pc.left.editTab", setEditTab);

  const openCaptions = (mediaId: string) => {
    setCaptionMediaId(mediaId);
    pickAsset("captions");
  };

  const subTabs = top === "assets" ? ASSET_TABS : EDIT_TABS;
  const subActive: string = top === "assets" ? assetTab : editTab;
  const pickSub = (key: string) => (top === "assets" ? pickAsset(key as AssetTab) : pickEdit(key as EditTab));

  return (
    <div data-pc="left" className="h-full flex flex-col min-h-0 overflow-hidden bg-neutral-950 text-neutral-100">
      {/* 顶级分页 */}
      <div className="h-8 flex items-center gap-1 px-2 border-b border-neutral-800 text-xs shrink-0">
        {TOP_TABS.map((tab) => (
          <button
            key={tab.key}
            data-pc-top-tab={tab.key}
            className={`flex h-full items-center px-1.5 ${
              top === tab.key ? "text-neutral-100 border-b-2 border-b-neutral-100" : "text-neutral-500 hover:text-neutral-300"
            }`}
            onClick={() => pickTop(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* 二级分页 */}
      <div className="h-7 flex items-center gap-1 px-2 border-b border-neutral-800 text-[11px] shrink-0 bg-neutral-900/40">
        {subTabs.map((tab) => (
          <button
            key={tab.key}
            data-pc-tab={tab.key}
            className={`flex h-full items-center px-1.5 ${
              subActive === tab.key ? "text-neutral-100 border-b-2 border-b-neutral-300" : "text-neutral-500 hover:text-neutral-300"
            }`}
            onClick={() => pickSub(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* 素材 */}
      <div
        data-pc="library"
        className="flex-1 min-h-0 flex-col overflow-hidden"
        style={{ display: top === "assets" ? "flex" : "none" }}
      >
        <div className="flex-1 min-h-0 flex-col" style={{ display: assetTab === "cards" ? "flex" : "none" }}>
          <CardsTab />
        </div>
        <div className="flex-1 min-h-0 flex-col" style={{ display: assetTab === "videos" ? "flex" : "none" }}>
          <MediaTab onOpenCaptions={openCaptions} />
        </div>
        <div className="flex-1 min-h-0 flex-col" style={{ display: assetTab === "captions" ? "flex" : "none" }}>
          <CaptionsTab mediaId={captionMediaId} onPick={setCaptionMediaId} />
        </div>
      </div>

      {/* 编辑 */}
      <div
        data-pc="inspector"
        className="flex-1 min-h-0 flex-col overflow-hidden"
        style={{ display: top === "edit" ? "flex" : "none" }}
      >
        <Inspector tab={editTab} />
      </div>
    </div>
  );
}
