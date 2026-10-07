/**
 * 一个云端对话在页面这一侧的控制器(契约 2.4、7.4 节)。没有 React,Node 单测直接用。
 *
 * 它做四件事:
 *   1. 打开一个对话:从 `seq` 0 起读事件流,按 `seq` 去重、折成消息写进这页的对话 store;
 *   2. 流断了(关页签前的网络抖动、服务重启、反向代理超时)自动重连,带上已经看到的最大 `seq`,服务端补发其后的、再接实时,不重不漏;
 *   3. 发消息(服务端回 202,这一轮与这个请求无关)、停止;
 *   4. 把「现在什么状态」交给界面:有没有没收尾的一轮、流是否连着、最近一次错误。
 *
 * 流是「看」,不是「跑」:关掉页面、退出软件,服务端的这一轮照样跑完(契约 2.4 节)。所以 `close()` 只掐流,不发停止。
 * 停止只有 `abort()` 一条路,是用户点「停止」才发的。
 */
import type { ChatAttachment, ChatMessage } from "../types.ts";
import type { ChatStore } from "../liveChat.ts";
import { CloudError, cloudErrorText, type CloudApi } from "./cloudApi.ts";
import { applyCloudEvent, applyCloudEvents, cloudErrorMessage, hasOpenRun, userMessageId } from "./events.ts";
import type { CloudEvent, CloudSendBody } from "./types.ts";
import type { PageRequestAnswer } from "./pageRequests.ts";

export type CloudConnection = "idle" | "connecting" | "live" | "reconnecting";

export interface CloudSessionView {
  conversationId: string | null;
  /** 对话里有没有没收尾的一轮(服务端还在跑,不论此刻流连没连着) */
  streaming: boolean;
  connection: CloudConnection;
  /** 连不上、身份不对这类要给用户看的原因;连上了就清掉 */
  problem: string | null;
  lastSeq: number;
}

export interface CloudSessionDeps {
  api: Pick<CloudApi, "send" | "abort" | "events"> & Partial<Pick<CloudApi, "pageResult">>;
  /**
   * 反向通道(契约第 28 节):这张页面的页面号与执行请求的函数。两样都给了,发消息与开事件流时才报页面号,
   * 事件流里来的 `page.request` 才会被执行并交回;不给就是只看不动的页面。
   */
  pageId?: string;
  onPageRequest?: (ev: CloudEvent) => Promise<PageRequestAnswer | null> | PageRequestAnswer | null;
  store: ChatStore;
  /** 文字与思考的增量攒批的间隔(毫秒);0 = 来一条折一条 */
  flushMs?: number;
  /** 第 n 次重连前等多久(毫秒) */
  backoff?: (attempt: number) => number;
}

/** 重连等待:0.4 秒起、每次翻倍、封顶 8 秒 */
export const defaultBackoff = (attempt: number) => Math.min(8000, 400 * 2 ** Math.max(0, attempt - 1));

/** 身份、权限这类重试也没用的错误:停下来把原因给用户,不无限重连 */
const FATAL = new Set(["unauthorized", "no-identity", "forbidden", "disabled"]);

const isDelta = (ev: CloudEvent) => (ev.type === "text" || ev.type === "thinking") && typeof ev.delta === "string" && ev.delta !== "";

