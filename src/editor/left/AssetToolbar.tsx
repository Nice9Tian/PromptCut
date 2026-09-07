import { useRef } from "react";
import { importSrtFile } from "../io";
import { IconClose, IconImport, IconPlus, IconSearch } from "../../ui/icons";
import { KIND_LABEL, MEDIA_ACCEPT, importMediaFiles, type AssetKind } from "./importAssets";

export type AssetToolbarTab = "cards" | "transitions" | "videos" | "images" | "music" | "captions";

export interface AssetToolbarProps {
  assetTab: AssetToolbarTab;
  search: string;
  onSearchChange: (value: string) => void;
  onClearSearch: () => void;
  onScrollCardsToTop: () => void;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  /** 字幕分页当前选中的素材:导入的字幕挂到它身上(没有就挂第一条) */
  captionMediaId?: string | null;
  /** 导入完成后把用户带到素材落地的那个分页,让他看见东西进来了 */
  onImported?: (kind: AssetKind) => void;
}

/** 每个分页的搜索框措辞与自动化用的 data-pc 标记 */
const SEARCH_META: Record<AssetToolbarTab, { placeholder: string; dataPc: string }> = {
  cards: { placeholder: "搜索卡片…", dataPc: "search" },
  transitions: { placeholder: "搜索转场…", dataPc: "transition-search" },
  videos: { placeholder: "搜索视频…", dataPc: "media-search" },
  images: { placeholder: "搜索图像…", dataPc: "image-search" },
  music: { placeholder: "搜索配乐…", dataPc: "music-search" },
  captions: { placeholder: "搜索字幕…", dataPc: "caption-search" },
};

/**
 * 统一导航条: 位于二级分页栏之下。
 *
 * 左起第一个是常驻的「导入素材」:任何素材分页都能用,选进来的文件按类型自动落到
 * 视频 / 配乐 / 图像页,不用先切到对的分页再导入。
 * 它右边那个「+」留给没法被通用导入覆盖的分页专属动作(卡片页清空回顶、字幕页导入 .srt);
 * 视频 / 配乐 / 图像页的「+」原本就是导入,已经被通用导入收编,所以不再重复出现。
 */
export function AssetToolbar({
  assetTab,
  search,
  onSearchChange,
  onClearSearch,
  onScrollCardsToTop,
  searchInputRef,
  captionMediaId,
  onImported,
}: AssetToolbarProps) {
  const mediaInputRef = useRef<HTMLInputElement>(null);
  const srtInputRef = useRef<HTMLInputElement>(null);

  const extraAdd =
    assetTab === "cards"
      ? { title: "清空搜索并回顶", onClick: () => {
          onClearSearch();
          onScrollCardsToTop();
          searchInputRef.current?.focus();
        } }
      : assetTab === "captions"
        ? { title: "导入字幕 (.srt / .vtt)", onClick: () => srtInputRef.current?.click() }
        : null;

  const handleMediaFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    try {
      const { counts, skipped, firstKind } = await importMediaFiles(files);
      if (firstKind) onImported?.(firstKind);
      if (skipped.length > 0) {
        const done = (Object.keys(counts) as AssetKind[])
          .filter((k) => counts[k] > 0)
          .map((k) => `${KIND_LABEL[k]} ${counts[k]}`)
          .join("、");
        alert(
          `${done ? `已导入:${done}。\n\n` : ""}这些文件不是视频 / 音频 / 图片,已跳过:\n${skipped.join("\n")}`,
        );
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      alert(`导入素材失败: ${msg}`);
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

  const { placeholder, dataPc } = SEARCH_META[assetTab];

  return (
    <div data-pc="asset-toolbar" className="pc-l-tools">
      <button
        type="button"
        data-pc-add="media"
        onClick={() => mediaInputRef.current?.click()}
        title="导入素材(视频 / 音频 / 图片,按类型自动归位)"
        className="pc-l-add is-import"
      >
        <IconImport size={13} />
      </button>

      {extraAdd && (
        <button type="button" data-pc-add={assetTab} onClick={extraAdd.onClick} title={extraAdd.title} className="pc-l-add">
          <IconPlus size={13} />
        </button>
      )}

      <label className="pc-l-search">
        <IconSearch size={12} />
        <input
          ref={searchInputRef}
          data-pc={dataPc}
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
        ref={mediaInputRef}
        type="file"
        accept={MEDIA_ACCEPT}
        multiple
        style={{ display: "none" }}
        onChange={handleMediaFileChange}
      />
      <input
        ref={srtInputRef}
        type="file"
        accept=".srt,.vtt"
        style={{ display: "none" }}
        onChange={handleSrtFileChange}
      />
    </div>
  );
}
