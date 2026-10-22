/**
 * 在线浏览器(电脑身份)的首屏:没登录是登录页,登录了是开始页。
 *
 * 整页的形状(用户 2026-10-23 定):
 *
 *   ┌──────────────────────────────────────────────┐
 *   │ 收起 Logo  [返回 对话名]   账号 [共有][拓展栏] │  ← 顶栏,横向贯穿
 *   ├──────────┬───────────────────────────────────┤
 *   │ 侧栏      │ 开始页 / 聊天页                   │
 *   └──────────┴───────────────────────────────────┘
 *
 * 顶栏压在侧栏和主区之上,所以**收起键和 Logo 的位置固定**,侧栏收起来也不动。顶栏中间和右边那几颗
 * 由当前是开始页还是聊天页决定,所以「共有」「拓展栏开关」这两样的状态拿在这儿,不在 `ChatView` 里。
 *
 * 手机身份走的是另一套界面(`src/mobile/MobileStart.tsx`),这一页只管电脑。
 *
 * 树的状态(顺序、置顶、归档、改过的名字)也拿在这儿,改法是 `treeState.ts` 里的纯函数;侧栏只管什么
 * 时候调。侧栏宽度和收起与否拖完、点完就写进本机(`sideWidth.ts`)。
 *
 * **这一版只跑界面**:项目是 `mockProjects.ts` 里的假数据,点新建、点项目、发消息、改名、删除都只改
 * 页面上这份假数据,不碰账号服务、文档服务,也不进编辑器。每一处要接什么,写在各自文件的文件头里。
 */
import { useMemo, useState } from "react";
import type { JSX } from "react";
import { ChatView } from "./ChatView";
import { PENDING_REPLY, messagesOf, type MockMessage } from "./mockChat";
import { OnlineLogin } from "./OnlineLogin";
import { ProjectRail } from "./ProjectRail";
import { ProjectSidebar, scopeKeyOf, type Scope, type TreeOps } from "./ProjectSidebar";
import { PromptBox } from "./PromptBox";
import { TopBar } from "./TopBar";
import { clampSideWidth, readSideCollapsed, readSideWidth, writeSideCollapsed, writeSideWidth } from "./sideWidth";
import { removeById, rename, reorder, setArchived, togglePin, visible } from "./treeState";
import { MOCK_AGENT_CHATS, MOCK_GROUPS, MOCK_PROJECTS, type MockAgentChat, type MockGroup, type MockProject } from "./mockProjects";
import "./start.css";

/** 界面预览用的地址参数:`?ui=home` 直接看开始页,`?ui=login` 看登录页。不给用户,只给开发和验收 */
function initialView(): "login" | "home" {
  try {
    return new URLSearchParams(location.search).get("ui") === "home" ? "home" : "login";
  } catch {
    return "login";
  }
}

/** 同级的键:和 `ProjectSidebar` 里判能不能拖到一起用的是同一套 */
const projectSib = (p: MockProject) => `project:${p.groupId ?? "loose"}`;
const chatSib = (c: MockAgentChat) => (c.on === "project" ? `chat:p:${c.projectId}` : `chat:g:${c.groupId}`);