export function createCloudSession(deps: CloudSessionDeps) {
  const { api, store } = deps;
  const flushMs = deps.flushMs ?? 80;
  const backoff = deps.backoff ?? defaultBackoff;

  let conversationId: string | null = null;
  let lastSeq = 0;
  let gen = 0;
  let ac: AbortController | null = null;
  let loopAlive = false;
  let connection: CloudConnection = "idle";
  let problem: string | null = null;
  let wake: (() => void) | null = null;
  let closed = false;
  let queued: CloudEvent[] = [];
  /** 这一页刚发出去的消息带的附件(气泡里显示名字用):runId → 附件;服务端的 user 事件到了(或已经在)就贴上、从表里去掉 */
  const pendingAttachments = new Map<string, ChatAttachment[]>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** 反向通道:两样都给了才开 */
  const pageId = deps.pageId && deps.onPageRequest && api.pageResult ? deps.pageId : undefined;
  /** 执行过的请求 id:同一条请求重复到达只执行一次 */
  const answered = new Set<string>();

  /**
   * 事件流里来了一条 `page.request`:执行并交回。只在这条流还是当前对话的那一条时做(换了对话、关了页面就不做);
   * 交回失败(已经不在等了、网络断了)不重试——服务端到时会回「发起方不在线」,Agent 自己继续。
   */
  async function answerPageRequest(ev: CloudEvent, id: string, myGen: number) {
    if (!pageId || !deps.onPageRequest || !api.pageResult) return;
    const reqId = typeof ev.id === "string" ? ev.id : "";
    if (!reqId || answered.has(reqId)) return;
    answered.add(reqId);
    if (answered.size > 200) answered.delete(answered.values().next().value as string);
    let answer: PageRequestAnswer | null = null;
    try {
      answer = await deps.onPageRequest(ev);
    } catch (err) {
      answer = { id: reqId, ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (!answer || closed || myGen !== gen || id !== conversationId) return;
    try {
      await api.pageResult(id, { ...answer, pageId });
    } catch { /* 不在等了或网络断了:不重试 */ }
  }

  let view: CloudSessionView = { conversationId: null, streaming: false, connection: "idle", problem: null, lastSeq: 0 };
  const listeners = new Set<() => void>();

  function publish() {
    const next: CloudSessionView = { conversationId, streaming: hasOpenRun(store.get()), connection, problem, lastSeq };
    if (next.conversationId === view.conversationId && next.streaming === view.streaming && next.connection === view.connection && next.problem === view.problem && next.lastSeq === view.lastSeq) return;
    view = next;
    for (const l of [...listeners]) l();
  }
  // 对话 store 变了(包括别处改它)也要重算 streaming
  const offStore = store.subscribe(publish);

  function flush() {
    if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null; }
    if (!queued.length) return;
    const batch = queued;
    queued = [];
    store.set((prev) => applyCloudEvents(prev, batch));
  }

  /** 把这一页发的附件贴到对应的用户消息上(消息还没到就留着等它) */
  function applyPendingAttachments(runId: string) {
    const list = pendingAttachments.get(runId);
    if (!list) return;
    const id = userMessageId(runId);
    if (!store.get().some((m) => m.id === id)) return;
    pendingAttachments.delete(runId);
    store.set((prev) => prev.map((m) => (m.id === id && !m.attachments?.length ? { ...m, attachments: list } : m)));
  }

  function handle(ev: CloudEvent) {
    if (typeof ev.seq === "number") {
      if (ev.seq <= lastSeq) return; // 补发与实时交界处、重连后重复的:不重
      lastSeq = ev.seq;
    }
    if (isDelta(ev)) {
      queued.push(ev);
      if (flushMs <= 0) flush();
      else if (flushTimer === null) flushTimer = setTimeout(flush, flushMs);
    } else {
      flush();
      store.set((prev) => applyCloudEvent(prev, ev));
      if (ev.type === "user" && typeof ev.runId === "string") applyPendingAttachments(ev.runId);
    }
    publish();
  }

  function setConnection(c: CloudConnection) {
    if (connection === c) return;
    connection = c;
    publish();
  }

  /** 服务端已经没有这个对话(它重启过、又没把记录落盘):没收尾的那一轮标成中断,别让界面永远转圈 */
  function markInterrupted() {
    flush();
    if (!hasOpenRun(store.get())) return;
    store.set((prev) => prev.map((m: ChatMessage) => (m.role === "assistant" && m.pending ? { ...m, pending: false, outcome: "error", error: cloudErrorMessage("interrupted"), finishedAt: Date.now() } : m)));
  }

  function sleepUntilWake(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => { wake = null; resolve(); }, ms);
      wake = () => { clearTimeout(t); wake = null; resolve(); };
    });
  }

  async function loop(myGen: number, id: string) {
    loopAlive = true;
    let attempt = 0;
    try {
      while (!closed && myGen === gen) {
        const ctl = new AbortController();
        ac = ctl;
        setConnection(attempt === 0 ? "connecting" : "reconnecting");
        let sawNone = false;
        try {
          for await (const ev of api.events(id, lastSeq, ctl.signal, pageId)) {
            if (myGen !== gen) return;
            attempt = 0;
            if (connection !== "live") { problem = null; setConnection("live"); }
            if (ev.type === "end" && ev.state === "none") { sawNone = true; continue; }
            // 反向通道的请求不是对话记录的一部分(没有 seq):不折进消息,交给页面执行
            if (ev.type === "page.request") { void answerPageRequest(ev, id, myGen); continue; }
            handle(ev);
          }
        } catch (err) {
          if (myGen !== gen) return;
          if (err instanceof CloudError && FATAL.has(err.code)) {
            problem = err.message;
            setConnection("idle");
            return;
          }
        }
        if (myGen !== gen || closed) return;
        if (sawNone) {
          // 对话还不存在(新对话,发第一条消息时再起),或服务端已经没有它了
          if (lastSeq > 0) markInterrupted();
          setConnection("idle");
          return;
        }
        attempt++;
        setConnection("reconnecting");
        await sleepUntilWake(backoff(attempt));
      }
    } finally {
      if (myGen === gen) { loopAlive = false; ac = null; }
    }
  }

  function ensureLoop() {
    if (closed || !conversationId) return;
    if (loopAlive) { wake?.(); return; }
    void loop(gen, conversationId);
  }

  function stopLoop() {
    gen++;
    ac?.abort();
    ac = null;
    wake?.();
    loopAlive = false;
    flush();
  }

  return {
    getView: () => view,
    subscribe(l: () => void) {
      listeners.add(l);
      return () => { listeners.delete(l); };
    },

    /** 打开一个对话:对话 store 清空,从头读事件流(新对话读到「没有」就停下,等第一条消息) */
    open(id: string) {
      if (closed) return;
      stopLoop();
      conversationId = id;
      lastSeq = 0;
      queued = [];
      pendingAttachments.clear();
      problem = null;
      store.set([]);
      publish();
      ensureLoop();
    },

    /** 对话 id;没打开过是 null */
    get conversationId() { return conversationId; },

    /** 发一条消息(`shown`:带的附件,只用于本页气泡的显示)。服务端回 202 之后保证流连着。出错抛 `CloudError`(界面显示它的 `message`) */
    async send(body: CloudSendBody, shown?: ChatAttachment[]): Promise<void> {
      if (!conversationId || closed) throw new CloudError("bad-request", "还没有打开对话。");
      const seenBefore = lastSeq;
      let accepted: { runId: string; seq: number };
      try {
        accepted = await api.send(conversationId, pageId ? { ...body, pageId } : body);
      } catch (err) {
        if (err instanceof CloudError) throw err;
        throw new CloudError("network", cloudErrorText("network"));
      }
      problem = null;
      // 带了附件:气泡里照桌面版显示附件名(服务端的 user 事件自己带了就以它为准)
      if (shown?.length && accepted.runId) {
        pendingAttachments.set(accepted.runId, shown);
        applyPendingAttachments(accepted.runId);
        if (pendingAttachments.size > 20) pendingAttachments.delete(pendingAttachments.keys().next().value as string);
      }
      // 服务端回的 seq 是这一轮第一条事件的序号。比页面已经看到的还小:服务端的这个对话从头开始了(实例被撤销回收、服务重启又没落盘),
      // 旧流挂在已经不存在的对话上、永远等不到新事件 —— 掐掉旧流、从 0 重新读。记录落盘、seq 跨轮连续时不会走到这里。
      // (比的是发送之前看到的最大序号:这一轮自己的事件可能已经从流里先到了,不能拿发送之后的 lastSeq 比)
      if (accepted.seq > 0 && accepted.seq <= seenBefore) {
        lastSeq = 0;
        gen++;
        ac?.abort();
        ac = null;
        wake?.();
        loopAlive = false;
        publish();
      }
      ensureLoop();
    },

    /** 停掉这个对话进行中的一轮。事件流会带回「已停止」与收尾 */
    async abort(): Promise<void> {
      if (!conversationId) return;
      try {
        await api.abort(conversationId);
      } finally {
        ensureLoop();
      }
    },

    /** 关闭(不可再用):只掐流,不停服务端的那一轮 */
    close() {
      closed = true;
      stopLoop();
      setConnection("idle");
      offStore();
      listeners.clear();
    },

    /** 马上重连(网络恢复、页面回到前台时用) */
    kick() {
      if (loopAlive) wake?.();
      else ensureLoop();
    },

    /** 单测用:此刻攒着没折的增量先折进去 */
    _flush: flush,
  };
}

export type CloudSession = ReturnType<typeof createCloudSession>;
