import { useSyncExternalStore } from "react";
import { activateTab, addTab, closeTab, useAgentTabs, type AgentTab } from "../../../ai/agentTabs";
import { MAIN_TAB } from "../../../ai/liveChat";
import { useScript } from "../../../ai/script";
import { setRailCollapsed, toggleRailCollapsed, useRailCollapsed } from "../../sideRails";
import { IconPlus } from "../../../ui/icons";
import "./chat.css";

/**
 * 右栏卡片此刻显示哪一页:剧本,或者 agentTabs 里当前激活的那个助手分页。
 *
 * 只记「是不是剧本」:哪个助手分页在前台仍归 agentTabs 的 active 管(它自己落 localStorage),
 * 这里再记一份 tab id 就成了两份会各自漂移的状态。
 */
export type RightPage = "script" | "agent";

const PAGE_KEY = "pc.right.page";

function readPage(): RightPage {
  try {
    return localStorage.getItem(PAGE_KEY) === "script" ? "script" : "agent";
  } catch {
    // 本地存储不可用就从助手分页开始
    return "agent";
  }
}

let page: RightPage = readPage();
const pageListeners = new Set<() => void>();

export function getRightPage(): RightPage {
  return page;
}

export function setRightPage(next: RightPage): void {
  if (next === page) return;
  page = next;
  try {
    localStorage.setItem(PAGE_KEY, next);
  } catch {
    /* 存不下也让本次会话生效 */
  }
  for (const fn of pageListeners) fn();
}

function subscribePage(fn: () => void) {
  pageListeners.add(fn);
  return () => { pageListeners.delete(fn); };
}

export function useRightPage(): RightPage {
  return useSyncExternalStore(subscribePage, getRightPage, getRightPage);
}

/** rail 上「剧本」的图标:一页写了几行字的文稿 */
function IconScript() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
      <path d="M6 3h9l4 4v14H6z" />
      <path d="M15 3v4h4" />
      <path d="M9 11h7M9 14.5h7M9 18h4" />
    </svg>
  );
}

/** 头像里的字:默认名「Agent N」取编号,声明过范围的取标题首字 */
function glyphOf(t: AgentTab, index: number): string {
  const num = /^Agent\s+(\d+)$/.exec(t.title.trim());
  if (num) return num[1];
  return [...t.title.trim()][0] ?? String(index + 1);
}

/**
 * rail 标签最多 4 个字宽:全角字算 1,半角字算 0.5。
 * 按字符数截的话「Agent 1」会被切成「Agen…」,而它其实比「剪辑导演」还窄。
 */
function shortLabel(title: string): string {
  let units = 0;
  let out = "";
  for (const ch of title) {
    const w = ch.charCodeAt(0) <= 0xff ? 0.5 : 1;
    if (units + w > 4) return out + "…";
    units += w;
    out += ch;
  }
  return out;
}

/** 悬停说明:完整标题 + 范围 + 对话 ID(给模型看的 Agent ID,send_message 的收件人就写它) */
function tabTooltip(t: AgentTab): string {
  const lines = [t.title];
  if (t.scope) lines.push(`范围:${t.scope}`);
  lines.push(t.conversationId ? `对话 ID:${t.conversationId}` : "还没开始对话");
  return lines.join("\n");
}

/**
 * 右侧竖向 rail:最上面「剧本」,分隔线,每个助手分页一项,最后「+」新开一页。
 *
 * 点别的项 = 切过去并展开右栏;点当前已选中的项 = 收起 / 展开右栏。
 * 收起只把卡片 display:none(见 index.tsx),所有 AiPanel 保持挂载,正在跑的对话不断。
 */
export function RightRail() {
  const { tabs, activeId } = useAgentTabs();
  const current = useRightPage();
  const collapsed = useRailCollapsed("right");
  const script = useScript();

  const pick = (target: "script" | string) => {
    const selected = current === "script" ? "script" : activeId;
    if (target === selected) {
      toggleRailCollapsed("right");
      return;
    }
    if (target === "script") {
      setRightPage("script");
    } else {
      activateTab(target);
      setRightPage("agent");
    }
    setRailCollapsed("right", false);
  };

  const scriptOn = current === "script";

  return (
    <nav className="pc-rail pc-rail--right pc-right-rail" data-pc="right-rail" aria-label="右栏分页">
      <button
        type="button"
        className={`pc-rail-item${scriptOn ? " is-on" : ""}`}
        data-pc-rail="script"
        aria-current={scriptOn ? "page" : undefined}
        aria-expanded={scriptOn ? !collapsed : undefined}
        title={script ? `剧本已写 ${script.length} 字，每轮都会附给 AI` : "写下这条片子要讲什么，AI 每轮都会照着它做"}
        onClick={() => pick("script")}
      >
        <IconScript />
        <span>剧本</span>
        {script && <i className="pc-rr-dot" aria-hidden="true" />}
      </button>

      <div className="pc-rail-sep" role="separator" />

      {/* 一页一个 Agent,可以同时跑。传统式和对话式布局都经 RightPanel 渲染,两种布局天然都有它 */}
      <div className="pc-rr-tabs" role="tablist" aria-orientation="vertical" aria-label="助手分页">
        {tabs.map((t, i) => {
          const on = !scriptOn && t.id === activeId;
          const closable = tabs.length > 1 && t.id !== MAIN_TAB;
          return (
            <div key={t.id} className="pc-rr-tab">
              <button
                type="button"
                role="tab"
                aria-selected={on}
                aria-expanded={on ? !collapsed : undefined}
                className={`pc-rail-item pc-rr-agent${on ? " is-on" : ""}${t.busy ? " is-busy" : ""}`}
                data-pc-agent-tab={t.id}
                title={tabTooltip(t)}
                onClick={() => pick(t.id)}
              >
                <span className="pc-rr-glyph" aria-hidden="true">{glyphOf(t, i)}</span>
                <span className="pc-rr-label">{shortLabel(t.title)}</span>
                {t.busy && <i className="pc-rr-busy" aria-hidden="true" />}
                {t.unread > 0 && (
                  <b className="pc-rr-badge" title={`${t.unread} 条其他 Agent 的消息待处理`}>{t.unread}</b>
                )}
              </button>
              {closable && (
                <button
                  type="button"
                  className="pc-rr-x"
                  aria-label={`关闭 ${t.title}`}
                  title={t.busy ? "还在跑,关掉会中断它" : "关闭这一页"}
                  onClick={() => {
                    if (t.busy && !confirm(`${t.title} 还在跑,关掉会中断它。确定关闭?`)) return;
                    closeTab(t.id);
                  }}
                >
                  ×
                </button>
              )}
            </div>
          );
        })}
      </div>

      <button
        type="button"
        className="pc-rail-item pc-rr-add"
        data-pc="agent-tab-add"
        title="新助手分页"
        aria-label="新助手分页"
        onClick={() => {
          // addTab 自己会把新页设成当前页;从剧本页点过来的也要切回助手分页并展开
          addTab();
          setRightPage("agent");
          setRailCollapsed("right", false);
        }}
      >
        <IconPlus />
      </button>
    </nav>
  );
}
