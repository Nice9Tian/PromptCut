/**
 * 在线浏览器(电脑身份)的首屏 —— **Vibe 模式**(`user-workflow.md`「工作方式」:在线浏览器登录后的默认界面)。
 * 没登录是登录页,登录了(或以游客身份进来)是开始页;点进项目是这个项目的聊天页。
 *
 * 整页的形状(用户 2026-10-23 定,界面已定稿):
 *
 *   ┌──────────────────────────────────────────────┐
 *   │ 房子 收起 Logo  [对话名]      账号 [共有][拓展栏] │  ← 顶栏,横向贯穿
 *   ├──────────┬───────────────────────────────────┤
 *   │ 侧栏      │ 开始页 / 聊天页(右边可开拓展栏)    │
 *   └──────────┴───────────────────────────────────┘
 *
 * 2026-10-23 接上业务层(`docs/reports/AGENT-claude-vibe-wire.md`),每一块接到哪:
 *   - **登录 / 游客 / 凭链接加入 / 进项目**:`src/account/useAccountProjects.ts`(和原来的开始页 `AccountProjects.tsx`、
 *     手机版 `MobileStart.tsx` 共用同一份)。二级密码、不在名单、申请加入照它现有的处理(`JoinPanel.tsx`)。
 *     进项目时它会调 `onEnterEditor`:这里**不进编辑器**,而是留在这一页、打开这个项目的聊天页;
 *     要自己动手时「进入传统式」(详细编辑头上那颗键)才调上层真正的 `onEnterEditor`(Shell 换成编辑界面,项目已经连着)。
 *   - **左侧项目列表**:真云端项目(我创建的 / 我加入的;游客是本机记着的那一个);分组、置顶、归档、顺序只记在本机(`vibeOrg.ts`)。
 *   - **中间输入框**:说一句话 → 新建云端项目(按选的画幅定尺寸、带上挑好的素材)→ 进它的聊天页 → 这句话作为第一条消息发给云端 Agent。
 *   - **聊天页、右侧拓展栏**:真云端 Agent 对话(`useVibeCloud.ts`)、真画面(`VibeStage.tsx`)、真的修改前 / 修改后。
 *   - **详细编辑**:真舞台、真时间轴,只看不改(`DetailEdit.tsx`)。
 *   - **缩略图**:这台浏览器打开过的项目记下首帧(`thumbCache.ts`),没有就是色块。
 *
 * 手机身份走的是另一套界面(`src/mobile/MobileStart.tsx`),这一页只管电脑。
 * 取不到数据时(没登录、网络断、服务不可用)每一处都写明空态或错误,不显示假数据、不白屏。
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { JSX } from "react";
import { useAccountProjects } from "../account/useAccountProjects";
import { GUEST_LIMITS, GUEST_LIMITS_TEXT } from "../account/guest";
import { currentDocProjectId, forgetSharedResume, useSync } from "../editor/sync/syncManager";
import { importMediaFiles, MEDIA_ACCEPT } from "../editor/left/importAssets";
import { actions } from "../store/project";
import { ChatView } from "./ChatView";
import { JoinPanel } from "./JoinPanel";
import { ProjectRail } from "./ProjectRail";
import { ProjectSidebar, scopeKeyOf, type Scope, type TreeOps } from "./ProjectSidebar";
import { PromptBox } from "./PromptBox";
import { TopBar } from "./TopBar";
import { VibeLogin, type LoginIntent } from "./VibeLogin";
import { EXT_WIDTH, SIDE_WIDTH, clampWidth, readSideCollapsed, readWidth, writeSideCollapsed, writeWidth } from "./sideWidth";
import { removeById, rename, reorder, setArchived, togglePin, visible } from "./treeState";
import { addGroup, loadOrg, mergeChats, mergeProjects, moveProject, saveOrg, withChats, withGroups, withProjects, type CloudEntry, type OrgState } from "./vibeOrg";
import { seenProjects, subscribeSeen } from "./thumbCache";
import { useSeenProject } from "./useSeenProject";
import { useVibeCloud } from "./useVibeCloud";
import { RATIO_SIZE, projectNameFromPrompt } from "./format";
import type { Ratio, VibeChat, VibeGroup, VibeProject } from "./types";
import "./start.css";

/** 编辑器页的根路径:在线构建是 `/editor/` */
const PAGE_BASE = (typeof import.meta.env !== "undefined" && import.meta.env.BASE_URL) || "/";

