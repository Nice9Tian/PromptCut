import "./debug";
import "./left.css";
import { useRef, useState } from "react";
import { CardsTab, type CardsTabHandle } from "./CardsTab";
import { MediaTab } from "./MediaTab";
import { CaptionsTab } from "./CaptionsTab";
import { TransitionsTab } from "./TransitionsTab";
import type { MediaAsset } from "../../kernel/project";
import { StyleTab } from "./StyleTab";
import { AssetToolbar } from "./AssetToolbar";
import { Inspector } from "./Inspector";

/**
 * 左栏:两级分页。
 *   顶级  素材 | 编辑
 *   二级  素材 → 全局风格 / 卡片 / 视频 / 字幕     编辑 → 参数 / 代码
 * 分页选择记在 localStorage;各分页都常驻挂载(只是隐藏),切来切去不丢滚动位置和输入。
 */
type TopTab = "assets" | "edit";
type AssetTab = "style" | "cards" | "transitions" | "videos" | "music" | "captions";
type EditTab = "form" | "code";

const TOP_TABS: { key: TopTab; label: string }[] = [
  { key: "assets", label: "素材" },
  { key: "edit", label: "编辑" },
];
const ASSET_TABS: { key: AssetTab; label: string }[] = [
  { key: "style", label: "全局风格" },
  { key: "cards", label: "卡片" },
  { key: "transitions", label: "转场" },
  { key: "videos", label: "视频" },
  { key: "music", label: "配乐" },
  { key: "captions", label: "字幕" },
];
/** 视频页看画面,配乐页看声音 */
const VISUAL_KINDS: MediaAsset["kind"][] = ["video", "image"];
const AUDIO_KINDS: MediaAsset["kind"][] = ["audio"];

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
    stored("pc.left.assetTab", ["style", "cards", "transitions", "videos", "music", "captions"] as const, "cards"),
  );
  const [editTab, setEditTab] = useState<EditTab>(() => stored("pc.left.editTab", ["form", "code"] as const, "form"));
  const [captionMediaId, setCaptionMediaId] = useState<string | null>(null);

  // 搜索词按分页各记各的，切分页时各自保持不变
  const [cardsSearch, setCardsSearch] = useState("");
  const [videosSearch, setVideosSearch] = useState("");
  const [captionsSearch, setCaptionsSearch] = useState("");

  const [musicSearch, setMusicSearch] = useState("");
  const cardsTabRef = useRef<CardsTabHandle>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

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

  const currentSearch =
    assetTab === "cards" ? cardsSearch : assetTab === "videos" ? videosSearch : assetTab === "music" ? musicSearch : captionsSearch;

  const handleSearchChange = (val: string) => {
    if (assetTab === "cards") setCardsSearch(val);
    else if (assetTab === "videos") setVideosSearch(val);
    else if (assetTab === "music") setMusicSearch(val);
    else if (assetTab === "captions") setCaptionsSearch(val);
  };

  const handleClearSearch = () => {
    if (assetTab === "cards") setCardsSearch("");
    else if (assetTab === "videos") setVideosSearch("");
    else if (assetTab === "music") setMusicSearch("");
    else if (assetTab === "captions") setCaptionsSearch("");
  };

  return (
    <div data-pc="left" className="h-full flex flex-col min-h-0 overflow-hidden bg-neutral-950 text-neutral-100">
      {/* 顶级分页:选中主文字 + 强调色下划线(配色诊断与修正 v2 左栏) */}
      <div className="pc-l-tabs">
        {TOP_TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            data-pc-top-tab={tab.key}
            className={`pc-l-tab${top === tab.key ? " is-on" : ""}`}
            onClick={() => pickTop(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* 二级分页:胶囊,可换行 */}
      <div className="pc-l-subtabs">
        {subTabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            data-pc-tab={tab.key}
            className={`pc-l-pill${subActive === tab.key ? " is-on" : ""}`}
            onClick={() => pickSub(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* 素材 */}
      <div
        data-pc="library"
        className="flex-1 min-h-0 flex flex-col overflow-hidden"
        style={{ display: top === "assets" ? "flex" : "none" }}
      >
        {/* 统一导航条: 仅在素材且二级分页为卡片/视频/字幕时显示 */}
        {assetTab !== "style" && (
          <AssetToolbar
            captionMediaId={captionMediaId}
            assetTab={assetTab}
            search={currentSearch}
            onSearchChange={handleSearchChange}
            onClearSearch={handleClearSearch}
            onScrollCardsToTop={() => cardsTabRef.current?.scrollToTop()}
            searchInputRef={searchInputRef}
          />
        )}

        <div className="flex-1 min-h-0 flex flex-col" style={{ display: assetTab === "style" ? "flex" : "none" }}>
          <StyleTab />
        </div>
        <div className="flex-1 min-h-0 flex flex-col" style={{ display: assetTab === "cards" ? "flex" : "none" }}>
          <CardsTab ref={cardsTabRef} search={cardsSearch} />
        </div>
        <div className="flex-1 min-h-0 flex flex-col" style={{ display: assetTab === "transitions" ? "flex" : "none" }}>
          <TransitionsTab />
        </div>
        <div className="flex-1 min-h-0 flex flex-col" style={{ display: assetTab === "videos" ? "flex" : "none" }}>
          <MediaTab search={videosSearch} onOpenCaptions={openCaptions} kinds={VISUAL_KINDS} />
        </div>
        <div className="flex-1 min-h-0 flex flex-col" style={{ display: assetTab === "music" ? "flex" : "none" }}>
          <MediaTab search={musicSearch} onOpenCaptions={openCaptions} kinds={AUDIO_KINDS} />
        </div>
        <div className="flex-1 min-h-0 flex flex-col" style={{ display: assetTab === "captions" ? "flex" : "none" }}>
          <CaptionsTab
            search={captionsSearch}
            mediaId={captionMediaId}
            onPick={setCaptionMediaId}
            onGoImport={() => pickAsset("videos")}
          />
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
