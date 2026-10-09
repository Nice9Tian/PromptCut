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
import { getTabCreativity } from "../agentTabs";
import { getScript } from "../script";
import { mediaCardUrl } from "../mediaRef";
import { cloudAgentVersion, resolveCloudAgent, subscribeCloudAgent, type CloudAgentAvailability } from "./endpoint";
import { cloudIdentityVersion, subscribeCloudIdentity } from "./identity";
import { cloudConsentState, requireCloudConsent, subscribeCloudConsent } from "./consent";
import { CloudError, cloudErrorText, createCloudApi, createCloudControlScopeGuard, requireAccountAbortControl, withCloudControlConsent, type CloudApi } from "./cloudApi";
import { createCloudSession, type CloudSession, type CloudSessionView } from "./session";
import { titleOf } from "./events";
import { bubbleAttachments, type CloudAttachmentInfo } from "./attach";
import type { ChatAttachment } from "../types";
import type { CloudChatItem, CloudInfo, CloudSendBody } from "./types";
import { newPageId, runPageRequest, type PageRequestExec } from "./pageRequests";
import { playbackHandlers } from "../../mcp/handlers/playback";
import { projectHandlers } from "../../mcp/handlers/project";
import { beginAgentTool, endAgentTool } from "../../editor/userEditing";

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
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* 存不了就只在这次页面里有效 */ } };

export function newCloudChatId(): string {
  const rand = Math.random().toString(36).slice(2, 6).padEnd(4, "0");
  return `cc-${Date.now().toString(36)}-${rand}`;
}

const CHAT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const chatKey = (projectId: string, tabId: string, accountScope = "") => accountScope
  ? `pc.cloudChat:${accountScope}:${projectId}:${tabId}` : `pc.cloudChat:${projectId}:${tabId}`;
const titlesKey = (projectId: string, accountScope = "") => accountScope
  ? `pc.cloudTitles:${accountScope}:${projectId}` : `pc.cloudTitles:${projectId}`;

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
        const titles = readTitles(cloud.projectId ?? "", accountScope);
        setItems(list.map((x) => (x.title === "云端对话" && titles[x.id] ? { ...x, title: titles[x.id] } : x)));
        setRunning(list.filter((x) => x.state === "running").map((x) => x.id));
        setLoadedKey(k);
      }
      if (info && info.running.length) setRunning(info.running);
    } finally {
      if (keyRef.current === k) setLoading(false);
    }
  }, [api, cloud.projectId, accountScope]);

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
  /** `files`:已经传好的附件(`attach` 回来的那些);其 `url` 随消息带给服务端,名字显示在本页的气泡里 */
  send: (text: string, files?: ChatAttachment[]) => Promise<boolean>;
  /** 传一个文件到这个对话的工作目录(对话还没发过消息也行);出错抛 `CloudError` */
  attach: (file: File, signal?: AbortSignal) => Promise<CloudAttachmentInfo>;
  abort: (runId?: string, requestId?: string) => Promise<void>;
  switchVisibility: (visibility: "shared" | "private", requestId: string) => Promise<CloudChatItem>;
  newChat: () => void;
  openChat: (id: string) => void;
  history: { items: CloudChatItem[]; loading: boolean; refresh: () => Promise<boolean> };
  model: string;
  setModel: (m: string) => void;
}

/**
 * 一页的云端对话。`active` 为假(页签在后台)时流照读;`enabled` 为假(项目没有云端 Agent、或这一页没选「云端」)时什么都不做。
 * `autoAttach`:进入时发现服务端有在跑的对话,就自动打开那个(契约 7.4:重新打开页面自动接上还在跑的对话)。
 */