/** 回开始页:地址从项目直达地址换回 `/editor/`,刷新后留在开始页(同 Shell 的「回到首页」) */
function showHomeAddress() {
  try {
    const url = new URL(location.href);
    url.pathname = PAGE_BASE;
    for (const key of ["project", "token", "linkToken"]) url.searchParams.delete(key);
    history.replaceState(history.state, "", url);
  } catch { /* 改不了地址栏不影响回开始页 */ }
}

/** 同级的键:和 `ProjectSidebar` 里判能不能拖到一起用的是同一套 */
const projectSib = (p: VibeProject) => `project:${p.groupId ?? "loose"}`;
const chatSib = (c: VibeChat) => `chat:p:${c.projectId}`;

/** 开始页上说的那句话:等项目建好、连上、云端 Agent 就绪之后发出去 */
interface PendingPrompt {
  projectId: string;
  text: string;
}

export function OnlineStart(props: { onEnterEditor: () => void }): JSX.Element {
  /**
   * 进了项目(从列表点进去、凭链接加入、新建、直达地址自动进)之后 `useAccountProjects` 调这个:
   * 不进编辑器,在这一页打开这个项目的聊天页。用 ref 转一道,免得进行到一半的异步流程拿着旧的回调
   */
  const entered = useRef<() => void>(() => {});
  const ap = useAccountProjects({ online: true, onEnterEditor: () => entered.current() });
  const shared = useSync((s) => s.shared);
  const blocked = useSync((s) => s.blocked);

  /** 这一页里打开着的项目(已经连上文档服务);null 是没开 */
  const [openId, setOpenId] = useState<string | null>(null);
  /** 打开着的项目显示聊天页(true)还是开始页(点了房子) */
  const [chatPage, setChatPage] = useState(false);
  const [skipped, setSkipped] = useState(false);
  const [scope, setScope] = useState<Scope>({ kind: "all" });
  const [notice, setNotice] = useState("");
  const [sideWidth, setSideWidth] = useState(() => readWidth(SIDE_WIDTH));
  const [extWidth, setExtWidth] = useState(() => readWidth(EXT_WIDTH));
  const [collapsed, setCollapsed] = useState(readSideCollapsed);
  const [panel, setPanel] = useState(false);
  const [join, setJoin] = useState<{ askPassword: boolean } | null>(null);
  const [pending, setPending] = useState<PendingPrompt | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [creating, setCreating] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  // 连着的项目被换掉、断开(被踢、项目没了、退出登录):这一页跟着关掉
  const connectedId = shared?.projectId ?? null;
  useEffect(() => {
    if (openId && connectedId !== openId) { setOpenId(null); setChatPage(false); }
  }, [connectedId, openId]);
  useEffect(() => {
    if (blocked === "kicked") setNotice("你已被移出这个项目。");
    else if (blocked === "removed") setNotice("你已不在这个项目的成员名单中。");
  }, [blocked]);

  /**
   * 进了项目:以同步状态里此刻连着的项目为准(`enterAccountProject` 走完时它已经是这个项目;
   * 进的那一刻 React 还没重渲,`shared` 可能还是旧的,所以现读)。读不到就是没进去,留在开始页
   */
  entered.current = () => {
    const id = currentDocProjectId() || null;
    if (!id) return;
    setOpenId(id);
    setChatPage(true);
    setJoin(null);
    setNotice("");
  };

  const signedIn = !!(ap.account || ap.guest);
  const viewer = ap.account ? `acc:${ap.account.id}` : ap.guest ? `guest:${ap.guest.id}` : null;

  /* ---------------- 本机整理(分组、置顶、归档、顺序) ---------------- */
  const [org, setOrgState] = useState<OrgState>(() => loadOrg(viewer));
  useEffect(() => { setOrgState(loadOrg(viewer)); }, [viewer]);
  const setOrg = (next: (o: OrgState) => OrgState) => setOrgState((o) => { const n = next(o); saveOrg(viewer, n); return n; });

  /* ---------------- 项目清单:云端列表 + 本机整理 + 本机记下的画面 ---------------- */
  const seen = useSyncExternalStore(subscribeSeen, seenProjects, seenProjects);
  const cloudEntries = useMemo<CloudEntry[]>(() => {
    if (ap.guest) return ap.guestProject ? [{ id: ap.guestProject.id, name: ap.guestProject.name, role: "guest" }] : [];
    if (!ap.lists) return [];
    return [
      ...ap.lists.owned.map((p) => ({ id: p.projectId, name: p.name, role: "owned" as const })),
      ...ap.lists.joined.map((p) => ({ id: p.projectId, name: p.name, role: "joined" as const })),
    ];
  }, [ap.guest, ap.guestProject, ap.lists]);
  // 刚连上、列表里还没有的项目(凭链接刚加入、直达地址进的):先按同步状态里的名字列上,列表刷新后以列表为准
  const entries = useMemo(() => {
    if (!openId || cloudEntries.some((c) => c.id === openId)) return cloudEntries;
    return [{ id: openId, name: shared?.name || "云端项目", role: shared?.creator ? ("owned" as const) : ("joined" as const) }, ...cloudEntries];
  }, [cloudEntries, openId, shared?.name, shared?.creator]);
  const projects = useMemo(() => mergeProjects(org, entries, seen), [org, entries, seen]);
  const groups = org.groups;

  /* ---------------- 打开着的项目的云端 Agent ---------------- */
  const vibe = useVibeCloud({ connected: !!openId && connectedId === openId, shown: chatPage });
  useSeenProject(openId && connectedId === openId ? openId : null);
  const chats = useMemo(() => (openId ? mergeChats(org, openId, vibe.chats) : []), [org, openId, vibe.chats]);
  // 聊天页正看着的那条对话。云端对话列表还没读回来(告知还没确认、刚连上)时先当一条新对话显示,告知框就在聊天页上弹
  const openChat: VibeChat | null = chatPage && openId
    ? (chats.find((c) => c.id === vibe.chat.conversationId) ?? vibe.current ??
      { id: vibe.chat.conversationId || "pending", name: "新对话", projectId: openId, state: "idle", visibility: "shared", readOnly: false, fresh: true })
    : null;

  /* ---------------- 动作 ---------------- */
  const failText = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

  /** 点进一个项目。已经连着就直接回它的聊天页;设了二级密码而还没输过:打开「用链接加入」要密码 */
  const openProject = (id: string) => {
    if (!signedIn) { setNotice("先登录账号或以游客身份进入。"); return; }
    if (openId === id && connectedId === id) { setChatPage(true); return; }
    const p = projects.find((x) => x.id === id);
    setNotice("");
    void ap.perform(async () => {
      if (p?.role === "guest") { await ap.openGuestProject(); return; }
      if (await ap.open(id, p?.name ?? "云端项目") === "secondary-required") setJoin({ askPassword: true });
    });
  };

  const createBlocked = !signedIn ? "先登录账号或以游客身份进入，才能新建云端项目。"
    : ap.guest && ap.guestProject ? `游客只能建 ${GUEST_LIMITS.projects} 个项目。要建更多，请注册一个账号。`
    : null;

  /** 新建一个空白云端项目并进去(侧栏「新建项目」、缩略图第一格) */
  const createBlank = () => {
    if (createBlocked) { setNotice(createBlocked); return; }
    void ap.perform(() => ap.create("未命名"));
  };

  /** 开始页说一句话:建项目 → 定画幅 → 传素材 → 进聊天页 → 这句话发给云端 Agent */
  const submitPrompt = async (text: string, ratio: Ratio) => {
    if (createBlocked) { setNotice(createBlocked); return; }
    setCreating(true);
    setNotice("正在新建项目…");
    const picked = files;
    try {
      await ap.perform(async () => {
        await ap.create(projectNameFromPrompt(text));
        const id = currentDocProjectId() || null;
        if (!id) throw new Error("项目建好了，但没能打开它。请在左边的项目列表里点它。");
        if (ratio !== "16:9") actions.setProjectMeta({ ...RATIO_SIZE[ratio] });
        if (picked.length) {
          const r = await importMediaFiles(picked);
          const n = r.counts.video + r.counts.audio + r.counts.image;
          setNotice(n ? `已把 ${n} 个素材放进项目。` : (r.rejected[0] ?? "挑的文件里没有能导入的素材。"));
        } else setNotice("");
        setFiles([]);
        setPending({ projectId: id, text });
      });
    } finally {
      setCreating(false);
    }
  };

  const signOut = () => {
    // 先离开连着的项目(不再用这个身份连文档服务),再退出账号或丢掉游客身份
    forgetSharedResume();
    setOpenId(null);
    setChatPage(false);
    setPending(null);
    showHomeAddress();
    if (ap.guest) ap.leaveGuest();
    else void ap.perform(ap.logout);
    setSkipped(false);
  };

  const onIntent = (it: LoginIntent) => {
    if (it.link) ap.setLink(it.link);
    if (it.kind === "skip") { setSkipped(true); return; }
    void ap.perform(async () => {
      if (it.kind === "guest") await ap.enterAsGuest();
      else await ap.login(it.name, it.password, it.remember);
      if (it.link) setJoin({ askPassword: false });
    });
  };

  // 页面是从分享链接打开的(链接里带令牌):登录后把「用链接加入」打开、链接已填好
  const linkedOnce = useRef(false);
  useEffect(() => {
    if (linkedOnce.current || !signedIn || !ap.link || openId) return;
    linkedOnce.current = true;
    try { if (new URL(location.href).searchParams.has("token") || /\/s\//.test(location.pathname)) setJoin({ askPassword: false }); } catch { /* 读不了地址就不自动开 */ }
  }, [signedIn, ap.link, openId]);
  // 从直达地址自动进项目时要先输二级密码
  useEffect(() => {
    if (!ap.directSecondary) return;
    setJoin({ askPassword: true });
    ap.clearDirectSecondary();
  }, [ap.directSecondary]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------------- 侧栏的改动 ---------------- */
  const writeProjects = (f: (list: VibeProject[]) => VibeProject[]) => setOrg((o) => withProjects(o, f(mergeProjects(o, entries, seen))));
  const writeGroups = (f: (list: VibeGroup[]) => VibeGroup[]) => setOrg((o) => withGroups(o, f(o.groups)));
  const writeChats = (f: (list: VibeChat[]) => VibeChat[]) => { if (openId) setOrg((o) => withChats(o, openId, f(mergeChats(o, openId, vibe.chats)))); };
  const archivedNow = (kind: "group" | "project" | "chat", id: string) =>
    kind === "group" ? !!groups.find((g) => g.id === id)?.archived : kind === "project" ? !!projects.find((p) => p.id === id)?.archived : !!chats.find((c) => c.id === id)?.archived;

  const ops: TreeOps = {
    rename: (kind, id, name) => {
      if (kind === "group") writeGroups((a) => rename(a, id, name));
    },
    pin: (kind, id) => {
      if (kind === "group") writeGroups((a) => togglePin(a, id));
      else if (kind === "project") writeProjects((a) => togglePin(a, id));
      else writeChats((a) => togglePin(a, id));
      setNotice("置顶只在自己同级里生效，并且只记在这台浏览器里。");
    },
    archive: (kind, id) => {
      const next = !archivedNow(kind, id);
      if (kind === "group") writeGroups((a) => setArchived(a, id, next));
      else if (kind === "project") writeProjects((a) => setArchived(a, id, next));
      else writeChats((a) => setArchived(a, id, next));
      setNotice(next ? "已归档：收进侧栏最下面「已归档」，那里右键能取消归档。只记在这台浏览器里，项目本身不受影响。" : "已取消归档。");
    },
    remove: (kind, id) => {
      if (kind === "group") {
        const g = groups.find((x) => x.id === id);
        if (g && confirm(`删除分组「${g.name}」？里面的项目会放回「项目」，项目本身不删。`)) writeGroups((a) => removeById(a, id));
        return;
      }
      if (kind === "chat") {
        const c = chats.find((x) => x.id === id);
        if (!c || c.fresh) return;
        if (!confirm(`删除对话「${c.name}」？删除后不能恢复。${c.state === "running" ? "对话里还有任务在跑，会先停下；已经落地的修改保留。" : ""}`)) return;
        void vibe.chat.removeChat(id, crypto.randomUUID()).then(
          () => setNotice(`已删除对话「${c.name}」。`),
          (e) => setNotice(failText(e, "删除对话没有成功，可以再试一次。")),
        );
      }
    },
    reorder: (kind, dragId, overId, place) => {
      if (kind === "group") writeGroups((a) => reorder(a, () => "group", dragId, overId, place));
      else if (kind === "project") writeProjects((a) => reorder(a, projectSib, dragId, overId, place));
      else writeChats((a) => reorder(a, chatSib, dragId, overId, place));
    },
    move: (projectId, groupId) => setOrg((o) => moveProject(withProjects(o, mergeProjects(o, entries, seen)), projectId, groupId)),
    blocked: (kind, id) => {
      if (kind === "group") return {};
      if (kind === "project") return { rename: "这一版还不能在这里改云端项目的名字。", remove: "这一版不能在这里删除云端项目。" };
      const c = chats.find((x) => x.id === id);
      return {
        rename: "云端对话这一版没有改名入口。",
        remove: c?.fresh ? "还没发过消息的新对话不用删。" : undefined,
      };
    },
  };

  /* ---------------- 右边那一排 ---------------- */
  const shown = useMemo(() => {
    const live = visible(projects);
    if (scope.kind === "group") return live.filter((p) => p.groupId === scope.id);
    if (scope.kind === "loose") return live.filter((p) => p.groupId === null);
    return live;
  }, [projects, scope]);
  const railTitle = scope.kind === "group" ? (groups.find((g) => g.id === scope.id)?.name ?? "分组") : scope.kind === "loose" ? "没放进分组" : "最近项目";

  const listNotice = !signedIn
    ? <>还没登录：登录账号或以游客身份进入后，这里列出你的云端项目。<button type="button" className="ps-link" data-pc="start-go-login" onClick={() => setSkipped(false)}>去登录</button></>
    : ap.guest ? (ap.guestProject ? null : "游客自己能建 1 个项目，建好之后列在这里。")
    : ap.listError ? <>{ap.listError}<button type="button" className="ps-link" data-pc="start-list-retry" disabled={ap.busy} onClick={() => void ap.refreshLists()}>重试</button></>
    : !ap.lists ? "正在取项目列表…"
    : ap.lists.owned.length + ap.lists.joined.length === 0 ? "你还没有云端项目：在中间说一句话，或点「新建项目」。"
    : null;
  const railEmpty = !signedIn ? "登录之后，这里显示你最近的云端项目。"
    : ap.listError ? `项目列表暂时取不到：${ap.listError}`
    : !ap.lists && !ap.guest ? "正在取项目列表…"
    : undefined;

  /* ---------------- 登录页 ---------------- */
  const restoring = ap.busy && !signedIn && !ap.error && !skipped;
  if (!signedIn && !skipped) {
    if (restoring && !ap.account) {
      // 刚打开页面:先看看官网是不是已经登录了(和官网共用登录),问完之前不闪登录页
      return (
        <div className="ps-vibe-loading" data-pc="start-restoring" role="status">
          <span className="ps-muted">正在连接账号服务…</span>
        </div>
      );
    }
    if (ap.shellOld) return <div className="ps-vibe-loading" role="alert"><span>{ap.error || "账号入口暂时不可用。"}</span></div>;
    return <VibeLogin busy={ap.busy} error={ap.error} onIntent={onIntent} />;
  }

  const accountName = ap.account?.name ?? ap.guest?.name ?? null;
  const errorLine = ap.error || notice;

  return (
    <div className="ps" data-pc="start-online" data-signed-in={signedIn || undefined} data-guest={ap.guest ? "1" : undefined}>
      <TopBar
        atHome={!openChat}
        onHome={() => {
          setChatPage(false);
          setJoin(null);
          showHomeAddress();
          // 「全部项目」那一块归了档,回到「全部」就靠这颗房子(见 ProjectSidebar.tsx 的 SHOW_SCOPE_ROWS)
          setScope({ kind: "all" });
        }}
        collapsed={collapsed}
        onToggleSide={() =>
          setCollapsed((v) => {
            writeSideCollapsed(!v);
            return !v;
          })
        }
        accountName={accountName}
        onSignOut={signOut}
        center={
          openChat ? (
            <div className="ps-top-title">
              <span className="ps-top-name" data-pc="start-chat-name">{openChat.name}</span>
              <span className="ps-top-where">项目「{projects.find((p) => p.id === openChat.projectId)?.name ?? shared?.name ?? ""}」</span>
            </div>
          ) : null
        }
        right={
          openChat ? (
            <>
              <button
                type="button"
                className="ps-chat-vis"
                data-pc="start-chat-visibility"
                aria-pressed={openChat.visibility === "private"}
                disabled={!vibe.canSwitchVisibility}
                title={vibe.canSwitchVisibility ? "只有开这个对话的人能在共有和私有之间切换" : openChat.fresh ? "新对话默认共有；发过第一条消息之后能切成私有" : "只有开这个对话的人能在共有和私有之间切换"}
                onClick={() => void vibe.toggleVisibility()}
              >
                {openChat.visibility === "private" ? "私有" : "共有"}
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
              <button type="button" className="ps-ghost-btn" data-pc="start-join-open" onClick={() => setJoin((j) => (j ? null : { askPassword: false }))}>
                用链接加入项目
              </button>
              <a className="ps-ghost-btn" href={typeof location !== "undefined" ? `${location.origin}/account` : "#"} target="_blank" rel="noopener noreferrer">
                官网账号与项目列表
              </a>
              <a className="ps-ghost-btn" href={typeof location !== "undefined" ? `${location.origin}/` : "#"} target="_blank" rel="noopener noreferrer" title="桌面版在官网下载">
                下载桌面版
              </a>
            </>
          )
        }
      />

      {join && (
        <JoinPanel
          ap={ap}
          askPassword={join.askPassword}
          onClose={() => setJoin(null)}
          onJoined={() => setJoin(null)}
        />
      )}

      <div className="ps-body-row">
        <ProjectSidebar
          groups={groups}
          projects={projects}
          chats={chats}
          connectedId={openId && connectedId === openId ? openId : null}
          scope={scope}
          onScope={setScope}
          collapsed={collapsed}
          ops={ops}
          width={sideWidth}
          onWidth={setSideWidth}
          onWidthCommit={(px) => {
            setSideWidth(px);
            writeWidth(SIDE_WIDTH, px);
          }}
          onWidthNudge={(delta) =>
            setSideWidth((w) => {
              const next = clampWidth(SIDE_WIDTH, w + delta);
              writeWidth(SIDE_WIDTH, next);
              return next;
            })
          }
          openChatId={openChat?.id ?? null}
          onOpenChat={(chat) => {
            if (chat.id !== vibe.chat.conversationId) vibe.chat.openChat(chat.id);
            setChatPage(true);
          }}
          onNewChat={(projectId) => {
            if (projectId !== openId) { openProject(projectId); return; }
            if (vibe.chat.history.atLimit) { setNotice(`这个项目里你已经有 ${vibe.chat.history.ownedCount} 个云端对话，满了不能再新建。删掉几个再试。`); return; }
            vibe.chat.newChat();
            setChatPage(true);
          }}
          onNewGroup={() => {
            const name = prompt("新分组叫什么？（分组只记在这台浏览器里）", "新分组");
            if (name === null) return;
            setOrg((o) => addGroup(o, name).org);
          }}
          onCreate={createBlank}
          createBlocked={createBlocked}
          onOpen={openProject}
          notice={listNotice}
        />

        {openChat ? (
          <ChatView
            vibe={vibe}
            title={openChat.name}
            pending={pending && pending.projectId === openId ? pending.text : null}
            onPendingSent={() => setPending(null)}
            panel={panel}
            onPro={props.onEnterEditor}
            ext={{
              width: extWidth,
              onWidth: setExtWidth,
              onWidthCommit: (px) => {
                setExtWidth(px);
                writeWidth(EXT_WIDTH, px);
              },
              onWidthNudge: (delta) =>
                setExtWidth((w) => {
                  const next = clampWidth(EXT_WIDTH, w + delta);
                  writeWidth(EXT_WIDTH, next);
                  return next;
                }),
            }}
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
                onSubmit={(text, ratio) => void submitPrompt(text, ratio)}
                onUpload={() => {
                  if (createBlocked) { setNotice(createBlocked); return; }
                  fileInput.current?.click();
                }}
                fileCount={files.length}
                disabled={createBlocked}
                busy={creating || ap.busy}
              />
              <input ref={fileInput} type="file" multiple accept={MEDIA_ACCEPT} hidden data-pc="start-prompt-files"
                onChange={(e) => {
                  const list = e.target.files ? [...e.target.files] : [];
                  e.target.value = "";
                  if (list.length) { setFiles((f) => [...f, ...list]); setNotice(`已挑 ${files.length + list.length} 个素材，发出这句话时一起放进新项目。`); }
                }} />
              <p className={`ps-prompt-note${ap.error ? " is-err" : ""}`} role={ap.error ? "alert" : "status"} data-pc="start-notice">
                {errorLine || (ap.guest ? GUEST_LIMITS_TEXT : openId && !chatPage ? "项目还开着：点左边它底下的对话回去接着聊。" : "行上右键可以置顶、归档、放进分组（只记在这台浏览器里），按住能拖着排序，侧栏右边那条缝能拖宽窄。")}
              </p>

              <ProjectRail
                title={railTitle}
                projects={shown}
                resetKey={scopeKeyOf(scope)}
                onCreate={createBlank}
                createDisabled={createBlocked}
                onOpen={openProject}
                empty={railEmpty}
              />
            </div>
          </main>
        )}
      </div>
    </div>
  );
}