export function OnlineStart(props: { onEnterEditor: () => void }): JSX.Element {
  // props.onEnterEditor 这一版没用:进编辑器要先有项目,那是业务层的事。签名保持和桌面开始页一致,
  // 免得 `src/StartPage.tsx` 那个三元分支还要分两种 props。
  void props;

  const [view, setView] = useState<"login" | "home">(initialView);
  const [scope, setScope] = useState<Scope>({ kind: "all" });
  const [notice, setNotice] = useState("");
  // `?ui=home` 是直接看开始页的预览入口,这一路没走登录,账号给个占位名,免得顶栏上显示「未登录」
  const [account, setAccount] = useState<string | null>(() => (initialView() === "home" ? "预览账号" : null));
  const [sideWidth, setSideWidth] = useState(readSideWidth);
  const [collapsed, setCollapsed] = useState(readSideCollapsed);

  /** 点开的那条 Agent 对话(聊天页);为空就是开始页 */
  const [chatId, setChatId] = useState<string | null>(null);
  /** 聊天页右边那条拓展栏;开关在顶栏上 */
  const [panel, setPanel] = useState(false);
  /** 共有 / 私有(`product/agent.md`:新建默认共有,用户可以主动改为私有)。真做是按对话记的,这一版只切界面 */
  const [shared, setShared] = useState(true);
  /**
   * 每条对话的消息,按对话号分开放。放在这儿而不是 `ChatView` 里面:切到别的对话再切回来,
   * 刚发的那几条还要在 —— 放在那边的话组件一卸载就没了,每次回来都重读写死的脚本。
   */
  const [threads, setThreads] = useState<Record<string, MockMessage[]>>({});

  const [groups, setGroups] = useState<MockGroup[]>(MOCK_GROUPS);
  // 假数据按最后改动从新到旧;之后的顺序由用户拖出来,所以只在开头排这一次
  const [projects, setProjects] = useState<MockProject[]>(() =>
    [...MOCK_PROJECTS].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  );
  const [chats, setChats] = useState<MockAgentChat[]>(MOCK_AGENT_CHATS);

  const nameOf = (id: string) => projects.find((p) => p.id === id)?.name ?? id;

  /**
   * 正在看的那条对话。按 id 去当前的 chats 里取,不存状态里的那个对象 ——
   * 这样改了名立刻跟着变,被删掉、被归档时自己退回开始页。
   */
  const openChat = chatId ? (visible(chats).find((c) => c.id === chatId) ?? null) : null;
  const whereOf = (c: MockAgentChat) =>
    c.on === "project"
      ? `项目「${nameOf(c.projectId)}」`
      : `分组「${groups.find((g) => g.id === c.groupId)?.name ?? c.groupId}」`;

  const ops: TreeOps = {
    rename: (kind, id, name) => {
      if (kind === "group") setGroups((a) => rename(a, id, name));
      else if (kind === "project") setProjects((a) => rename(a, id, name));
      else setChats((a) => rename(a, id, name));
    },
    pin: (kind, id) => {
      if (kind === "group") setGroups((a) => togglePin(a, id));
      else if (kind === "project") setProjects((a) => togglePin(a, id));
      else setChats((a) => togglePin(a, id));
      setNotice("置顶只在自己同级里生效：分组里的项目置顶，只在那个分组里顶上去。");
    },
    archive: (kind, id) => {
      if (kind === "group") setGroups((a) => setArchived(a, id, true));
      else if (kind === "project") setProjects((a) => setArchived(a, id, true));
      else setChats((a) => setArchived(a, id, true));
      setNotice("已归档，从树里收起来了。待办：真做的时候要有「已归档」那一处能看回来、能取消归档。");
    },
    remove: (kind, id) => {
      if (kind === "group") setGroups((a) => removeById(a, id));
      else if (kind === "project") setProjects((a) => removeById(a, id));
      else setChats((a) => removeById(a, id));
      setNotice("已从这份假数据里删掉（刷新页面就回来）。待办：真删云端项目不可撤销，必须先弹确认。");
    },
    reorder: (kind, dragId, overId, place) => {
      if (kind === "group") setGroups((a) => reorder(a, () => "group", dragId, overId, place));
      else if (kind === "project") setProjects((a) => reorder(a, projectSib, dragId, overId, place));
      else setChats((a) => reorder(a, chatSib, dragId, overId, place));
    },
  };

  const shown = useMemo(() => {
    const live = visible(projects);
    if (scope.kind === "group") return live.filter((p) => p.groupId === scope.id);
    if (scope.kind === "loose") return live.filter((p) => p.groupId === null);
    return live;
  }, [projects, scope]);

  const railTitle =
    scope.kind === "group"
      ? (groups.find((g) => g.id === scope.id)?.name ?? "分组")
      : scope.kind === "loose"
        ? "没放进分组"
        : "最近项目";

  if (view === "login") {
    return (
      <OnlineLogin
        onDone={() => {
          setAccount("预览账号");
          setView("home");
        }}
      />
    );
  }

  const openProject = () => setNotice("待办：新建项目要接云端文档服务（在线浏览器里一律是放云端的多用户协作项目）。");

  return (
    <div className="ps" data-pc="start-online">
      <TopBar
        collapsed={collapsed}
        onToggleSide={() =>
          setCollapsed((v) => {
            writeSideCollapsed(!v);
            return !v;
          })
        }
        accountName={account}
        onSignOut={() => {
          setAccount(null);
          setView("login");
        }}
        center={
          openChat ? (
            <>
              <button
                type="button"
                className="ps-top-back"
                data-pc="start-chat-back"
                aria-label="回到开始页"
                onClick={() => setChatId(null)}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M15 5l-7 7 7 7" />
                </svg>
              </button>
              <div className="ps-top-title">
                <span className="ps-top-name" data-pc="start-chat-name">{openChat.name}</span>
                <span className="ps-top-where">{whereOf(openChat)}</span>
              </div>
            </>
          ) : null
        }
        right={
          openChat ? (
            <>
              <button
                type="button"
                className="ps-chat-vis"
                data-pc="start-chat-visibility"
                aria-pressed={!shared}
                title="待办：共有 / 私有要由云端文档服务记录并核对权限"
                onClick={() => setShared((v) => !v)}
              >
                {shared ? "共有" : "私有"}
              </button>
              <button
                type="button"
                className="ps-chat-ext-btn"
                data-pc="start-chat-ext-toggle"
                aria-pressed={panel}
                aria-label="右侧拓展栏"
                title="画面、修改前 / 修改后"
                onClick={() => setPanel((v) => !v)}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
                  <rect x="3" y="4.5" width="18" height="15" rx="2" />
                  <path d="M15 4.5v15" />
                </svg>
              </button>
            </>
          ) : (
            <>
              <a
                className="ps-ghost-btn"
                href={typeof location !== "undefined" ? `${location.origin}/account` : "#"}
                target="_blank"
                rel="noopener noreferrer"
              >
                官网账号与项目列表
              </a>
              <button type="button" className="ps-ghost-btn" title="待办：桌面版下载地址在官网">
                下载桌面版
              </button>
            </>
          )
        }
      />

      <div className="ps-body-row">
        <ProjectSidebar
          groups={groups}
          projects={projects}
          chats={chats}
          scope={scope}
          onScope={setScope}
          collapsed={collapsed}
          ops={ops}
          width={sideWidth}
          onWidth={setSideWidth}
          onWidthCommit={(px) => {
            setSideWidth(px);
            writeSideWidth(px);
          }}
          onWidthNudge={(delta) =>
            setSideWidth((w) => {
              const next = clampSideWidth(w + delta);
              writeSideWidth(next);
              return next;
            })
          }
          openChatId={chatId}
          onOpenChat={(chat) => setChatId(chat.id)}
          onCreate={openProject}
          onOpen={(id) => setNotice(`待办：打开项目「${nameOf(id)}」要接云端文档服务，再进编辑器。`)}
        />

        {openChat ? (
          <ChatView
            chat={openChat}
            panel={panel}
            messages={threads[openChat.id] ?? messagesOf(openChat.id)}
            onSend={(t) =>
              setThreads((all) => {
                const list = all[openChat.id] ?? messagesOf(openChat.id);
                const n = list.length;
                return {
                  ...all,
                  [openChat.id]: [
                    ...list,
                    { id: `me-${n}`, from: "me", text: t },
                    { id: `todo-${n}`, from: "agent", text: PENDING_REPLY },
                  ],
                };
              })
            }
          />
        ) : (
          <main className="ps-main">
            <div className="ps-body">
              <div className="ps-hero">
                <span className="ps-hero-kicker">由 PromptCut 的 Agent 驱动</span>
                <h1 className="ps-hero-title">说一句话，先得到一支片子</h1>
                <span className="ps-hero-sub">写下主题或贴进文案，Agent 建好项目、排好卡片，再由你接着剪。</span>
              </div>

              <PromptBox
                onSubmit={(text, ratio) =>
                  setNotice(`已收到：「${text}」（${ratio}）。待办：接 Agent 的生产流程后，这里会直接建项目并进编辑器。`)
                }
              />
              <p className="ps-prompt-note" role="status" data-pc="start-notice">
                {notice || "界面预览阶段：项目是假数据。行上右键可以重命名、置顶、归档、删除，按住能拖着排序，侧栏右边那条缝能拖宽窄。"}
              </p>

              <ProjectRail
                title={railTitle}
                projects={shown}
                resetKey={scopeKeyOf(scope)}
                onCreate={openProject}
                onOpen={(id) => setNotice(`待办：打开项目「${nameOf(id)}」要接云端文档服务，再进编辑器。`)}
              />
            </div>
          </main>
        )}
      </div>
    </div>
  );
}
