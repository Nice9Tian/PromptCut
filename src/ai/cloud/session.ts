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
import { accountMessageId, queueSnapshot, applyCloudEvent, applyCloudEvents, cloudErrorMessage, hasOpenRun, userMessageId } from "./events.ts";
import type { CloudEvent, CloudSendBody, CloudSendAccepted, CloudQueueSnapshot, CloudSender } from "./types.ts";
import type { PageRequestAnswer } from "./pageRequests.ts";

export type CloudConnection = "idle" | "connecting" | "live" | "reconnecting";

/** 页面执行器交回的答案:旧通道是 `PageRequestAnswer`;账号模式的执行器另带版本号、一次性随机数与页面号 */
export type PageRequestReply = PageRequestAnswer | ({ id: string; ok: boolean; pageId: string } & Record<string, unknown>);

export interface CloudSessionView {
  conversationId: string | null;
  /** 对话里有没有没收尾的一轮(服务端还在跑,不论此刻流连没连着) */
  streaming: boolean;
  connection: CloudConnection;
  /** 连不上、身份不对这类要给用户看的原因;连上了就清掉 */
  problem: string | null;
  lastSeq: number;
  queue?: CloudQueueSnapshot | null;
  senders?: Record<string, CloudSender>;
}

export interface CloudSessionDeps {
  api: Pick<CloudApi, "send" | "abort" | "events"> & Partial<Pick<CloudApi, "pageResult">>;
  /** 账号共享对话的读取可能在流中途被撤销;断流后不能继续把上一授权下的正文留在 store。 */
  accountMode?: boolean;
  /**
   * 反向通道(契约第 28 节):这张页面的页面号与执行请求的函数。两样都给了,发消息与开事件流时才报页面号,
   * 事件流里来的 `page.request` 才会被执行并交回;不给就是只看不动的页面。
   * 账号模式下页面号是这张页面在文档服务在场表里的那一个:连上文档服务之后才有、重连会变,所以给一个每次现取的函数;
   * 执行器的答案(带着请求号、一次性随机数与页面号)**原样**交回,不改页面号。
   */
  pageId?: string | (() => string | null);
  onPageRequest?: (ev: CloudEvent) => Promise<PageRequestReply | null> | PageRequestReply | null;
  /** 同 `setOnConversationDeleted`：创建时就给也行 */
  onConversationDeleted?: (conversationId: string) => void;
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

/**
 * 服务端回「没有这个对话」:账号模式下 Agent 服务对看不到的对话回 404 `no-conversation`(文档服务按账号核对的结果;路由不存在的 404 是 `not-found`,是故障,不在此列)(读取通道在没有任何读取被受理时不放行 2xx,
 * 所以不能用 200 加结束事件表达)。「还没发过第一条消息」「别人设为私有」「已删除」是同一种回应,页面靠自己知不知道这个对话存在过来分辨:
 * 只有调用方说它是页面刚建的、还没发过消息的新对话(`open(id, { fresh: true })`)才当正常状态。
 */
const isAbsent = (err: unknown) => err instanceof CloudError && err.status === 404 && err.code === "no-conversation";

/** 账号读取被撤销(设为私有、被踢、退出登录、Agent 被关、对话被删)时给用户看的话(已有的句子,不新增) */
const REVOKED_TEXT = "当前账号已无法读取这个对话，请重新选择有权限的对话。";
/** 账号模式下文档服务明确拒绝读取的 403 错误码:被踢、不在成员名单里 → 同一句「已无法读取」;Agent 被关用它自己已有的句子;别的原样 */
const deniedText = (err: unknown): string => {
  const code = err instanceof CloudError ? err.code : "";
  if (code === "not-listed" || code === "banned") return REVOKED_TEXT;
  if (code === "agent-disabled") return cloudErrorText("disabled");
  return err instanceof Error ? err.message : cloudErrorText("network");
};

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
  /** 调用方说这是页面刚建的、还没发过消息的新对话;只有这时「服务端还没有它」才是正常状态 */
  let fresh = false;
  /** 这次 open 之后,页面有没有理由认为这个对话在服务端存在:读到过它的事件,或这一页发消息被收下了 */
  let known = false;
  /** 这次 open 之后真读到过它的事件(不含「发消息被收下」):之后文档服务说「没有这个对话」就不是新对话,而是被设为私有或删除 */
  let seenLive = false;
  let queue: CloudQueueSnapshot | null = null;
  let senders: Record<string, CloudSender> = {};
  let queued: CloudEvent[] = [];
  /** 账号读取授权的代次。断流或撤权时递增，阻止旧流触发的页面工具异步结果继续回写。 */
  let readEpoch = 0;
  /** 这一页刚发出去的消息带的附件(气泡里显示名字用):runId → 附件;服务端的 user 事件到了(或已经在)就贴上、从表里去掉 */
  const pendingAttachments = new Map<string, ChatAttachment[]>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** 反向通道:两样都给了才开 */
  const pageSource = deps.pageId && deps.onPageRequest && api.pageResult ? deps.pageId : undefined;
  /** 这张页面此刻的页面号(账号模式每次现取;还没连上文档服务时没有) */
  const currentPage = (): string | undefined => (typeof pageSource === "function" ? pageSource() ?? undefined : pageSource);
  /** 现在这条事件流是带着哪个页面号开的 */
  let streamPage: string | undefined;
  /** 事件流此刻是不是开着(在读) */
  let streamOpen = false;
  /** `syncPage` 为了换页面号自己掐了这条流:不是断线,循环照「接着读」办(不清正文、不显示重连、不退避) */
  let repaging = false;
  /** 执行过的请求 id:同一条请求重复到达只执行一次 */
  const answered = new Set<string>();
  /** 正在看的对话被删了（别人删的，或自己在别处删的）：服务端发 `conversation.deleted` 就关流并调它，由界面退到一个新对话 */
  let onConversationDeleted: ((conversationId: string) => void) | null = deps.onConversationDeleted ?? null;

