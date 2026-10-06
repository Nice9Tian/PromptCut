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
import { getTabCreativity } from "../agentTabs";
import { getScript } from "../script";
import { mediaCardUrl } from "../mediaRef";
import { cloudAgentVersion, resolveCloudAgent, subscribeCloudAgent, type CloudAgentAvailability } from "./endpoint";
import { CloudError, cloudErrorText, createCloudApi, type CloudApi } from "./cloudApi";
import { createCloudSession, type CloudSession, type CloudSessionView } from "./session";
import { titleOf } from "./events";
import type { CloudChatItem, CloudInfo, CloudSendBody } from "./types";

const ONLINE_BUILD = typeof import.meta.env !== "undefined" && import.meta.env.VITE_PC_ONLINE === "1";

/* ---------------- 能不能用 ---------------- */

export interface CloudAgentState extends CloudAgentAvailability {
  /** 此刻连着的共享项目号;没连共享项目是 null */
  projectId: string | null;
}

export function useCloudAgent(): CloudAgentState {
  const shared = useSync((v) => v.shared);
  const ver = useSyncExternalStore(subscribeCloudAgent, cloudAgentVersion, cloudAgentVersion);
  const projectId = shared?.projectId ?? (ONLINE_BUILD ? currentDocProjectId() || null : null);
  const where = shared?.where === "hosted";
  return useMemo(
    () => ({ ...resolveCloudAgent({ projectId, hostedWhere: where || ONLINE_BUILD, online: ONLINE_BUILD }), projectId }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectId, where, ver],
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
const chatKey = (projectId: string, tabId: string) => `pc.cloudChat:${projectId}:${tabId}`;
const titlesKey = (projectId: string) => `pc.cloudTitles:${projectId}`;

function readTitles(projectId: string): Record<string, string> {
  try {
    const v = JSON.parse(lsGet(titlesKey(projectId)) ?? "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}
function rememberTitle(projectId: string, id: string, title: string) {
  const t = readTitles(projectId);
  if (t[id] === title) return;
  const ids = Object.keys(t);
  if (ids.length > 200) delete t[ids[0]];
  t[id] = title;
  lsSet(titlesKey(projectId), JSON.stringify(t));
}

/** 素材库清单(附在每条消息后面,让模型不必先花一轮 list_media);云端不收附件,只列库里已有的 */
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

export function useCloudApi(url: string | null): CloudApi {
  const urlRef = useRef(url);
  urlRef.current = url;
  return useMemo(() => createCloudApi({ baseUrl: () => urlRef.current }), []);
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
  const api = useCloudApi(cloud.url);
  const [items, setItems] = useState<CloudChatItem[]>([]);
  const [running, setRunning] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const key = cloud.available && cloud.url && cloud.projectId ? `${cloud.projectId}|${cloud.url}` : "";
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
        const titles = readTitles(cloud.projectId ?? "");
        setItems(list.map((x) => (x.title === "云端对话" && titles[x.id] ? { ...x, title: titles[x.id] } : x)));
        setRunning(list.filter((x) => x.state === "running").map((x) => x.id));
      }
      if (info && info.running.length) setRunning(info.running);
    } finally {
      if (keyRef.current === k) setLoading(false);
    }
  }, [api, cloud.projectId]);

  useEffect(() => {
    setItems([]);
    setRunning([]);
    if (!enabled || !key) return;
    void load(true);
  }, [key, enabled, load]);

  const refresh = useCallback(() => load(false), [load]);
  return { items, running, loading, refresh };
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
  conversationId: string;
  send: (text: string) => Promise<boolean>;
  abort: () => Promise<void>;
  newChat: () => void;
  openChat: (id: string) => void;
  history: { items: CloudChatItem[]; loading: boolean; refresh: () => Promise<void> };
  model: string;
  setModel: (m: string) => void;
}

/**
 * 一页的云端对话。`active` 为假(页签在后台)时流照读;`enabled` 为假(项目没有云端 Agent、或这一页没选「云端」)时什么都不做。
 * `autoAttach`:进入时发现服务端有在跑的对话,就自动打开那个(契约 7.4:重新打开页面自动接上还在跑的对话)。
 */
export function useCloudChat(o: { tabId: string; cloud: CloudAgentState; enabled: boolean; autoAttach: boolean; initialConversation?: string | null }): CloudChat {
  const { tabId, cloud, enabled } = o;
  const store = useMemo(() => getChatStore(`cloud:${tabId}`), [tabId]);
  const messages = useChatMessages(store);
  const api = useCloudApi(cloud.url);
  const projectId = cloud.projectId ?? "";
  const key = enabled && cloud.available && cloud.url && projectId ? `${projectId}|${cloud.url}|${tabId}` : "";

  const [info, setInfo] = useState<CloudInfo | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string>(() => (key ? lsGet(chatKey(projectId, tabId)) : null) ?? newCloudChatId());
  const [view, setView] = useState<CloudSessionView>({ conversationId: null, streaming: false, connection: "idle", problem: null, lastSeq: 0 });
  const [model, setModelState] = useState<string>(() => lsGet(MODEL_KEY) ?? "");
  const [histItems, setHistItems] = useState<CloudChatItem[]>([]);
  const [histLoading, setHistLoading] = useState(false);
  const sessionRef = useRef<CloudSession | null>(null);
  const convRef = useRef(conversationId);
  convRef.current = conversationId;

  // 项目或地址或页签变了:换一个会话控制器。对话 id 取这个项目这一页上次用的
  useEffect(() => {
    if (!key) {
      sessionRef.current?.close();
      sessionRef.current = null;
      return;
    }
    let dead = false;
    const stored = o.initialConversation && CHAT_ID_RE.test(o.initialConversation) ? o.initialConversation : lsGet(chatKey(projectId, tabId));
    const first = stored && CHAT_ID_RE.test(stored) ? stored : newCloudChatId();
    const session = createCloudSession({ api, store });
    sessionRef.current = session;
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
      if (dead) return;
      setConversationId(id);
      lsSet(chatKey(projectId, tabId), id);
      session.open(id);
    })();
    return () => {
      dead = true;
      off();
      session.close();
      if (sessionRef.current === session) sessionRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

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

  // 会话的问题(身份不对、被拒)也交给界面
  useEffect(() => { if (view.problem) setNotice(view.problem); }, [view.problem]);
  // 记下对话标题,历史列表里没有服务端标题时用
  useEffect(() => {
    if (!projectId || !messages.length) return;
    rememberTitle(projectId, convRef.current, titleOf(messages));
  }, [projectId, messages]);

  const send = useCallback(async (text: string): Promise<boolean> => {
    const s = sessionRef.current;
    if (!s || !text.trim()) return false;
    setNotice(null);
    const body: CloudSendBody = {
      prompt: text.trim(),
      pageState: pageState(),
      library: mediaLibrary(),
      creativity: getTabCreativity(tabId),
      ...(getScript().trim() ? { script: getScript() } : {}),
      ...(model ? { model } : {}),
    };
    try {
      await s.send(body);
      return true;
    } catch (err) {
      setNotice(err instanceof CloudError ? err.message : cloudErrorText("network"));
      return false;
    }
  }, [tabId, model]);

  const abort = useCallback(async () => {
    try {
      await sessionRef.current?.abort();
    } catch (err) {
      setNotice(err instanceof CloudError ? err.message : cloudErrorText("network"));
    }
  }, []);

  const switchTo = useCallback((id: string) => {
    setConversationId(id);
    if (projectId) lsSet(chatKey(projectId, tabId), id);
    setNotice(null);
    sessionRef.current?.open(id);
  }, [projectId, tabId]);

  const newChat = useCallback(() => switchTo(newCloudChatId()), [switchTo]);

  const refreshHistory = useCallback(async () => {
    if (!key) return;
    setHistLoading(true);
    try {
      const list = await api.list();
      const titles = readTitles(projectId);
      setHistItems(list.map((x) => (x.title === "云端对话" && titles[x.id] ? { ...x, title: titles[x.id] } : x)));
    } catch (err) {
      setNotice(err instanceof CloudError ? err.message : cloudErrorText("network"));
    } finally {
      setHistLoading(false);
    }
  }, [api, key, projectId]);

  const setModel = useCallback((m: string) => { setModelState(m); lsSet(MODEL_KEY, m); }, []);

  return {
    store,
    messages,
    view,
    info,
    notice,
    clearNotice: () => setNotice(null),
    conversationId,
    send,
    abort,
    newChat,
    openChat: switchTo,
    history: { items: histItems, loading: histLoading, refresh: refreshHistory },
    model,
    setModel,
  };
}
