import { useRef } from "react";
import { importSrtFile, importVideoFiles } from "../io";
import { IconClose, IconPlus, IconSearch } from "../../ui/icons";

export interface AssetToolbarProps {
  assetTab: "cards" | "transitions" | "videos" | "music" | "captions";
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
    <div data-pc="asset-toolbar" className="pc-l-tools">
      <button type="button" data-pc-add={assetTab} onClick={handleAddClick} title={addTitle} className="pc-l-add">
        <IconPlus size={13} />
      </button>

      <label className="pc-l-search">
        <IconSearch size={12} />
        <input
          ref={searchInputRef}
          data-pc={searchDataPc}
          type="text"
          placeholder={placeholder}
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
        />
        {search && (
          <button type="button" className="pc-l-search-clear" onClick={onClearSearch} title="清空">
            <IconClose size={11} />
          </button>
        )}
      </label>

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
