import { useCallback, useEffect, useRef, useState } from "react";
import { IconImport } from "../../ui/icons";
import { ALL_GROUPS } from "../cardScope";
import { KIND_LABEL, MEDIA_ACCEPT, importMediaFiles, type AssetKind } from "./importAssets";
import { CardScopeBar } from "./CardScopeBar";
import { UserCardMenu } from "./UserCardMenu";
import { SearchBox } from "./SearchBox";
import { FlashBar, useFlash } from "./useFlash";
import { useOpenGroup } from "./stored";
import { KIND_GROUP, LIBRARY_GROUPS, LIBRARY_GROUP_IDS, type GroupData } from "./library/groups";
import { GroupBrowser } from "./library/GroupBrowser";
import { useMediaGroup, useMediaMenu } from "./library/mediaGroups";
import { useCardGroups, useCardLibrary, usePartsList } from "./library/cardGroups";

/**
 * 「素材库」分区:导入媒体 → 搜索 + 卡片筛选 → 分类胶囊 → 分组(视频 / 图片 / 音频 / 各类卡片 / 部件)。
 *
 * 右键菜单、删除确认框、定制卡换档菜单、底部提示条都挂在这一级常驻渲染,
 * 不跟着某个组的详情走 —— 在总览、组详情、搜索结果里右键都弹得出来。
 */
export function LibrarySection() {
  const [search, setSearch] = useState("");
  const q = search.trim().toLowerCase();
  const searching = q !== "";
  const [openGroup, setOpenGroup] = useOpenGroup("library", LIBRARY_GROUP_IDS);
  const [msg, flash] = useFlash();
  const mediaInputRef = useRef<HTMLInputElement>(null);

  // 素材三组共用一份右键菜单
  const mediaMenu = useMediaMenu(flash);
  const videos = useMediaGroup("video", q, mediaMenu.openMenu);
  const images = useMediaGroup("image", q, mediaMenu.openMenu);
  const music = useMediaGroup("audio", q, mediaMenu.openMenu);

  // 卡片:一份数据源(可见性 + 归属表 + 搜索),几个卡片组共用
  const cards = useCardLibrary(q);
  const parts = usePartsList(q);
  const [userMenu, setUserMenu] = useState<{ cardId: string; x: number; y: number } | null>(null);
  const openUserMenu = useCallback((e: React.MouseEvent, cardId: string) => {
    e.preventDefault();
    setUserMenu({ cardId, x: e.clientX, y: e.clientY });
  }, []);
  const closeUserMenu = useCallback(() => setUserMenu(null), []);
  const cardGroups = useCardGroups(cards, parts, searching, openUserMenu);

  const data: Record<string, GroupData> = { videos, images, music, ...cardGroups };

  // 搜索框右边的筛选浮层(CardScopeBar):点外面或按 Esc 收起
  const [scopeOpen, setScopeOpen] = useState(false);
  const scopeWrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!scopeOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!scopeWrapRef.current?.contains(e.target as Node)) setScopeOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setScopeOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [scopeOpen]);
  const v = cards.vis;
  const narrowed = !v.base || !v.custom || !v.project || ALL_GROUPS.some((g) => v.groups[g] === false);

  const importMedia = useCallback(() => mediaInputRef.current?.click(), []);

  const handleMediaFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    try {
      const { counts, skipped, firstKind, rejected } = await importMediaFiles(files);
      // 导入完成后把用户带到素材落地的那个组,让他看见东西进来了
      if (firstKind) setOpenGroup(KIND_GROUP[firstKind]);
      if (skipped.length > 0) {
        const done = (Object.keys(counts) as AssetKind[])
          .filter((k) => counts[k] > 0)
          .map((k) => `${KIND_LABEL[k]} ${counts[k]}`)
          .join("、");
        const details = rejected.length ? `\n\n${rejected.join("\n")}` : "";
        alert(`${done ? `已导入:${done}。\n\n` : ""}这些文件不是视频 / 音频 / 图片,已跳过:\n${skipped.join("\n")}${details}`);
      }
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : String(err);
      alert(`导入素材失败: ${m}`);
    } finally {
      e.target.value = "";
    }
  };

  return (
    <div data-pc="library" className="pc-left-section">
      <div className="pc-left-head">
        <div className="pc-section-title">素材库</div>
        {/* 常驻的导入:选进来的文件按类型自动落到视频 / 图片 / 音频组 */}
        <button
          type="button"
          className="pc-btn-primary is-block pc-left-primary"
          data-pc-add="media"
          title="导入素材(视频 / 音频 / 图片,按类型自动归位)"
          onClick={importMedia}
        >
          <IconImport size={16} />
          <span>导入媒体</span>
        </button>
        <div className="pc-left-searchrow" ref={scopeWrapRef}>
          <SearchBox value={search} onChange={setSearch} placeholder="搜索素材、卡片…" dataPc="search" />
          <button
            type="button"
            className={`pc-icon-btn pc-left-filter${narrowed ? " is-narrowed" : ""}`}
            data-pc="scope-toggle"
            aria-pressed={scopeOpen}
            aria-haspopup="dialog"
            title={narrowed ? "卡片筛选:有档位关着,点开调整" : "卡片筛选:基础 / 自定义 / 项目"}
            onClick={() => setScopeOpen((o) => !o)}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 5h16l-6.2 7.4V19l-3.6-1.8v-4.8z" />
            </svg>
          </button>
          {scopeOpen && (
            <div className="pc-lib-popover" role="dialog" aria-label="卡片筛选">
              <div className="pc-lib-popover-title">卡片筛选</div>
              <div className="pc-lib-popover-hint">关掉哪一档,卡库和 AI 助手看到的卡片同时生效</div>
              <CardScopeBar onChange={cards.setVis} />
            </div>
          )}
        </div>
      </div>

      <GroupBrowser
        groups={LIBRARY_GROUPS}
        data={data}
        searching={searching}
        openId={openGroup}
        onOpen={setOpenGroup}
        onImport={importMedia}
        noMatch="没有匹配的素材或卡片"
      />

      <FlashBar msg={msg} />

      {mediaMenu.overlay}
      {userMenu && (
        <UserCardMenu
          cardId={userMenu.cardId}
          entry={cards.scopes[userMenu.cardId]}
          x={userMenu.x}
          y={userMenu.y}
          onClose={closeUserMenu}
          onChanged={cards.reloadScopes}
        />
      )}

      <input ref={mediaInputRef} type="file" accept={MEDIA_ACCEPT} multiple style={{ display: "none" }} onChange={handleMediaFileChange} />
    </div>
  );
}
