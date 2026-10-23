/**
 * 云端 Agent 的 React 接线:谁来用、能不能用(`useCloudAgent`)、这一页的云端对话(`useCloudChat`)、
 * 桌面版在本机模式下看一眼云端有没有在跑的对话(`useCloudDigest`)。
 *
 * 纯逻辑都在同目录的 `cloudApi.ts`、`session.ts`、`events.ts`、`endpoint.ts`(Node 里有单测);这里只做 React 与浏览器存储的接线。
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { getChatStore, useChatMessages, type ChatStore } from "../liveChat";
import { getState } from "../../store/project";
import { useSync, currentDocProjectId } from "../../editor/sync/syncManager";
import { selectionPresenceStatus } from "../../editor/sync/selectionPresence";
import { getTabCreativity, getTabs } from "../agentTabs";
import { getScript } from "../script";
import { mediaCardUrl } from "../mediaRef";
import { cloudAgentVersion, resolveCloudAgent, subscribeCloudAgent, type CloudAgentAvailability } from "./endpoint";
import { cloudIdentityVersion, subscribeCloudIdentity } from "./identity";
import { CloudConsentRequiredError, cloudConsentState, reportCloudConsentRequired, requireCloudConsent, subscribeCloudConsent, type CloudConsentPermit } from "./consent";
import { CloudError, cloudErrorText, createCloudApi, createCloudControlScopeGuard, requireAccountAbortControl, withCloudControlConsent, type CloudApi } from "./cloudApi";
import { createCloudSession, type CloudSession, type CloudSessionView } from "./session";
import { titleOf } from "./events";
import { bubbleAttachments, type CloudAttachmentInfo } from "./attach";
import type { ChatAttachment } from "../types";
import type { CloudChatItem, CloudInfo, CloudSendBody } from "./types";
import { CLOUD_CHAT_TEXT, chatLimitOf, cloudNoticeText } from "./chatTexts";
import { isGuestId } from "../../account/guest";
import { createPoller } from "./poll";
import { chatKey, freshKey, legacyCloudChatId, persistScopeOf, titlesKey } from "./persistKeys";
import { cloudHistoryFor, type CloudHistoryEntry, type CloudHistorySnapshot } from "./historyStore";
import { newPageId, runPageRequest, type PageRequestExec } from "./pageRequests";
import { createAccountPageHandler } from "./accountPage";
import { desktopCollectLocal, desktopCollectUpload } from "./collectLocal";
import { cancelAllCollectDelegations, type CollectBridgeUpload } from "./collectBridge";
import { webHandoff, webOpen } from "../web";
import { requestAgentBrowser, closeAgentBrowser } from "../agentBrowserStore";
import { playbackHandlers } from "../../mcp/handlers/playback";
import { projectHandlers } from "../../mcp/handlers/project";
import { beginAgentTool, endAgentTool } from "../../editor/userEditing";
import { pushToast } from "../../editor/sync/syncManager";
import { OUTBOX_TEXT, baselineFor, createOutbox, createOutboxRunner, isOfflineError, isTransientError, outboxKey, outboxLocalId, outboxVerdict,
  type Outbox, type OutboxAttempt, type OutboxBaseline, type OutboxItem, type OutboxOptions, type OutboxRunner } from "./outbox";

const ONLINE_BUILD = typeof import.meta.env !== "undefined" && import.meta.env.VITE_PC_ONLINE === "1";

/* ---------------- 能不能用 ---------------- */

export interface CloudAgentState extends CloudAgentAvailability {
  /** 此刻连着的共享项目号;没连共享项目是 null */
  projectId: string | null;
  /** 身份接口位被(重新)注入的次数:身份晚于「云端可用」才就绪时,据此重新取一次 */
  identityVersion: number;
  accountMode: boolean;
  accountId: string | null;
}

export function useCloudAgent(): CloudAgentState {
  const shared = useSync((v) => v.shared);
  const ver = useSyncExternalStore(subscribeCloudAgent, cloudAgentVersion, cloudAgentVersion);
  const identityVersion = useSyncExternalStore(subscribeCloudIdentity, cloudIdentityVersion, cloudIdentityVersion);
  const projectId = shared?.projectId ?? (ONLINE_BUILD ? currentDocProjectId() || null : null);
  const where = shared?.where === "hosted";
  const accountMode = ONLINE_BUILD || Boolean(shared?.accountId);
  const accountId = shared?.accountId ?? null;
  return useMemo(
    () => ({ ...resolveCloudAgent({ projectId, hostedWhere: where || ONLINE_BUILD, online: ONLINE_BUILD }), projectId, identityVersion,
      accountMode, accountId }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectId, where, ver, identityVersion, accountMode, accountId],
  );
}

/* ---------------- 小工具 ---------------- */

const lsGet = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
const safeStorage = (): Storage | null => { try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* 存不了就只在这次页面里有效 */ } };

export function newCloudChatId(): string {
  const rand = Math.random().toString(36).slice(2, 6).padEnd(4, "0");
  return `cc-${Date.now().toString(36)}-${rand}`;
}

