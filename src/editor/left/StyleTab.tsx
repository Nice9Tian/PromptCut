import { themes } from "../../themes";
import { useStore, actions } from "../../store/project";

/** 素材 → 全局风格: 可点击的主题卡片列表，点击切换项目全局主题 */
export function StyleTab() {
  const currentThemeId = useStore((s) => s.project.themeId);

  return (
    <div className="flex-1 min-h-0 flex flex-col pc-l-scroll">
      <div data-pc="theme-list" className="flex-1 overflow-y-auto pc-l-scroll p-2 flex flex-col gap-2">
        {themes.map((th) => {
          const isSelected = currentThemeId === th.id;
          const accent = th.vars.accent || "#3b82f6";
          const fg = th.vars.fg || "#ffffff";
          const glassBg = th.vars["glass-bg"] || "rgba(255,255,255,0.1)";
          const glassBorder = th.vars["glass-border"] || "rgba(255,255,255,0.2)";

          return (
            <button
              key={th.id}
              type="button"
              data-pc-theme={th.id}
              onClick={() => actions.setProjectMeta({ themeId: th.id })}
              className={`w-full text-left p-2.5 rounded-lg border transition-colors flex flex-col gap-1.5 ${
                isSelected
                  ? "border-neutral-400 bg-neutral-800"
                  : "border-neutral-800 bg-neutral-900/60 hover:bg-neutral-800/60 hover:border-neutral-700"
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-neutral-100">{th.name}</span>
                {isSelected && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-neutral-700 text-neutral-200">当前</span>
                )}
              </div>
              <p className="text-[11px] text-neutral-400 leading-snug">{th.description}</p>

              {/* 配色预览: 代表性色彩小色块 */}
              <div className="flex items-center gap-2 mt-0.5 pt-1.5 border-t border-neutral-800/80">
                <div
                  className="w-4 h-4 rounded-full border border-neutral-700 shrink-0"
                  style={{ backgroundColor: accent }}
                  title={`主色: ${accent}`}
                />
                <div
                  className="w-4 h-4 rounded-full border border-neutral-700 shrink-0"
                  style={{ backgroundColor: fg }}
                  title={`文字: ${fg}`}
                />
                <div
                  className="w-4 h-4 rounded-full border border-neutral-700 shrink-0"
                  style={{ backgroundColor: glassBg }}
                  title={`玻璃底: ${glassBg}`}
                />
                <div
                  className="w-4 h-4 rounded-full border border-neutral-700 shrink-0"
                  style={{ backgroundColor: glassBorder }}
                  title={`边线: ${glassBorder}`}
                />
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