export function useCloudChat(o: { tabId: string; cloud: CloudAgentState; enabled: boolean; autoAttach: boolean; initialConversation?: string | null }): CloudChat {
  const { tabId, cloud, enabled } = o;
  const consent = useSyncExternalStore(subscribeCloudConsent, cloudConsentState, cloudConsentState);
  const projectId = cloud.projectId ?? "";
  const accountScope = cloud.accountMode ? `${cloud.accountId ?? "none"}:${consent.bindingVersion}` : "";
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
  const [conversationId, setConversationId] = useState<string>(() => (key ? lsGet(chatKey(projectId, tabId, accountScope)) : null) ?? newCloudChatId());
  const [view, setView] = useState<CloudSessionView>({ conversationId: null, streaming: false, connection: "idle", problem: null, lastSeq: 0 });
  const [model, setModelState] = useState<string>(() => lsGet(MODEL_KEY) ?? "");
  const [histItems, setHistItems] = useState<CloudChatItem[]>([]);
  const [histLoading, setHistLoading] = useState(false);
  const sessionRef = useRef<CloudSession | null>(null);
  const pendingSendRef = useRef<{ key: string; conversationId: string; text: string; requestId: string } | null>(null);
  const sessionKeyRef = useRef("");
  const convRef = useRef(conversationId);
  convRef.current = conversationId;
  const operationScopeGuardRef = useRef(createCloudControlScopeGuard());
  const operationScopeKey = JSON.stringify([key, cloud.accountMode, cloud.accountId, projectId, cloud.url,
    cloud.identityVersion, consent.accountId, consent.bindingVersion, consent.accepted]);
  const operationScope = operationScopeGuardRef.current.update(operationScopeKey, conversationId);
  /** 进入时的那一次「取 info、定对话」还没做完,用户已经自己选了对话(历史列表里点的、新对话):后到的结果不再改写他的选择 */
  const pickedRef = useRef(false);

  // 项目或地址或页签变了:换一个会话控制器。对话 id 取这个项目这一页上次用的
  useEffect(() => {
    if (!key) {
      sessionRef.current?.close();
      sessionRef.current = null;
      sessionKeyRef.current = "";
      if (cloud.accountMode) { store.set([]); setInfo(null); setHistItems([]); }
      return;
    }
    let dead = false;
    pickedRef.current = false;
    if (cloud.accountMode) { setInfo(null); setHistItems([]); setNotice(null); }
    const stored = o.initialConversation && CHAT_ID_RE.test(o.initialConversation) ? o.initialConversation : lsGet(chatKey(projectId, tabId, accountScope));
    const first = stored && CHAT_ID_RE.test(stored) ? stored : newCloudChatId();
    const session = createCloudSession({ api, store, accountMode: cloud.accountMode, pageId: PAGE_ID, onPageRequest: (ev) => runPageRequest(ev, pageExec) });
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
      lsSet(chatKey(projectId, tabId, accountScope), id);
      session.open(id);
    })();
    return () => {
      dead = true;
      off();
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
    w.__pcCloud = { ...(w.__pcCloud ?? {}), [tabId]: { messages: () => store.get(), view: () => sessionRef.current?.getView() ?? null, conversationId: () => convRef.current } };
    return () => { if (w.__pcCloud) delete w.__pcCloud[tabId]; };
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
    if (sessionKeyRef.current === key) rememberTitle(projectId, convRef.current, titleOf(messages), accountScope);
  }, [projectId, messages, key, accountScope]);

  const send = useCallback(async (text: string, files?: ChatAttachment[]): Promise<boolean> => {
    if (!text.trim()) return false;
    if (cloud.accountMode) {
      if (!cloud.accountId || !key) return false;
      try { await requireCloudConsent({ accountId: cloud.accountId, bindingVersion: consent.bindingVersion }); }
      catch (err) { setNotice(err instanceof Error ? err.message : cloudErrorText("network")); return false; }
    }
    const s = sessionRef.current;
    if (!s || !key || keyRef.current !== key || sessionKeyRef.current !== key) return false;
    setNotice(null);
    const sent = (files ?? []).filter((a) => !!a.url);
    const body: CloudSendBody = {
      prompt: text.trim(),
      pageState: pageState(),
      library: mediaLibrary(),
      creativity: getTabCreativity(tabId),
      ...(getScript().trim() ? { script: getScript() } : {}),
      ...(model ? { model } : {}),
      ...(sent.length ? { attachments: sent.map((a) => ({ url: a.url })) } : {}),
    };
    if (cloud.accountMode) {
      const presence = selectionPresenceStatus();
      if (!presence.linked || !presence.pageId || presence.unsupported) { setNotice('当前页面选区尚未连接，请稍后重试。'); return false; }
      const pending = pendingSendRef.current;
      if (!pending || pending.key !== key || pending.conversationId !== s.conversationId || pending.text !== body.prompt)
        pendingSendRef.current = { key, conversationId: s.conversationId!, text: body.prompt, requestId: crypto.randomUUID() };
      body.requestId = pendingSendRef.current!.requestId;
      body.selectionSnapshot = { pageId: presence.pageId };
    }
    try {
      await s.send(body, sent.length ? bubbleAttachments(sent) : undefined);
      pendingSendRef.current = null;
      return true;
    } catch (err) {
      setNotice(err instanceof CloudError ? err.message : cloudErrorText("network"));
      return false;
    }
  }, [tabId, model, cloud.accountMode, cloud.accountId, consent.bindingVersion, key]);

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
    return withCloudControlConsent(
      () => requireCloudConsent({ accountId: cloud.accountId!, bindingVersion: consent.bindingVersion }),
      current,
      () => api.switchVisibility(expectedConversationId, visibility, requestId),
    );
  }, [api, cloud.accountMode, cloud.accountId, consent.bindingVersion, conversationId, key, operationScope]);

  const switchTo = useCallback((id: string) => {
    if (cloud.accountMode && (!key || keyRef.current !== key || sessionKeyRef.current !== key)) return;
    pickedRef.current = true;
    setConversationId(id);
    if (projectId) lsSet(chatKey(projectId, tabId, accountScope), id);
    setNotice(null);
    sessionRef.current?.open(id);
  }, [projectId, tabId, accountScope, cloud.accountMode, key]);

  const newChat = useCallback(() => switchTo(newCloudChatId()), [switchTo]);

  const refreshHistory = useCallback(async (): Promise<boolean> => {
    const scope = operationScope;
    const expectedConversationId = conversationId;
    const expectedSession = sessionRef.current;
    const current = () => operationScopeGuardRef.current.isCurrent(scope) && keyRef.current === key &&
      sessionKeyRef.current === key && sessionRef.current === expectedSession && convRef.current === expectedConversationId;
    if (!key || !current()) return false;
    setHistLoading(true);
    try {
      const list = await api.list();
      if (!current()) return false;
      const titles = readTitles(projectId, accountScope);
      setHistItems(list.map((x) => (x.title === "云端对话" && titles[x.id] ? { ...x, title: titles[x.id] } : x)));
      return true;
    } catch (err) {
      if (current()) setNotice(err instanceof CloudError ? err.message : cloudErrorText("network"));
      return false;
    } finally {
      if (current()) setHistLoading(false);
    }
  }, [api, key, projectId, accountScope, conversationId, operationScope]);

  const setModel = useCallback((m: string) => { setModelState(m); lsSet(MODEL_KEY, m); }, []);

  const blocked = cloud.accountMode && (!key || keyRef.current !== key || sessionKeyRef.current !== key);
  return {
    store,
    messages: blocked ? [] : messages,
    view: blocked ? { conversationId: null, streaming: false, connection: "idle", problem: null, lastSeq: 0, queue: null, senders: {} } : view,
    info: blocked ? null : info,
    notice,
    clearNotice: () => setNotice(null),
    notify: setNotice,
    conversationId,
    send,
    attach,
    abort,
    switchVisibility,
    newChat,
    openChat: switchTo,
    history: { items: blocked ? [] : histItems, loading: blocked ? false : histLoading, refresh: refreshHistory },
    model,
    setModel,
  };
}