const CHAT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
function readTitles(projectId: string, accountScope = ""): Record<string, string> {
  try {
    const v = JSON.parse(lsGet(titlesKey(projectId, accountScope)) ?? "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}
function rememberTitle(projectId: string, id: string, title: string, accountScope = "") {
  const t = readTitles(projectId, accountScope);
  if (t[id] === title) return;
  const ids = Object.keys(t);
  if (ids.length > 200) delete t[ids[0]];
  t[id] = title;
  lsSet(titlesKey(projectId, accountScope), JSON.stringify(t));
}

/** 素材库清单(附在每条消息后面,让模型不必先花一轮 list_media);只列库里已有的,用户这一轮传的附件走 `attachments` */
export function mediaLibrary(): unknown[] {
  try {
    return getState().project.media
      .map((m) => ({ m, url: mediaCardUrl(m) }))
      .filter(({ url }) => url)
      .map(({ m, url }) => ({ id: m.id, name: m.name, kind: m.kind, url, library: true, status: "ready", durationSec: m.duration }));
  } catch {
    return [];
  }
}

function pageState() {
  try {
    const s = getState();
    return { t: Number.isFinite(s.t) ? s.t : 0, selection: Array.isArray(s.selection) ? s.selection.slice(0, 200) : [] };
  } catch {
    return undefined;
  }
}

const MODEL_KEY = "pc.cloudModel";
const EFFORT_KEY = "pc.cloudEffort";

/*
 * 反向通道(契约第 28 节):这张页面的页面号(每次打开页面新起一个,只在内存里),与那几个工具在本机的同一份实现。
 * 云端 Agent 只能让**发起这一轮的那张页面**执行;同一位成员别的设备、别的页签开着同一个对话也只是看。
 */
const PAGE_ID = newPageId();
const pageExec: PageRequestExec = {
  seek: (args) => playbackHandlers.seek(args),
  play: () => playbackHandlers.play(),
  pause: () => playbackHandlers.pause(),
  getSelection: () => projectHandlers.getSelection(),
  begin: beginAgentTool,
  end: endAgentTool,
};

/**
 * 账号模式的反向通道:页面号是这张页面在文档服务在场表里的那一个(每次现取);播放头三件用本机同一份实现。
 * 网页接管与采集的代下、登录要本机的浏览器与编辑器进程,只在桌面版给;在线页面如实回「做不了」。不执行读选区(账号模式读全员选区走文档服务)。
 */
const desktopUpload = ONLINE_BUILD ? null : desktopCollectUpload(() => currentDocProjectId() || null);
const collectUpload: CollectBridgeUpload | null = desktopUpload ? {
  ...desktopUpload,
  async cancel(hashes: string[]) {
    if (!hashes?.length) return;
    try {
      await fetch("/api/media/upload-queue/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hashes }),
      });
    } catch { /* 忽略网络错误 */ }
  },
} : null;

const accountPageHandler = createAccountPageHandler({
  pageId: () => selectionPresenceStatus().pageId,
  exec: {
    seek: (args) => playbackHandlers.seek(args),
    play: () => playbackHandlers.play(),
    pause: () => playbackHandlers.pause(),
    begin: beginAgentTool,
    end: endAgentTool,
    ...(ONLINE_BUILD ? {} : {
      // 把云端浏览器当前页的地址交给本机的 Agent 浏览器,再照本机 web_handoff 的做法交给用户(壳模式下点亮「浏览器」页签)
      webHandoff: async (args: { reason?: string; hide?: boolean; url?: string }) => {
        if (args.url && !args.hide) {
          const opened = await webOpen({ url: args.url });
          if (opened && (opened as { ok?: unknown }).ok === false) return opened;
        }
        const r = await webHandoff({ ...(args.reason ? { reason: args.reason } : {}), ...(args.hide ? { hide: true } : {}) });
        if (r && (r as { shell?: boolean }).shell) {
          if (args.hide) closeAgentBrowser();
          else requestAgentBrowser(args.reason ?? "");
        }
        return r;
      },
    }),
  },
  local: ONLINE_BUILD ? null : desktopCollectLocal(),
  upload: collectUpload,
});

export function useCloudApi(url: string | null, projectId: string | null = null): CloudApi {
  return useMemo(() => createCloudApi({ baseUrl: () => url, projectId: () => projectId }), [url, projectId]);
}

/* ---------------- 本机模式下看一眼云端(桌面版) ---------------- */

export interface CloudDigest {
  items: CloudChatItem[];
  /** 云端此刻还在跑的对话 id */
  running: string[];
  loading: boolean;
  refresh: () => Promise<void>;
}

/**
 * 桌面版打开放云端的项目、文档服务连上之后,**一次** `info` 加一次对话列表(契约 7.4、CA-DESK-02):历史列表里「云端」一组与
 * 「云端对话进行中」的提示靠它;之后不再轮询,用户打开历史列表时再刷新一次。没有云端、身份没就绪就什么都不发。
 */
export function useCloudDigest(cloud: CloudAgentState, enabled: boolean): CloudDigest {
  const api = useCloudApi(cloud.url, cloud.projectId);
  const [items, setItems] = useState<CloudChatItem[]>([]);
  const [running, setRunning] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadedKey, setLoadedKey] = useState("");
  const consent = useSyncExternalStore(subscribeCloudConsent, cloudConsentState, cloudConsentState);
  const accountScope = cloud.accountMode ? `${cloud.accountId ?? "none"}:${consent.bindingVersion}` : "";
  const key = cloud.available && cloud.url && cloud.projectId && (!cloud.accountMode ||
    (consent.accepted === true && consent.accountId === cloud.accountId && !!cloud.accountId))
    ? `${cloud.projectId}|${cloud.url}|${cloud.identityVersion}|${accountScope}` : "";
  const keyRef = useRef(key);
  keyRef.current = key;

  const load = useCallback(async (withInfo: boolean) => {
    const k = keyRef.current;
    if (!k) return;
    setLoading(true);
    try {
      const [info, list] = await Promise.all([withInfo ? api.info().catch(() => null) : Promise.resolve(null), api.list().catch(() => null)]);
      if (keyRef.current !== k) return;
      if (list) {
        const titles = readTitles(cloud.projectId ?? "", persistScopeOf(cloud.accountMode, cloud.accountId));
        setItems(list.map((x) => (x.title === "云端对话" && titles[x.id] ? { ...x, title: titles[x.id] } : x)));
        setRunning(list.filter((x) => x.state === "running").map((x) => x.id));
        setLoadedKey(k);
      }
      if (info && info.running.length) setRunning(info.running);
    } finally {
      if (keyRef.current === k) setLoading(false);
    }
  }, [api, cloud.projectId, cloud.accountMode, cloud.accountId]);

  useEffect(() => {
    setItems([]);
    setRunning([]);
    if (!enabled || !key) return;
    void load(true);
  }, [key, enabled, load]);

  const refresh = useCallback(() => load(false), [load]);
  return { items: loadedKey === key ? items : [], running: loadedKey === key ? running : [], loading: loading && !!key, refresh };
}

/* ---------------- 一页云端对话 ---------------- */

export interface CloudChat {
  store: ChatStore;
  messages: ReturnType<typeof useChatMessages>;
  view: CloudSessionView;
  info: CloudInfo | null;
  /** 页面上要给用户看一下的(发送失败、身份没就绪、项目关了开关),用户关掉或下一次操作时清掉 */
  notice: string | null;
  clearNotice: () => void;
  /** 给用户看一句话(「某些附件没带上」之类页面自己的提示) */
  notify: (text: string) => void;
  conversationId: string;
  /** `files`:已经传好的附件(`attach` 回来的那些);其 `url` 随消息带给服务端,名字显示在本页的气泡里。
   *  `staged`:先用 `stage` 放进对话的那条本地气泡;发不出去时它标成「没发出去」 */
  /** `consentPermit`：同一次发送开头 `grantCloudConsent` 发的一次性许可；有效就不再向账号服务读第二次告知。 */
  send: (text: string, files?: ChatAttachment[], staged?: string, consentPermit?: CloudConsentPermit | null,
    opts?: { queueOnNetwork?: boolean }) => Promise<boolean>;
  /** 账号模式:点发送的那一刻先在对话里放一条本地气泡(乐观显示),回它的号;没有会话时回 null */
  stage: (text: string, files?: ChatAttachment[]) => string | null;
  /** 本地气泡在发出之前就被挡下了(没确认告知、对话已切走等):标成没发出去 */
  failStaged: (id: string, reason: string) => void;
  /**
   * 断网待发(outbox.ts,只在 `useCloudChat({ outbox: true })` 时有):
   * `offline()` 浏览器此刻断着网;`mustQueue()` 这个对话里已经有排着的(新发的要排在它后面,顺序不乱);
   * `enqueue` 把点发送时放的那个本地气泡排进去(网络恢复后自动发出);`resend` 不发了的那条按当前状态重新走一遍;
   * `transient(err)` 这个错是不是断网一类(发不出去、但等网络恢复能发)。
   */
  outbox: {
    items: readonly OutboxItem[];
    offline: () => boolean;
    mustQueue: () => boolean;
    enqueue: (text: string, files: ChatAttachment[] | undefined, staged: string) => boolean;
    resend: (localId: string) => void;
    transient: (err: unknown) => boolean;
  };
  dropStaged: (id: string) => void;
  /** 传一个文件到这个对话的工作目录(对话还没发过消息也行);出错抛 `CloudError` */
  attach: (file: File, signal?: AbortSignal) => Promise<CloudAttachmentInfo>;
  abort: (runId?: string, requestId?: string) => Promise<void>;
  switchVisibility: (visibility: "shared" | "private", requestId: string) => Promise<CloudChatItem>;
  newChat: () => void;
  openChat: (id: string) => void;
  /**
   * 删除一个云端对话（账号模式）。requestId 一次删除用同一个：任务还没停稳（agent-fence-pending）时抛错，
   * 界面用同一个请求号重试。成功时如果删的是当前打开的，自动退到一个新对话。
   */
  removeChat: (id: string, requestId: string) => Promise<{ already: boolean }>;
  history: { items: CloudChatItem[]; loading: boolean; refresh: (silent?: boolean, maxAgeMs?: number) => Promise<boolean>;
    /** 这个项目的对话列表读到过（几个分页共用一份，进入项目就开始读；打开分页时通常已经有了） */
    loaded: boolean;
    /** 这位账号在这个项目里自己开的对话数（共有对话算在开它的人名下）；满 `limit` 个就不让新建（账号 50 个，游客 1 个） */
    ownedCount: number; atLimit: boolean;
    /** 这个上限是几个：账号 50，游客 1（`chatLimitOf`） */
    limit: number;
    /** 当前身份是游客：满额时界面不是「删几个再建」，而是「游客每个项目只能开一个对话，注册账号才能多开」，新建入口置灰 */
    guest: boolean };
  revoked?: boolean;
  model: string;
  setModel: (m: string) => void;
  /** 思考强度;空串 = 默认(不带这个参数,随模型自己的默认) */
  effort: string;
  setEffort: (e: string) => void;
}

/**
 * 一页的云端对话。`active` 为假(页签在后台)时流照读;`enabled` 为假(项目没有云端 Agent、或这一页没选「云端」)时什么都不做。
 * `autoAttach`:进入时发现服务端有在跑的对话,就自动打开那个(契约 7.4:重新打开页面自动接上还在跑的对话)。
 */
export function useCloudChat(o: { tabId: string; cloud: CloudAgentState; enabled: boolean; autoAttach: boolean; initialConversation?: string | null;
  /** 开断网待发(只在账号模式下起作用):断网时发的消息排着,网络恢复后自动发出 */
  outbox?: boolean;
  /** 待发的那条真发出去之前对附件做的准备(图片、视频、音频放进素材库,同点发送时那一步) */
  prepareFiles?: (files: ChatAttachment[]) => Promise<ChatAttachment[]>; }): CloudChat {
  const { tabId, cloud, enabled } = o;
  const prepareFilesRef = useRef(o.prepareFiles);
  prepareFilesRef.current = o.prepareFiles;
  const consent = useSyncExternalStore(subscribeCloudConsent, cloudConsentState, cloudConsentState);
  const projectId = cloud.projectId ?? "";
  const accountScope = cloud.accountMode ? `${cloud.accountId ?? "none"}:${consent.bindingVersion}` : "";
  /** 本地存储的键只按账号分(见 persistScopeOf) */
  const persistScope = persistScopeOf(cloud.accountMode, cloud.accountId);
  const storeKey = cloud.accountMode ? `cloud:${tabId}:${projectId}:${accountScope}` : `cloud:${tabId}`;
  const store = useMemo(() => getChatStore(storeKey), [storeKey]);
  const messages = useChatMessages(store);
  const api = useCloudApi(cloud.url, cloud.projectId);
  const key = enabled && cloud.available && cloud.url && projectId && (!cloud.accountMode ||
    (consent.accepted === true && consent.accountId === cloud.accountId && !!cloud.accountId))
    ? `${projectId}|${cloud.url}|${tabId}|${cloud.identityVersion}|${accountScope}` : "";
  const keyRef = useRef(key);
  keyRef.current = key;

  const [info, setInfo] = useState<CloudInfo | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string>(() => (key ? lsGet(chatKey(projectId, tabId, persistScope)) : null) ?? newCloudChatId());
  const [view, setView] = useState<CloudSessionView>({ conversationId: null, streaming: false, connection: "idle", problem: null, lastSeq: 0, revoked: false });
  const [model, setModelState] = useState<string>(() => lsGet(MODEL_KEY) ?? "");
  const [effort, setEffortState] = useState<string>(() => lsGet(EFFORT_KEY) ?? "");
  // 对话列表：同一个项目、同一账号范围在这张页面里只有一份、一个轮询(historyStore.ts)，几个分页共用
  const historyKey = key ? `${projectId}|${cloud.url}|${cloud.identityVersion}|${accountScope}` : "";
  const history: CloudHistoryEntry | null = useMemo(() => (historyKey ? cloudHistoryFor(historyKey, () => ({
    list: () => api.list(), pollMs: cloud.accountMode ? HISTORY_POLL_MS : 0,
    onPollError: (err: unknown) => (authLost(err) ? "stop" as const : undefined) })) : null),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [historyKey]);
  const histSnap = useSyncExternalStore(history?.subscribe ?? noHistorySubscribe, history?.get ?? emptyHistory, history?.get ?? emptyHistory);
  const histItems = useMemo(() => {
    const titles = readTitles(projectId, persistScope);
    return histSnap.items.map((x) => (x.title === "云端对话" && titles[x.id] ? { ...x, title: titles[x.id] } : x));
  }, [histSnap.items, projectId, persistScope]);
  const [histLoading, setHistLoading] = useState(false);
  const sessionRef = useRef<CloudSession | null>(null);
  const pendingSendRef = useRef<{ key: string; conversationId: string; text: string; options: string; requestId: string } | null>(null);
  const sessionKeyRef = useRef("");
  const convRef = useRef(conversationId);
  convRef.current = conversationId;
  const operationScopeGuardRef = useRef(createCloudControlScopeGuard());
  const operationScopeKey = JSON.stringify([key, cloud.accountMode, cloud.accountId, projectId, cloud.url,
    cloud.identityVersion, consent.accountId, consent.bindingVersion, consent.accepted]);
  const operationScope = operationScopeGuardRef.current.update(operationScopeKey, conversationId);
  /** 进入时的那一次「取 info、定对话」还没做完,用户已经自己选了对话(历史列表里点的、新对话):后到的结果不再改写他的选择 */
  const pickedRef = useRef(false);
  const refreshHistoryRef = useRef<(silent?: boolean) => Promise<boolean>>(async () => false);
  /** 自己正在删的对话号：它被删时流上的 conversation.deleted 不再当「别人删了」提示 */
  const selfDeletingRef = useRef<Set<string>>(new Set());
  const onDeletedRef = useRef<(id: string) => void>(() => {});

  // 项目或地址或页签变了:换一个会话控制器。对话 id 取这个项目这一页上次用的
  useEffect(() => {
    if (!key) {
      sessionRef.current?.close();
      sessionRef.current = null;
      sessionKeyRef.current = "";
      if (cloud.accountMode) { store.set([]); setInfo(null); }
      return;
    }
    let dead = false;
    pickedRef.current = false;
    if (cloud.accountMode) { setInfo(null); setNotice(null); }
    const stored = o.initialConversation && CHAT_ID_RE.test(o.initialConversation) ? o.initialConversation : (lsGet(chatKey(projectId, tabId, persistScope)) ?? (cloud.accountMode && cloud.accountId ? legacyCloudChatId(safeStorage(), projectId, tabId, cloud.accountId) : null));
    const first = stored && CHAT_ID_RE.test(stored) ? stored : newCloudChatId();
    // 没有记着的对话 = 这是新建的;记着的那个若正是上次留下的「还没发过消息」的新对话,也算
    const firstFresh = !(stored && CHAT_ID_RE.test(stored)) || lsGet(freshKey(projectId, tabId, persistScope)) === first;
    if (firstFresh) lsSet(freshKey(projectId, tabId, persistScope), first);
    const session = cloud.accountMode
      ? createCloudSession({ api, store, accountMode: true, projectId: () => cloud.projectId, accountId: () => cloud.accountId, pageId: () => selectionPresenceStatus().pageId, onPageRequest: (ev) => accountPageHandler(ev) })
      : createCloudSession({ api, store, accountMode: false, pageId: PAGE_ID, onPageRequest: (ev) => runPageRequest(ev, pageExec) });
    session.setOnConversationDeleted((id) => onDeletedRef.current(id));
    // 账号模式:在场页面号连上文档服务之后才有、重连会变。隔一会儿对一下,变了就让事件流带着新的页面号接着读(不清正文、不显示重连)
    const pageWatch = cloud.accountMode ? setInterval(() => session.syncPage(), 1000) : null;
    sessionRef.current = session;
    sessionKeyRef.current = key;
    const off = session.subscribe(() => setView(session.getView()));
    setView(session.getView());
    setConversationId(first);
    void (async () => {
      let id = first;
      let got: CloudInfo | null = null;
      try {
        got = await api.info();
        if (dead) return;
        setInfo(got);
        if (!got.enabled) setNotice(cloudErrorText("disabled"));
        // 重新打开后自动接上还在跑的对话
        if (o.autoAttach && got.running.length && !got.running.includes(id)) id = got.running[0];
      } catch (err) {
        if (dead) return;
        setNotice(err instanceof CloudError ? err.message : cloudErrorText("network"));
      }
      if (dead || pickedRef.current) return;
      setConversationId(id);
      lsSet(chatKey(projectId, tabId, persistScope), id);
      session.open(id, { fresh: firstFresh && id === first });
      session.showOutbox((outboxRef.current?.items ?? []).map(shownOutboxItem));
    })();
    return () => {
      dead = true;
      off();
      if (pageWatch !== null) clearInterval(pageWatch);
      void cancelAllCollectDelegations();
      session.close();
      if (cloud.accountMode) store.set([]);
      if (sessionRef.current === session) { sessionRef.current = null; sessionKeyRef.current = ""; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // 探针与排障的只读口子:这一页云端对话此刻的消息与会话状态(同 __pcStore、__pcIo 一类的 __pc* 钩子)
  useEffect(() => {
    if (!key) return;
    const w = window as unknown as { __pcCloud?: Record<string, unknown> };
    const hook = { messages: () => store.get(), view: () => sessionRef.current?.getView() ?? null, conversationId: () => convRef.current };
    // 分页 id 改成「项目ID_AgentID」之后,老探针读的 window.__pcCloud.main 落了空:清单里排第一的那一页同时挂在 main 名下
    const alias = tabId === "main" || getTabs()[0]?.id === tabId ? "main" : null;
    w.__pcCloud = { ...(w.__pcCloud ?? {}), [tabId]: hook, ...(alias ? { [alias]: hook } : {}) };
    return () => { if (w.__pcCloud) { delete w.__pcCloud[tabId]; if (alias) delete w.__pcCloud[alias]; } };
  }, [key, tabId, store]);

  // 窗口回到前台、网络恢复:马上重连,不等退避
  useEffect(() => {
    if (!key) return;
    const kick = () => sessionRef.current?.kick();
    const vis = () => { if (document.visibilityState === "visible") kick(); };
    window.addEventListener("online", kick);
    document.addEventListener("visibilitychange", vis);
    return () => {
      window.removeEventListener("online", kick);
      document.removeEventListener("visibilitychange", vis);
    };
  }, [key]);

  // 创建者把开关关了又打开(成员列表通知过来的 `cloud.enabled`):重取一次 info、清掉「已关闭」的提示、把停下的事件流接回去
  const wasEnabled = useRef(cloud.enabled);
  useEffect(() => {
    const before = wasEnabled.current;
    wasEnabled.current = cloud.enabled;
    if (!key || before === cloud.enabled) return;
    if (!cloud.enabled) { setInfo((i) => (i ? { ...i, enabled: false } : i)); return; }
    let dead = false;
    setNotice(null);
    void api.info().then((got) => { if (!dead) setInfo(got); }, () => undefined);
    sessionRef.current?.kick();
    return () => { dead = true; };
  }, [cloud.enabled, key, api]);

  // 会话的问题(身份不对、被拒)也交给界面
  useEffect(() => { if (view.problem) setNotice(view.problem); }, [view.problem]);
  // 记下对话标题,历史列表里没有服务端标题时用
  useEffect(() => {
    if (!projectId || !messages.length) return;
    if (sessionKeyRef.current === key) rememberTitle(projectId, convRef.current, titleOf(messages), persistScope);
  }, [projectId, messages, key, persistScope]);

  /* ---------------- 断网待发(outbox.ts) ---------------- */
  const outboxStoreKey = o.outbox && cloud.accountMode && cloud.accountId && projectId ? outboxKey(cloud.accountId, projectId, tabId) : "";
  const outbox: Outbox | null = useMemo(() => (outboxStoreKey ? createOutbox({ storage: safeStorage(), key: outboxStoreKey }) : null), [outboxStoreKey]);
  const outboxItems = useSyncExternalStore(outbox?.subscribe ?? noHistorySubscribe, () => outbox?.items ?? NO_OUTBOX, () => outbox?.items ?? NO_OUTBOX);
  const outboxRef = useRef(outbox);
  outboxRef.current = outbox;
  const runnerRef = useRef<OutboxRunner | null>(null);
  /**
   * 点发送时放的本地气泡(还在发、没有结果的) → 它的请求号、点发送那一刻看到的最近一条用户消息、点的运行选项。
   * 发着发着断了网、转成排着时用(核对以点发送那一刻看到的为准)。有了结果就撤掉。
   */
  const stagedMetaRef = useRef(new Map<string, { requestId: string; conversationId: string; baseline: OutboxBaseline | null; options: OutboxOptions }>());
  /** 这一刻点的运行选项:节点不认的模型、档位不带(免得整条消息被拒) */
  const runOptions = (): OutboxOptions => ({
    ...(model && (info?.models ?? []).some((m) => m.id === model) ? { model } : {}),
    ...(effort && (info?.efforts ?? []).includes(effort) ? { effort } : {}),
    creativity: getTabCreativity(tabId),
  });
  const optionsKey = (x: OutboxOptions) => JSON.stringify([x.model ?? "", x.effort ?? "", x.creativity ?? ""]);
  /**
   * 现在排一条进这个对话,它「看到的最近一条用户消息」:同一个对话里还在发的本地气泡(最后那条)优先,
   * 其次是这一页排着的,再其次是页面上最近一条已发出的。
   */
  const currentBaseline = (conversationId: string, excludeLocal?: string, excludeRequest?: string): OutboxBaseline | null => {
    let inflight: OutboxBaseline | null = null;
    for (const [id, m] of stagedMetaRef.current) if (id !== excludeLocal && m.conversationId === conversationId) inflight = { requestId: m.requestId };
    if (inflight) return inflight;
    const s = sessionRef.current;
    return baselineFor(outboxRef.current?.items ?? [], conversationId, s && s.conversationId === conversationId ? s.seenBaseline() : null, excludeRequest);
  };
  const buildBody = (text: string, sent: ChatAttachment[], options: OutboxOptions): CloudSendBody => ({
    prompt: text.trim(),
    pageState: pageState(),
    library: mediaLibrary(),
    creativity: options.creativity === undefined ? getTabCreativity(tabId) : options.creativity,
    ...(getScript().trim() ? { script: getScript() } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.effort ? { effort: options.effort } : {}),
    ...(sent.length ? { attachments: sent.map((a) => ({ url: a.url,
      ...(a.inLibrary ? { library: { mediaId: a.inLibrary.mediaId, url: a.inLibrary.url } } : a.libraryError ? { libraryError: a.libraryError } : {}) })) } : {}),
  } as CloudSendBody);
  /** 把点发送时放的那个本地气泡排进待发清单:气泡改写「等网络恢复后发出」,网络恢复后自动发出 */
  const enqueueStaged = (text: string, files: ChatAttachment[] | undefined, staged: string): boolean => {
    const box = outboxRef.current;
    const s = sessionRef.current;
    if (!box || !s?.conversationId || !text.trim()) return false;
    const meta = stagedMetaRef.current.get(staged);
    stagedMetaRef.current.delete(staged);
    const conversationId = meta?.conversationId ?? s.conversationId;
    box.add({ requestId: meta?.requestId ?? crypto.randomUUID(), localId: staged, conversationId, text: text.trim(),
      ...(files?.length ? { attachments: files } : {}), options: meta?.options ?? runOptions(),
      baseline: meta ? meta.baseline : currentBaseline(conversationId, staged), state: "queued", createdAt: Date.now() });
    s.showOutbox(box.items.map(shownOutboxItem));
    setNotice(null);
    void runnerRef.current?.kick();
    return true;
  };

  const send = useCallback(async (text: string, files?: ChatAttachment[], staged?: string, consentPermit?: CloudConsentPermit | null,
    opts?: { queueOnNetwork?: boolean }): Promise<boolean> => {
    const meta = staged ? stagedMetaRef.current.get(staged) : undefined;
    const fail = (reason: string) => { if (staged) { stagedMetaRef.current.delete(staged); sessionRef.current?.failStaged(staged, reason); } return false; };
    // 断网时点的发送(只在开了断网待发、又有本地气泡时):不报错,排着等网络恢复
    const queueOnNetwork = Boolean(opts?.queueOnNetwork && cloud.accountMode && outboxRef.current && staged);
    const queue = () => (enqueueStaged(text, files, staged!) ? true : fail(cloudErrorText("network")));
    if (!text.trim() || view.revoked) return fail(cloudErrorText("forbidden"));
    if (cloud.accountMode) {
      if (!cloud.accountId || !key) return fail(cloudErrorText("unauthorized"));
      if (queueOnNetwork && browserOffline()) return queue();
      // 一次发送只核一次告知：开头新读过、许可当场核对仍有效就不再读；许可作废时这里照旧新读一次
      try { await requireCloudConsent({ accountId: cloud.accountId, bindingVersion: consent.bindingVersion }, consentPermit); }
      catch (err) {
        if (queueOnNetwork && !(err instanceof CloudConsentRequiredError) && isOfflineError(err, browserOffline())) return queue();
        if (err instanceof CloudConsentRequiredError) reportCloudConsentRequired({ accountId: cloud.accountId, bindingVersion: consent.bindingVersion }, tabId);
        const reason = err instanceof Error ? err.message : cloudErrorText("network"); setNotice(reason); return fail(reason);
      }
    }
    const s = sessionRef.current;
    if (!s || !key || keyRef.current !== key || sessionKeyRef.current !== key) return fail("账号、项目或对话已切换。");
    setNotice(null);
    const sent = (files ?? []).filter((a) => !!a.url);
    const body = buildBody(text, sent, meta?.options ?? runOptions());
    if (cloud.accountMode) {
      const presence = selectionPresenceStatus();
      if (!presence.linked || !presence.pageId || presence.unsupported) {
        // 选区没连上多半是和文档服务的连接断了:断着网(或事件流也断着)时当断网排着
        if (queueOnNetwork && !presence.unsupported && (browserOffline() || s.getView().connection !== "live")) return queue();
        setNotice('当前页面选区尚未连接，请稍后重试。'); return fail('当前页面选区尚未连接，请稍后重试。');
      }
      const pending = pendingSendRef.current;
      // 同一条消息重发沿用同一个请求号;换了模型、思考强度或创造力就是另一条请求(文档服务按请求号核内容,同号不同内容会被拒)
      const options = JSON.stringify([body.model ?? "", body.effort ?? "", body.creativity ?? ""]);
      if (meta) pendingSendRef.current = { key, conversationId: s.conversationId!, text: body.prompt, options, requestId: meta.requestId };
      else if (!pending || pending.key !== key || pending.conversationId !== s.conversationId || pending.text !== body.prompt || pending.options !== options)
        pendingSendRef.current = { key, conversationId: s.conversationId!, text: body.prompt, options, requestId: crypto.randomUUID() };
      body.requestId = pendingSendRef.current!.requestId;
      body.selectionSnapshot = { pageId: presence.pageId };
    }
    try {
      await s.send(body, sent.length ? bubbleAttachments(sent) : undefined, staged ? { staged, ...(queueOnNetwork ? { quiet: true } : {}) } : undefined);
      pendingSendRef.current = null;
      if (staged) stagedMetaRef.current.delete(staged);
      if (projectId) lsSet(freshKey(projectId, tabId, persistScope), "");
      return true;
    } catch (err) {
      // 发着发着断了网:不知道云端收没收到,排着;网络恢复后先问服务端,已经到了就不会多一条(同一个请求号)
      if (queueOnNetwork && isOfflineError(err, browserOffline())) return queue();
      if (staged) stagedMetaRef.current.delete(staged);
      if (queueOnNetwork && staged) sessionRef.current?.failStaged(staged, err instanceof CloudError ? err.message : cloudErrorText("network"));
      setNotice(err instanceof CloudError ? err.message : cloudErrorText("network"));
      // 服务端收消息时核告知没通过：弹告知框（文字见 cloudErrorText 的 consent-required）
      if (err instanceof CloudError && err.code === "consent-required" && cloud.accountId)
        reportCloudConsentRequired({ accountId: cloud.accountId, bindingVersion: consent.bindingVersion }, tabId);
      // 满额被拒：列表可能是旧的，重读一次让「已满」的提示和实际对上
      if (err instanceof CloudError && (err.code === "conversation-limit" || err.code === "guest-chat-limit")) void refreshHistoryRef.current();
      return false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId, model, effort, info, cloud.accountMode, cloud.accountId, consent.bindingVersion, key]);

  /**
   * 试发一条排着的(createOutboxRunner 一次只叫一条):告知、选区、**向服务端现问最近一条用户消息**、发送。
   * 连不上的一律 `retry`(留着,退避再试);最近一条变了就 `failed`(不发);别的错也 `failed`,写上原因。
   */
  const attemptRef = useRef<(item: OutboxItem) => Promise<OutboxAttempt>>(async () => ({ kind: "retry" }));
  attemptRef.current = async (item: OutboxItem): Promise<OutboxAttempt> => {
    const retry: OutboxAttempt = { kind: "retry" };
    const failed = (error: string): OutboxAttempt => ({ kind: "failed", error });
    const reason = (err: unknown) => (err instanceof Error && err.message ? err.message : cloudErrorText("network"));
    if (!cloud.accountMode || !cloud.accountId || !key || keyRef.current !== key || sessionKeyRef.current !== key) return retry;
    if (browserOffline()) return retry;
    const binding = { accountId: cloud.accountId, bindingVersion: consent.bindingVersion };
    try { await requireCloudConsent(binding); }
    catch (err) {
      if (err instanceof CloudConsentRequiredError) { reportCloudConsentRequired(binding, tabId); return failed(OUTBOX_TEXT.failed(err.message)); }
      return isTransientError(err, browserOffline()) ? retry : failed(OUTBOX_TEXT.failed(reason(err)));
    }
    const presence = selectionPresenceStatus();
    if (presence.unsupported) return failed(OUTBOX_TEXT.failed("当前页面选区尚未连接，请稍后重试。"));
    if (!presence.linked || !presence.pageId) return retry;
    let messages;
    try { messages = await api.conversationMessages(item.conversationId); }
    catch (err) { return isTransientError(err, browserOffline()) ? retry : failed(OUTBOX_TEXT.failed(reason(err))); }
    if (outboxVerdict(messages, item) === "conflict") return failed(OUTBOX_TEXT.conflict);
    const prepare = prepareFilesRef.current;
    const files = item.attachments?.length ? (prepare ? await prepare(item.attachments) : item.attachments) : [];
    const sent = files.filter((a) => !!a.url);
    const body = buildBody(item.text, sent, item.options);
    body.requestId = item.requestId;
    body.selectionSnapshot = { pageId: presence.pageId };
    const s = sessionRef.current;
    const here = !!s && s.conversationId === item.conversationId && sessionKeyRef.current === key;
    try {
      if (here) await s!.send(body, sent.length ? bubbleAttachments(sent) : undefined, { staged: outboxLocalId(item), quiet: true });
      else await api.send(item.conversationId, body);
    } catch (err) {
      if (err instanceof CloudError && err.code === "consent-required") reportCloudConsentRequired(binding, tabId);
      if (err instanceof CloudError && (err.code === "conversation-limit" || err.code === "guest-chat-limit")) void refreshHistoryRef.current();
      return isTransientError(err, browserOffline()) ? retry : failed(OUTBOX_TEXT.failed(reason(err)));
    }
    if (here && projectId) lsSet(freshKey(projectId, tabId, persistScope), "");
    return { kind: "sent" };
  };

  // 待发清单在、会话在:起一个「什么时候试着发」。网络恢复(online)、页面回到前台、事件流重新连上、刚排了一条就马上试;没发出去按退避再试
  useEffect(() => {
    if (!outbox || !key) return;
    const runner = createOutboxRunner({ outbox, attempt: (item) => attemptRef.current(item), offline: browserOffline });
    runnerRef.current = runner;
    const kick = () => { void runner.kick(); };
    const vis = () => { if (document.visibilityState === "visible") kick(); };
    const onStorage = (ev: StorageEvent) => { if (ev.key === outboxStoreKey) outbox.reload(); };
    window.addEventListener("online", kick);
    document.addEventListener("visibilitychange", vis);
    window.addEventListener("storage", onStorage);
    kick();
    return () => {
      runner.stop();
      window.removeEventListener("online", kick);
      document.removeEventListener("visibilitychange", vis);
      window.removeEventListener("storage", onStorage);
      if (runnerRef.current === runner) runnerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outbox, key]);
  useEffect(() => { if (view.connection === "live") void runnerRef.current?.kick(); }, [view.connection]);
  // 待发的几条画进当前对话(换了对话、重新打开、清单变了都重画)
  useEffect(() => { sessionRef.current?.showOutbox(outboxItems.map(shownOutboxItem)); }, [outboxItems, view.conversationId, key]);

  const attach = useCallback(async (file: File, signal?: AbortSignal): Promise<CloudAttachmentInfo> => {
    if (cloud.accountMode) {
      if (!cloud.accountId || !key) throw new CloudError("unavailable", "云端 Agent 暂时不可用。");
      await requireCloudConsent({ accountId: cloud.accountId, bindingVersion: consent.bindingVersion });
    }
    if (!key || keyRef.current !== key || sessionKeyRef.current !== key) throw new CloudError("unavailable", "云端 Agent 暂时不可用。");
    return api.attach(convRef.current, file, file.name, signal);
  }, [api, cloud.accountMode, cloud.accountId, consent.bindingVersion, key]);

  const abort = useCallback(async (runId?: string, requestId?: string) => {
    const scope = operationScope;
    const expectedConversationId = conversationId;
    const expectedSession = sessionRef.current;
    const current = () => operationScopeGuardRef.current.isCurrent(scope) && keyRef.current === key &&
      sessionKeyRef.current === key && sessionRef.current === expectedSession && convRef.current === expectedConversationId;
    if (!key || !current()) return;
    void cancelAllCollectDelegations();
    const accountControl = cloud.accountMode ? requireAccountAbortControl(runId, requestId) : null;
    try {
      if (accountControl) await api.abort(expectedConversationId, accountControl);
      else await expectedSession?.abort();
    } catch (err) {
      if (current()) setNotice(err instanceof CloudError ? err.message : cloudErrorText("network"));
      if (cloud.accountMode) throw err;
    }
  }, [api, cloud.accountMode, conversationId, key, operationScope]);

  const switchVisibility = useCallback(async (visibility: "shared" | "private", requestId: string) => {
    const scope = operationScope;
    const expectedConversationId = conversationId;
    const expectedSession = sessionRef.current;
    const current = () => operationScopeGuardRef.current.isCurrent(scope) && keyRef.current === key &&
      sessionKeyRef.current === key && sessionRef.current === expectedSession && convRef.current === expectedConversationId &&
      cloudConsentState().accountId === cloud.accountId && cloudConsentState().bindingVersion === consent.bindingVersion;
    if (!cloud.accountMode || !cloud.accountId || !key || !current())
      throw new CloudError("forbidden", "当前账号不能切换这段云端对话的权限。", 403);
    if (visibility === "private") void cancelAllCollectDelegations();
    return withCloudControlConsent(
      () => requireCloudConsent({ accountId: cloud.accountId!, bindingVersion: consent.bindingVersion }),
      current,
      () => api.switchVisibility(expectedConversationId, visibility, requestId),
    );
  }, [api, cloud.accountMode, cloud.accountId, consent.bindingVersion, conversationId, key, operationScope]);

  const switchTo = useCallback((id: string, fresh = false) => {
    if (cloud.accountMode && (!key || keyRef.current !== key || sessionKeyRef.current !== key)) return;
    pickedRef.current = true;
    setConversationId(id);
    if (projectId) { lsSet(chatKey(projectId, tabId, persistScope), id); lsSet(freshKey(projectId, tabId, persistScope), fresh ? id : ""); }
    setNotice(null);
    sessionRef.current?.open(id, { fresh });
    sessionRef.current?.showOutbox((outboxRef.current?.items ?? []).map(shownOutboxItem));
  }, [projectId, tabId, persistScope, cloud.accountMode, key]);

  // 游客每个项目只能开一个对话（2026-10-23 用户定）：上限是几个、已经开了几个。服务端在建对话时也拦（`guest-chat-limit`），
  // 这里先拦下是为了别让游客点了「新对话」、写了一段话，发出去才被拒
  const chatGuest = cloud.accountMode && isGuestId(cloud.accountId);
  const chatLimit = chatLimitOf(cloud.accountId);
  const ownedCount = cloud.accountMode && cloud.accountId ? histItems.filter((x) => x.ownerAccountId === cloud.accountId).length : 0;
  const atLimit = cloud.accountMode && ownedCount >= chatLimit;
  const newChat = useCallback(() => {
    if (chatGuest && atLimit) { setNotice(CLOUD_CHAT_TEXT.guestLimit); return; }
    switchTo(newCloudChatId(), true);
  }, [switchTo, chatGuest, atLimit]);

  /**
   * 读一次对话列表(大家共用的那一份)。`silent`：不闪「读取中」、失败也不弹提示。
   * `maxAgeMs`：这么久以内读回来过就直接用，不再读（换对话、切分页时不必每次都等一个来回）。
   * 结果按项目与账号范围存，换了范围的旧结果不会落到新范围里；回 true 表示此刻这一页的范围没变、列表是新的。
   */
  const refreshHistory = useCallback(async (silent = false, maxAgeMs?: number): Promise<boolean> => {
    const current = () => keyRef.current === key && sessionKeyRef.current === key;
    if (!key || !history || !current()) return false;
    if (!silent) setHistLoading(true);
    try {
      await history.refresh(maxAgeMs !== undefined ? { maxAgeMs } : {});
      return current();
    } catch (err) {
      if (current() && !silent) setNotice(err instanceof CloudError ? err.message : cloudErrorText("network"));
      return false;
    } finally {
      if (current() && !silent) setHistLoading(false);
    }
  }, [key, history]);

  refreshHistoryRef.current = refreshHistory;
  // 对话列表与「我的 N/50」实时更新(2026-10-13 用户定)：别人(或自己的另一页)新建、删除以后，这一页不刷新也跟着变。
  // 后台每 3 秒(HISTORY_POLL_MS)读一次列表，整张页面一个轮询(historyStore.ts，上面 useSyncExternalStore 订阅时起)；
  // 同时只有一次在途、失败退避、登录失效就停、页面不可见就不排(poll.ts)；回到前台和页面里有人删了对话时立刻读一次。
  useEffect(() => {
    if (!history || !cloud.accountMode) return;
    const kick = () => { if (document.visibilityState === "visible") history.kick(); };
    document.addEventListener("visibilitychange", kick);
    window.addEventListener(NOTICES_REFRESH_EVENT, kick);
    return () => { document.removeEventListener("visibilitychange", kick); window.removeEventListener(NOTICES_REFRESH_EVENT, kick); };
  }, [history, cloud.accountMode]);
  const setModel = useCallback((m: string) => { setModelState(m); lsSet(MODEL_KEY, m); }, []);
  const setEffort = useCallback((e: string) => { setEffortState(e); lsSet(EFFORT_KEY, e); }, []);

  // 正在看的对话被删了：退到一个新对话，刷新列表；别人删的才提示（自己删的有自己的反馈）。有关的人另有气泡（useCloudNotices）
  onDeletedRef.current = (id: string) => {
    if (id !== convRef.current) return;
    const mine = selfDeletingRef.current.has(id);
    switchTo(newCloudChatId());
    void refreshHistory();
    window.dispatchEvent(new Event(NOTICES_REFRESH_EVENT));
    if (!mine) setNotice(CLOUD_CHAT_TEXT.currentDeleted);
  };

  const removeChat = useCallback(async (id: string, requestId: string): Promise<{ already: boolean }> => {
    const scope = operationScope;
    const expectedSession = sessionRef.current;
    const current = () => operationScopeGuardRef.current.isCurrent(scope) && keyRef.current === key &&
      sessionKeyRef.current === key && sessionRef.current === expectedSession &&
      cloudConsentState().accountId === cloud.accountId && cloudConsentState().bindingVersion === consent.bindingVersion;
    if (!cloud.accountMode || !cloud.accountId || !key || !current())
      throw new CloudError("forbidden", "账号、项目或对话已切换，请重新读取对话列表后再操作。", 403);
    selfDeletingRef.current.add(id);
    try {
      const out = await withCloudControlConsent(
        () => requireCloudConsent({ accountId: cloud.accountId!, bindingVersion: consent.bindingVersion }),
        current,
        () => api.remove(id, requestId),
      );
      if (id === convRef.current) switchTo(newCloudChatId());
      void refreshHistory();
      window.dispatchEvent(new Event(NOTICES_REFRESH_EVENT));
      return out;
    } finally {
      // 流上的 conversation.deleted 比这里的回包晚一点也没关系：留一小会儿再撤
      setTimeout(() => selfDeletingRef.current.delete(id), 5000);
    }
  }, [api, cloud.accountMode, cloud.accountId, consent.bindingVersion, key, operationScope, switchTo, refreshHistory]);

  const blocked = cloud.accountMode && (!key || keyRef.current !== key || sessionKeyRef.current !== key);
  return {
    store,
    messages: blocked ? [] : messages,
    view: blocked ? { conversationId: null, streaming: false, connection: "idle", problem: null, lastSeq: 0, queue: null, senders: {}, revoked: false } : view,
    info: blocked ? null : info,
    notice,
    clearNotice: () => setNotice(null),
    notify: setNotice,
    conversationId,
    send,
    stage: (text: string, files?: ChatAttachment[]) => {
      const s = sessionRef.current;
      if (!s || !cloud.accountMode || blocked) return null;
      const shown = (files ?? []).filter((a) => !!a.url);
      const conversationId = s.conversationId;
      const options = runOptions();
      // 请求号在点发送时就定:同一条消息重发(上一次没发出去、内容和选项都没变)沿用上一次的
      const pending = pendingSendRef.current;
      const requestId = pending && pending.key === key && pending.conversationId === conversationId && pending.text === text.trim() &&
        pending.options === optionsKey(options) ? pending.requestId : crypto.randomUUID();
      const baseline = conversationId ? currentBaseline(conversationId) : null;
      const id = s.stage(text.trim(), shown.length ? bubbleAttachments(shown) : undefined, requestId);
      if (conversationId) { stagedMetaRef.current.delete(id); stagedMetaRef.current.set(id, { requestId, conversationId, baseline, options }); }
      return id;
    },
    failStaged: (id: string, reason: string) => { stagedMetaRef.current.delete(id); sessionRef.current?.failStaged(id, reason); },
    outbox: {
      items: blocked ? NO_OUTBOX : outboxItems,
      offline: () => Boolean(outboxRef.current) && browserOffline(),
      mustQueue: () => {
        const box = outboxRef.current;
        const conv = sessionRef.current?.conversationId;
        return !!box && !!conv && box.items.some((x) => x.conversationId === conv && x.state !== "failed");
      },
      enqueue: (text: string, files: ChatAttachment[] | undefined, staged: string) => enqueueStaged(text, files, staged),
      resend: (localId: string) => {
        const box = outboxRef.current;
        const s = sessionRef.current;
        const item = box?.items.find((x) => outboxLocalId(x) === localId);
        if (!box || !s || !item || item.state !== "failed") return;
        // 按当前状态重新走一遍:气泡挪到最后(它现在是最新的一条),核对以这一刻页面上看到的最近一条为准
        s.dropStaged(localId);
        box.requeue(item.requestId, currentBaseline(item.conversationId, localId, item.requestId));
        s.showOutbox(box.items.map(shownOutboxItem));
        void runnerRef.current?.kick();
      },
      transient: (err: unknown) => isOfflineError(err, browserOffline()),
    },
    dropStaged: (id: string) => sessionRef.current?.dropStaged(id),
    attach,
    abort,
    switchVisibility,
    newChat,
    openChat: (id: string) => switchTo(id),
    removeChat,
    history: { items: blocked ? [] : histItems, loading: blocked ? false : histLoading, refresh: refreshHistory,
      loaded: blocked ? false : histSnap.loaded,
      ownedCount: blocked ? 0 : ownedCount, atLimit: blocked ? false : atLimit, limit: chatLimit, guest: chatGuest },
    revoked: Boolean(view.revoked),
    model,
    setModel,
    effort,
    setEffort,
  };
}

/* ---------------- 别人删了和你有关的对话：气泡 ---------------- */

/**
 * 服务端明确说登录失效(401)：后台轮询停下来(换了账号、重新登录会换 key 重新起)。刚进页面身份还没就绪时的取票失败、403(Agent 被关、暂时没权限)不算，
 * 那些靠退避(poll.ts)慢慢等。
 */
const authLost = (err: unknown) => err instanceof CloudError && err.status === 401;

const NO_OUTBOX: readonly OutboxItem[] = [];
/** 浏览器说自己断着网 */
const browserOffline = () => typeof navigator !== "undefined" && navigator.onLine === false;
/** 气泡里显示的附件:和点发送时的气泡一样 */
const shownOutboxItem = (x: OutboxItem): OutboxItem => (x.attachments?.length ? { ...x, attachments: bubbleAttachments(x.attachments) } : x);

const emptyHistorySnap: CloudHistorySnapshot = { items: [], loaded: false, loadedAt: 0 };
const emptyHistory = () => emptyHistorySnap;
const noHistorySubscribe = () => () => {};

/** 页面里有人（含自己）刚删了对话时发这个事件，通知钩子立刻再取一次，不等下一次轮询 */
export const NOTICES_REFRESH_EVENT = "pc-cloud-notices-refresh";
/** 已经弹过的通知号（跨组件、跨钩子实例；回执失败时防止同一页反复弹） */
const shownNoticeIds = new Set<string>();
const NOTICES_POLL_MS = 15_000;
/** 对话列表后台刷新的间隔：别人新建、删除后这一页最多晚这么久看到 */
export const HISTORY_POLL_MS = 3_000;

/**
 * 打开项目时取一次、之后每 15 秒和每次窗口回到前台时再取：别人删了你开的对话、或你在里面发过消息的共有对话，
 * 弹一条气泡（点 × 才关），弹完回执；不在线时留着，下次打开项目补弹一次（2026-10-12 用户定）。
 * 只在账号模式下起作用。enabled 为假（没有云端 Agent）时什么都不做。
 */
export function useCloudNotices(cloud: CloudAgentState, enabled: boolean): void {
  const api = useCloudApi(cloud.url, cloud.projectId);
  const key = enabled && cloud.accountMode && cloud.available && cloud.url && cloud.projectId && cloud.accountId
    ? `${cloud.projectId}|${cloud.url}|${cloud.accountId}|${cloud.identityVersion}` : "";
  useEffect(() => {
    if (!key) return;
    // 每个 Agent 分页都挂着这个钩子：同一个项目同一账号整张页面只起一个轮询(按键共用、引用计数)，不按分页数翻倍
    const shared = noticePollers.get(key);
    if (shared) {
      shared.refs++;
      return () => { if (--shared.refs === 0) { shared.stop(); noticePollers.delete(key); } };
    }
    // 同时只有一次在途、失败退避(取不到、回执失败)、登录失效就停、页面不可见就不排(poll.ts)；没回执成功的下次还会给，已弹过的本页不重复弹
    const poller = createPoller({ baseMs: NOTICES_POLL_MS, run: async () => {
      try {
        const items = await api.notices();
        for (const n of items) {
          if (shownNoticeIds.has(n.noticeId)) continue;
          shownNoticeIds.add(n.noticeId);
          pushToast(cloudNoticeText(n), "info", Infinity);
        }
        if (items.length) await api.ackNotices(items.map((n) => n.noticeId));
      } catch (err) { if (authLost(err)) return "stop"; throw err; }
    } });
    const kick = () => { if (document.visibilityState === "visible") poller.kick(); };
    poller.start();
    document.addEventListener("visibilitychange", kick);
    window.addEventListener(NOTICES_REFRESH_EVENT, kick);
    const mine = { refs: 1, stop: () => { poller.stop(); document.removeEventListener("visibilitychange", kick); window.removeEventListener(NOTICES_REFRESH_EVENT, kick); } };
    noticePollers.set(key, mine);
    return () => { if (--mine.refs === 0) { mine.stop(); if (noticePollers.get(key) === mine) noticePollers.delete(key); } };
  }, [api, key]);
}
/** 删除通知的轮询，按键共用(见 useCloudNotices) */
const noticePollers = new Map<string, { refs: number; stop: () => void }>();