  /**
   * 事件流里来了一条 `page.request`:执行并交回。只在这条流还是当前对话的那一条时做(换了对话、关了页面就不做);
   * 交回失败(已经不在等了、网络断了)不重试——服务端到时会回「发起方不在线」,Agent 自己继续。
   */
  async function answerPageRequest(ev: CloudEvent, id: string, myGen: number, myReadEpoch: number) {
    if (!pageSource || !deps.onPageRequest || !api.pageResult) return;
    const reqId = typeof ev.id === "string" ? ev.id : "";
    if (!reqId || answered.has(reqId)) return;
    answered.add(reqId);
    if (answered.size > 200) answered.delete(answered.values().next().value as string);
    let answer: PageRequestReply | null = null;
    try {
      answer = await deps.onPageRequest(ev);
    } catch (err) {
      answer = { id: reqId, ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (!answer || closed || myGen !== gen || id !== conversationId || myReadEpoch !== readEpoch) return;
    try {
      // 账号模式:答案原样交回(页面号是执行器按在场页面号填的,服务端按它与一次性随机数核对);旧通道补上这张页面自己起的页面号
      const page = currentPage();
      if (deps.accountMode) await api.pageResult(id, { ...(answer as { id: string; ok: boolean; pageId: string } & Record<string, unknown>) });
      else if (page) await api.pageResult(id, { ...answer, pageId: page });
    } catch { /* 不在等了或网络断了:不重试 */ }
  }

  let view: CloudSessionView = { conversationId: null, streaming: false, connection: "idle", problem: null, lastSeq: 0 };
  const listeners = new Set<() => void>();

  function publish() {
    const next: CloudSessionView = { conversationId, streaming: hasOpenRun(store.get()), connection, problem, lastSeq, queue, senders };
    if (next.conversationId === view.conversationId && next.streaming === view.streaming && next.connection === view.connection && next.problem === view.problem && next.lastSeq === view.lastSeq && next.queue === view.queue && next.senders === view.senders) return;
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

  /** 账号共享读取失效后，丢弃这条授权下的正文、待折增量和附件关联，再从 seq 0 请求完整授权重放。 */
  function clearAccountReadState() {
    if (!deps.accountMode) return;
    readEpoch++;
    if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null; }
    queued = [];
    pendingAttachments.clear();
    lastSeq = 0;
    queue = null;
    senders = {};
    store.set([]);
    publish();
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
    if (ev.type === 'access.revoked') {
      queue = null; senders = {}; queued = []; store.set([]);
      problem = REVOKED_TEXT; publish(); return;
    }
    if (ev.type === 'queue.state' && conversationId) {
      const snapshot = queueSnapshot(ev, conversationId);
      if (!snapshot || (queue && (snapshot.queueRevision < queue.queueRevision || snapshot.aclRevision < queue.aclRevision))) return;
      queue = snapshot; publish(); return;
    }
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
      if (ev.type === 'user' && typeof ev.messageId === 'string' && typeof ev.senderAccountId === 'string' && typeof ev.senderNameAtSend === 'string')
        senders = { ...senders, [accountMessageId(ev.messageId)]: { accountId: ev.senderAccountId, name: ev.senderNameAtSend } };
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
    let resuming = false;
    try {
      while (!closed && myGen === gen) {
        const ctl = new AbortController();
        ac = ctl;
        const streamReadEpoch = readEpoch;
        // 换页面号的那一次重开(见 `syncPage`):界面上还是「连着」,不闪「连接中 / 重连中」
        if (!resuming) setConnection(attempt === 0 ? "connecting" : "reconnecting");
        resuming = false;
        let sawNone = false;
        try {
          streamPage = currentPage();
          streamOpen = true;
          for await (const ev of api.events(id, lastSeq, ctl.signal, streamPage)) {
            if (myGen !== gen || streamReadEpoch !== readEpoch) return;
            attempt = 0;
            known = true; seenLive = true;
            if (connection !== "live") { problem = null; setConnection("live"); }
            if (ev.type === "end" && ev.state === "none") { sawNone = true; continue; }
            // 反向通道的请求不是对话记录的一部分(没有 seq):不折进消息,交给页面执行
            if (ev.type === "page.request") { void answerPageRequest(ev, id, myGen, streamReadEpoch); continue; }
            if (deps.accountMode && ev.type === "conversation.deleted") {
              clearAccountReadState();
              problem = null;
              setConnection("idle");
              onConversationDeleted?.(id);
              return;
            }
            if (deps.accountMode && ev.type === "access.revoked") {
              clearAccountReadState();
              problem = REVOKED_TEXT;
              setConnection("idle");
              return;
            }
            handle(ev);
          }
        } catch (err) {
          streamOpen = false;
          if (myGen !== gen) return;
          // 自己为了换页面号掐的:不是故障,不走下面的判断
          if (repaging && ctl.signal.aborted) err = null;
          const status = err instanceof CloudError ? err.status : Number((err as { status?: unknown })?.status ?? 0);
          const accountAuthFailure = Boolean(deps.accountMode &&
            ((status === 401 || status === 403) || (err instanceof CloudError && FATAL.has(err.code))));
          if (accountAuthFailure) clearAccountReadState();
          if (accountAuthFailure || (err instanceof CloudError && FATAL.has(err.code))) {
            problem = deps.accountMode ? deniedText(err) : err instanceof Error ? err.message : cloudErrorText("network");
            setConnection("idle");
            return;
          }
          // 文档服务明确说「这个对话已被删」(404 conversation-deleted，只对看得到过它的人这么说)：清掉正文，退到新对话，不重连、不说「无权读取」
          if (deps.accountMode && err instanceof CloudError && err.status === 404 && err.code === "conversation-deleted") {
            clearAccountReadState();
            problem = null;
            setConnection("idle");
            onConversationDeleted?.(id);
            return;
          }
          // 账号模式下读到过的对话,现在文档服务说「没有这个对话」(或项目已不在):被设为私有、被删除、项目被删(围栏掐断旧流后重连才会遇到)。
          // 这是明确的没权限,不是故障:清掉正文、给「已无法读取」那句、停止读,不一直重连。
          if (deps.accountMode && seenLive && (isAbsent(err) || (err instanceof CloudError && err.status === 404 && err.code === "no-project"))) {
            clearAccountReadState();
            problem = REVOKED_TEXT;
            setConnection("idle");
            return;
          }
          // 新对话(还没发过第一条消息)服务端还没有它:安静地停下,等第一条消息;不当故障、不重试。
          // 不是新对话、或读到过/发过消息之后再 404(被删、被设为私有)不在此列,照原样重连提示。
          if (fresh && !known && isAbsent(err)) {
            problem = null;
            setConnection("idle");
            return;
          }
        }
        streamOpen = false;
        if (myGen !== gen || closed) return;
        if (repaging) {
          repaging = false;
          // 换页面号:正文、已读到的序号、排队状态都留着,马上带着新页面号从刚才读到的位置接着读(服务端照常重新核这一次读取)。
          // 重开要是没成,下一圈就是普通的断线,照下面的规矩清正文、显示重连。
          if (ctl.signal.aborted) { resuming = true; continue; }
        }
        // 账号对话的 EOF/断连不保留旧正文，也不续用旧 seq；下一次连接会重新取票并从头重放。
        if (deps.accountMode) clearAccountReadState();
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
    repaging = false; streamOpen = false;
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

    /** 打开一个对话:对话 store 清空,从头读事件流(新对话读到「没有」就停下,等第一条消息)。`fresh`:这是页面刚建的、还没发过消息的新对话 */
    open(id: string, opts?: { fresh?: boolean }) {
      if (closed) return;
      stopLoop();
      conversationId = id;
      lastSeq = 0;
      fresh = opts?.fresh === true;
      known = false; seenLive = false;
      queued = [];
      pendingAttachments.clear();
      queue = null; senders = {};
      problem = null;
      store.set([]);
      publish();
      ensureLoop();
    },

    /** 登记「正在看的对话被删了」的处理(界面退到新对话)。单独一个方法，免得改动创建会话那一处的接线 */
    setOnConversationDeleted(fn: ((conversationId: string) => void) | null) { onConversationDeleted = fn; },

    /** 对话 id;没打开过是 null */
    get conversationId() { return conversationId; },

    /** 发一条消息(`shown`:带的附件,只用于本页气泡的显示)。服务端回 202 之后保证流连着。出错抛 `CloudError`(界面显示它的 `message`) */
    async send(body: CloudSendBody, shown?: ChatAttachment[]): Promise<void> {
      if (!conversationId || closed) throw new CloudError("bad-request", "还没有打开对话。");
      const seenBefore = lastSeq;
      let accepted: CloudSendAccepted;
      try {
        // 旧通道在发消息时报页面号;账号模式的页面号由文档服务从选区快照里取(`selectionSnapshot.pageId`),这里不另报
        const page = deps.accountMode ? undefined : currentPage();
        accepted = await api.send(conversationId, page ? { ...body, pageId: page } : body);
      } catch (err) {
        if (err instanceof CloudError) throw err;
        throw new CloudError("network", cloudErrorText("network"));
      }
      problem = null;
      known = true;
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

    /**
     * 账号模式:这张页面的在场页面号变了(刚连上、或重连了文档服务)——现在这条流是带着旧页面号开的,云端的请求发不到这里。
     * 要做的只是让服务端知道新的页面号:掐掉这条流、马上带着新页面号从刚才读到的位置接着读。**正文不清、不显示重连提示、不退避**
     * (这不是断线)。页面号没变、没有流在开着(正在退避等重连:下一次开流本来就会带新页面号)时什么都不做。
     */
    syncPage() {
      if (!deps.accountMode || closed || !loopAlive || !pageSource || !streamOpen) return;
      if (currentPage() === streamPage) return;
      repaging = true;
      ac?.abort();
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
