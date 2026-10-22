/**
 * 在线浏览器(电脑身份)的首屏:没登录是登录页,登录了是开始页。
 *
 * 开始页的形状:左边一栏是全部项目(按文件夹收拢),右边从上到下是「说一句话建项目」的输入框和
 * 最近项目那一排缩略图。手机身份走的是另一套界面(`src/mobile/MobileStart.tsx`),这一页只管电脑。
 *
 * **这一版只跑界面**:项目是 `mockProjects.ts` 里的假数据,点新建、点项目、发消息都只在页面上给一行
 * 「待办」,不碰账号服务、文档服务,也不进编辑器。每一处要接什么,写在各自文件的文件头里。
 */
import { useMemo, useState } from "react";
import type { JSX } from "react";
import { OnlineLogin } from "./OnlineLogin";
import { ProjectRail } from "./ProjectRail";
import { ProjectSidebar, scopeKeyOf, type Scope } from "./ProjectSidebar";
import { PromptBox } from "./PromptBox";
import { MOCK_AGENT_CHATS, MOCK_GROUPS, MOCK_PROJECTS } from "./mockProjects";
import "./start.css";

/** 界面预览用的地址参数:`?ui=home` 直接看开始页,`?ui=login` 看登录页。不给用户,只给开发和验收 */
function initialView(): "login" | "home" {
  try {
    return new URLSearchParams(location.search).get("ui") === "home" ? "home" : "login";
  } catch {
    return "login";
  }
}

export function OnlineStart(props: { onEnterEditor: () => void }): JSX.Element {
  // props.onEnterEditor 这一版没用:进编辑器要先有项目,那是业务层的事。签名保持和桌面开始页一致,
  // 免得 `src/StartPage.tsx` 那个三元分支还要分两种 props。
  void props;

  const [view, setView] = useState<"login" | "home">(initialView);
  const [scope, setScope] = useState<Scope>({ kind: "all" });
  const [notice, setNotice] = useState("");
  // `?ui=home` 是直接看开始页的预览入口,这一路没走登录,账号给个占位名,免得侧栏底下显示「未登录」
  const [account, setAccount] = useState<string | null>(() => (initialView() === "home" ? "预览账号" : null));

  // 假数据按最后改动从新到旧;右边那排只给最近的,所以顺序要稳
  const projects = useMemo(
    () => [...MOCK_PROJECTS].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [],
  );

  const shown = useMemo(() => {
    if (scope.kind === "group") return projects.filter((p) => p.groupId === scope.id);
    if (scope.kind === "loose") return projects.filter((p) => p.groupId === null);
    return projects;
  }, [projects, scope]);

  const railTitle =
    scope.kind === "group"
      ? (MOCK_GROUPS.find((g) => g.id === scope.id)?.name ?? "分组")
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

  return (
    <div className="ps" data-pc="start-online">
      <ProjectSidebar
        groups={MOCK_GROUPS}
        projects={projects}
        chats={MOCK_AGENT_CHATS}
        scope={scope}
        onScope={setScope}
        accountName={account}
        onOpenChat={(chat) => setNotice(`待办：打开 Agent 对话「${chat.title}」要接云端 Agent 服务（对话按账号归属，分共有和私有，见 product/agent.md）。`)}
        onCreate={() => setNotice("待办：新建项目要接云端文档服务（在线浏览器里一律是放云端的多用户协作项目）。")}
        onOpen={(id) => setNotice(`待办：打开项目「${projects.find((p) => p.id === id)?.name ?? id}」要接云端文档服务，再进编辑器。`)}
        onSignOut={() => {
          setAccount(null);
          setView("login");
        }}
      />

      <main className="ps-main">
        <div className="ps-topbar">
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
        </div>

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
            {notice || "界面预览阶段：下面的项目是假数据，点哪里都只会在这一行给一句「待办」。"}
          </p>

          <ProjectRail
            title={railTitle}
            projects={shown}
            resetKey={scopeKeyOf(scope)}
            onCreate={() => setNotice("待办：新建项目要接云端文档服务（在线浏览器里一律是放云端的多用户协作项目）。")}
            onOpen={(id) => setNotice(`待办：打开项目「${projects.find((p) => p.id === id)?.name ?? id}」要接云端文档服务，再进编辑器。`)}
          />
        </div>
      </main>
    </div>
  );
}
