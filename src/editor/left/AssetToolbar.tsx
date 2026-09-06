import { useRef } from "react";
import { importSrtFile, importVideoFiles } from "../io";

export interface AssetToolbarProps {
  assetTab: "cards" | "videos" | "captions";
  search: string;
  onSearchChange: (value: string) => void;
  onClearSearch: () => void;
  onScrollCardsToTop: () => void;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  /** 字幕分页当前选中的素材:导入的字幕挂到它身上(没有就挂第一条) */
  captionMediaId?: string | null;
}

/**
 * 统一导航条: 位于二级分页栏之下。
 * 提供当前分页专属的「+」操作（清空回顶 / 导入视频 / 导入字幕）与搜索过滤。
 */
export function AssetToolbar({
  assetTab,
  search,
  onSearchChange,
  onClearSearch,
  onScrollCardsToTop,
  searchInputRef,
  captionMediaId,
}: AssetToolbarProps) {
  const videoInputRef = useRef<HTMLInputElement>(null);
  const srtInputRef = useRef<HTMLInputElement>(null);

  const handleAddClick = () => {
    if (assetTab === "cards") {
      onClearSearch();
      onScrollCardsToTop();
      searchInputRef.current?.focus();
    } else if (assetTab === "videos") {
      videoInputRef.current?.click();
    } else if (assetTab === "captions") {
      srtInputRef.current?.click();
    }
  };

  const handleVideoFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    try {
      await importVideoFiles(files);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      alert(`导入视频失败: ${msg}`);
    } finally {
      e.target.value = "";
    }
  };

  const handleSrtFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    try {
      await importSrtFile(files[0], { mediaId: captionMediaId ?? undefined });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      alert(`导入字幕失败: ${msg}`);
    } finally {
      e.target.value = "";
    }
  };

  const placeholder =
    assetTab === "cards" ? "搜索卡片…" : assetTab === "videos" ? "搜索视频…" : "搜索字幕…";
  const searchDataPc =
    assetTab === "cards" ? "search" : assetTab === "videos" ? "media-search" : "caption-search";
  const addTitle =
    assetTab === "cards" ? "清空搜索并回顶" : assetTab === "videos" ? "导入视频" : "导入字幕 (.srt)";

  return (
    <div
      data-pc="asset-toolbar"
      className="h-8 flex items-center gap-1.5 px-2 border-b border-neutral-800 shrink-0 bg-neutral-950"
    >
      <button
        type="button"
        data-pc-add={assetTab}
        onClick={handleAddClick}
        title={addTitle}
        className="h-7 w-7 shrink-0 flex items-center justify-center rounded border border-neutral-800 bg-neutral-900 hover:bg-neutral-800 hover:border-neutral-700 text-neutral-300 text-sm font-medium transition-colors"
      >
        +
      </button>

      <div className="flex-1 relative">
        <input
          ref={searchInputRef}
          data-pc={searchDataPc}
          type="text"
          className="w-full h-7 px-2 rounded bg-neutral-900 border border-neutral-800 text-xs text-neutral-100 placeholder:text-neutral-600 outline-none focus:border-neutral-600 pr-6"
          placeholder={placeholder}
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
        />
        {search && (
          <button
            type="button"
            className="absolute right-1 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center text-neutral-500 hover:text-neutral-300"
            onClick={onClearSearch}
            title="清空"
          >
            ✕
          </button>
        )}
      </div>

      <input
        ref={videoInputRef}
        type="file"
        accept="video/*"
        multiple
        style={{ display: "none" }}
        onChange={handleVideoFileChange}
      />
      <input
        ref={srtInputRef}
        type="file"
        accept=".srt"
        style={{ display: "none" }}
        onChange={handleSrtFileChange}
      />
    </div>
  );
}
