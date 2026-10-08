/**
 * 页面打云端 Agent 服务的接口层(契约 2.3、2.4 节)。没有 React、没有 store,Node 单测直接用。
 *
 * - 每个请求现取一张委托票据放进 `Authorization`;不带 Cookie(`credentials: "omit"`),跨源时服务端放开来源、只认票据;
 * - 发消息回 202,这一轮从此与这个请求的连接无关;看进展走另一个接口(事件流),按 `seq` 补发再接实时;
 * - 事件流用 `fetch` 读(`EventSource` 带不了请求头),解析复用 `sse.ts`。
 */
import { parseSseChunks } from "../sse.ts";
import { CloudDelegationError, CloudIdentityError, cloudGrant, cloudTicket } from "./identity.ts";
import { CLOUD_ATTACH_TOO_LARGE, normalizeAttachmentInfo, type CloudAttachmentInfo } from "./attach.ts";
import type { CloudChatItem, CloudChatState, CloudEvent, CloudInfo, CloudSendBody, CloudSendAccepted } from "./types.ts";

export class CloudError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 0) {
    super(message);
    this.name = "CloudError";
    this.code = code;
    this.status = status;
  }
}

/** 契约 2.3 节的错误码 → 给用户看的话。服务端自己带了说明(额度、原因)的用服务端的 */
export function cloudErrorText(code: string, serverMessage?: string): string {
  switch (code) {
    case "unauthorized": return "云端 Agent 暂时连不上:身份验证没有通过。请刷新页面或重新进入项目。";
    case "no-identity": return "云端 Agent 暂时用不了:还没有取得身份证明。";
    case "forbidden": return "你没有权限使用这个项目的云端 Agent。";
    case "disabled": return "项目创建者已关闭云端 Agent。";
    case "busy": return "云端 Agent 正忙,请稍后再试。";
    case "busy-conversation": return "这个对话还有一轮在进行,等它结束或先停止。";
    case "quota-exceeded": return serverMessage || "这个项目的云端 Agent 额度已用完。";
    case "no-model-key": return "云端 Agent 还没有配置模型,请联系托管方。";
    case "too-large": return "消息太长了,云端 Agent 收不下。请缩短后再发。";
    case "bad-grant": return "这次对话的授权已失效,请重新发送。";
    case "unavailable": return serverMessage || "云端 Agent 暂时连不上文档服务,请稍后再试。";
    case "network": return "连不上云端 Agent 服务,请检查网络。";
    default: return serverMessage || `云端 Agent 出错了(${code})。`;
  }
}

export interface CloudApiDeps {
  /** Agent 服务的 `/v1` 根地址(不带末尾斜杠);每次现取,项目换了地址跟着换 */
  baseUrl: () => string | null;
  /** 账号会话的当前项目；只核响应归属，不作为服务端授权。 */
  projectId?: () => string | null;
  ticket?: () => Promise<string>;
  grant?: (conversationId: string) => Promise<string | undefined>;
  fetchImpl?: typeof fetch;
  /** 事件流连续这么久一个字节都没来就当它断了(服务端每 15 秒发一行 ping);缺省 45 秒 */
  stallMs?: number;
}

/** 事件流多久没有任何字节就当断了:服务端每 15 秒一行 ping(契约 2.4 节),三次没到就是半开的连接 */
export const EVENTS_STALL_MS = 45_000;

async function readError(res: Response): Promise<CloudError> {
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  const body = parsed && typeof parsed === "object" ? (parsed as { code?: string; message?: string }) : null;
  const code = body?.code || (res.status === 401 ? "unauthorized" : res.status === 403 ? "forbidden" : "unavailable");
  return new CloudError(code, cloudErrorText(code, body?.message), res.status);
}

const num = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const STATES = new Set(["idle", "running", "interrupted", "failed", "revoked"]);

export function normalizeInfo(raw: Record<string, unknown>): CloudInfo {
  const models = Array.isArray(raw.models)
    ? raw.models
        .map((m) => {
          if (typeof m === "string") return { id: m };
          const o = m && typeof m === "object" ? (m as { id?: unknown; label?: unknown }) : null;
          return o && typeof o.id === "string" ? { id: o.id, label: typeof o.label === "string" ? o.label : undefined } : null;
        })
        .filter((m): m is { id: string; label?: string } => !!m)
    : [];
  const limits = raw.limits && typeof raw.limits === "object" ? (raw.limits as Record<string, unknown>) : {};
  const usage = raw.usage && typeof raw.usage === "object" ? (raw.usage as Record<string, unknown>) : undefined;
  return {
    ...(raw.accountMode === true ? { accountMode: true, executorMounted: raw.executorMounted === true } : {}),
    enabled: raw.enabled !== false,
    models,
    defaultModel: typeof raw.defaultModel === "string" ? raw.defaultModel : null,
    running: Array.isArray(raw.running) ? raw.running.filter((x): x is string => typeof x === "string") : [],
    limits: { rounds: typeof limits.rounds === "number" ? limits.rounds : undefined, runMs: typeof limits.runMs === "number" ? limits.runMs : undefined },
    ...(usage ? { usage: { tokens: typeof usage.tokens === "number" ? usage.tokens : undefined, limitTokens: typeof usage.limitTokens === "number" ? usage.limitTokens : null } } : {}),
  };
}

export function normalizeChatItem(raw: Record<string, unknown>): CloudChatItem | null {
  if (typeof raw.id !== "string" || !raw.id) return null;
  const state = typeof raw.state === "string" && STATES.has(raw.state) ? (raw.state as CloudChatState) : "idle";
  return {
    ...(raw.v === 2 ? { projectId: typeof raw.projectId === 'string' ? raw.projectId : undefined,
      ownerAccountId: typeof raw.ownerAccountId === 'string' ? raw.ownerAccountId : undefined,
      visibility: raw.visibility === 'private' ? 'private' as const : 'shared' as const,
      creatorReadOnly: raw.creatorReadOnly === true, queueRevision: num(raw.queueRevision) } : {}),
    id: raw.id,
    title: typeof raw.title === "string" && raw.title ? raw.title : "云端对话",
    updatedAt: num(raw.updatedAt),
    state,
    lastSeq: num(raw.lastSeq),
    startedOn: typeof raw.startedOn === "string" ? raw.startedOn : null,
    reason: typeof raw.reason === "string" ? raw.reason : null,
  };
}

export function createCloudApi(deps: CloudApiDeps) {
  const f = (...a: Parameters<typeof fetch>) => (deps.fetchImpl ?? globalThis.fetch)(...a);
  const getTicket = deps.ticket ?? cloudTicket;
  const getGrant = deps.grant ?? cloudGrant;

  /** 取票据、取对话委托失败 → 给用户看的错:没有身份、创建者关了开关(文档服务拒签 `service-disabled`)、连接断着、其余算身份验证没过 */
  function identityError(err: unknown): CloudError {
    if (err instanceof CloudIdentityError) return new CloudError("no-identity", cloudErrorText("no-identity"));
    const code = err instanceof CloudDelegationError ? err.code : "";
    if (code === "service-disabled") return new CloudError("disabled", cloudErrorText("disabled"));
    if (code === "closed" || code === "timeout" || code === "offline") return new CloudError("unavailable", "和文档服务的连接断着,云端 Agent 暂时用不了。连上后再试。");
    return new CloudError("unauthorized", cloudErrorText("unauthorized"));
  }

  async function headers(json: boolean): Promise<Record<string, string>> {
    let ticket: string;
    try {
      ticket = await getTicket();
    } catch (err) {
      throw identityError(err);
    }
    return { Authorization: `Bearer ${ticket}`, ...(json ? { "Content-Type": "application/json" } : {}) };
  }

  function url(path: string): string {
    const base = deps.baseUrl();
    if (!base) throw new CloudError("unavailable", "这个项目没有可用的云端 Agent。");
    return `${base}${path}`;
  }

  async function request(path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
    const { json, ...rest } = init;
    const h = await headers(json !== undefined);
    let res: Response;
    try {
      res = await f(url(path), {
        ...rest,
        headers: { ...h, ...(rest.headers as Record<string, string> | undefined) },
        credentials: "omit",
        cache: "no-store",
        ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
      });
    } catch (err) {
      if (err instanceof CloudError) throw err;
      if ((err as { name?: string })?.name === "AbortError") throw err;
      throw new CloudError("network", cloudErrorText("network"));
    }
    if (!res.ok) throw await readError(res);
    return res;
  }

  return {
    async info(): Promise<CloudInfo> {
      const res = await request("/info");
      return normalizeInfo((await res.json()) as Record<string, unknown>);
    },

    async list(): Promise<CloudChatItem[]> {
      const res = await request("/conversations");
      const body = (await res.json()) as { items?: unknown };
      return (Array.isArray(body.items) ? body.items : []).map((x) => normalizeChatItem(x as Record<string, unknown>)).filter((x): x is CloudChatItem => !!x);
    },

    /** 发一条消息、起一轮。回 202:这一轮从此与这个请求无关 */
    async send(conversationId: string, body: CloudSendBody): Promise<CloudSendAccepted> {
      // 对话委托要不到(开关关了、连接断着)就不发:不带它服务端只会回 bad-grant,原因反而说不清
      let grant: string | undefined;
      try {
        grant = await getGrant(conversationId);
      } catch (err) {
        throw identityError(err);
      }
      const res = await request(`/conversations/${encodeURIComponent(conversationId)}/messages`, { method: "POST", json: { ...body, ...(grant ? { grant } : {}) } });
      const out = (await res.json()) as Record<string, any>;
      if (out.messageId !== undefined) {
        if (typeof out.messageId !== 'string' || !out.messageId || out.runId !== null ||
          !Number.isSafeInteger(out.seq) || out.seq <= 0 || !Number.isSafeInteger(out.queuePosition) || out.queuePosition < 1 ||
          !Number.isSafeInteger(out.queueRevision) || out.queueRevision < out.seq || out.conversation?.id !== conversationId ||
          !deps.projectId?.() || out.conversation?.projectId !== deps.projectId())
          throw new CloudError('unavailable', '云端排队确认无效，请重新读取对话。', 503);
        return { runId: null, seq: out.seq, messageId: out.messageId, queuePosition: out.queuePosition, queueRevision: out.queueRevision };
      }
      return { runId: String(out.runId ?? ""), seq: num(out.seq) };
    },

    /**
     * 传一个附件到这个对话的工作目录(契约 2.3 节):请求体就是文件字节,不是 JSON、不是 multipart。
     * 对话还没发过消息也可以先传。回的 `url`(`work:attachments/…`)随下一条消息的 `attachments` 带回去。
     * 出错:413 `too-large`(单个 512 MB 或工作目录满了)、400 `bad-request`(空文件、文件名不合法)、403 `disabled`、401、503 `unavailable`。
     */
    async attach(conversationId: string, file: Blob, name: string, signal?: AbortSignal): Promise<CloudAttachmentInfo> {
      let res: Response;
      try {
        res = await request(`/conversations/${encodeURIComponent(conversationId)}/attachments?name=${encodeURIComponent(name)}`, {
          method: "POST",
          body: file,
          signal,
          headers: { "Content-Type": "application/octet-stream" },
        });
      } catch (err) {
        // 「消息太长了」是发消息的话,附件超限要换一句
        if (err instanceof CloudError && err.code === "too-large") throw new CloudError("too-large", CLOUD_ATTACH_TOO_LARGE, err.status);
        throw err;
      }
      const body = (await res.json().catch(() => null)) as { attachment?: unknown } | null;
      const info = normalizeAttachmentInfo(body?.attachment, name);
      if (!info) throw new CloudError("unavailable", "云端 Agent 没有收下这个附件,请重试。", res.status);
      return info;
    },

    /**
     * 交回反向通道上一次请求的结果(契约第 28 节)。服务端按「这个对话、这位成员、这张页面、还在等的 id」核对,一次有效;
     * 已经不在等了(超时、这一轮结束了)回 410 `page-request-gone`,调用方不用管。
     */
    async pageResult(conversationId: string, body: { id: string; pageId: string; ok: boolean; result?: unknown; error?: string }): Promise<void> {
      await request(`/conversations/${encodeURIComponent(conversationId)}/page-results`, { method: "POST", json: body });
    },

    async abort(conversationId: string): Promise<void> {
      await request(`/conversations/${encodeURIComponent(conversationId)}/abort`, { method: "POST", json: {} });
    },

    /**
     * 看一个对话的事件:先补发 `seq` 大于 `after` 的,再接实时的。流结束(服务端关了、网络断了)时 generator 正常返回或抛错,
     * 由调用方决定要不要重连。对话还不存在时服务端发一条 `{ type: "end", state: "none", seq: 0 }` 就关。
     */
    async *events(conversationId: string, after: number, signal?: AbortSignal, pageId?: string): AsyncGenerator<CloudEvent> {
      // `page`:这张页面的页面号(契约第 28 节)。它是页面自己起的随机串,不含任何个人信息
      const page = pageId ? `&page=${encodeURIComponent(pageId)}` : "";
      const res = await request(`/conversations/${encodeURIComponent(conversationId)}/events?after=${Math.max(0, Math.floor(after))}${page}`, {
        method: "GET",
        signal,
        headers: { Accept: "text/event-stream" },
      });
      const reader = res.body?.getReader();
      if (!reader) throw new CloudError("network", cloudErrorText("network"));
      const decoder = new TextDecoder();
      let buffer = "";
      const stallMs = deps.stallMs ?? EVENTS_STALL_MS;
      /** 读下一块;太久没有任何字节(连 ping 都没有)就当连接半开着断了,抛错让调用方重连 */
      const readChunk = () => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const stalled = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new CloudError("network", cloudErrorText("network"))), stallMs); });
        return Promise.race([reader.read(), stalled]).finally(() => { if (timer !== null) clearTimeout(timer); });
      };
      try {
        for (;;) {
          const { done, value } = await readChunk();
          if (done) break;
          const { events, rest } = parseSseChunks(buffer, decoder.decode(value, { stream: true }));
          buffer = rest;
          for (const ev of events) if (ev && typeof ev === "object" && typeof ev.type === "string") yield ev as CloudEvent;
        }
      } catch (err) {
        if ((err as { name?: string })?.name === "AbortError") return;
        throw err instanceof CloudError ? err : new CloudError("network", cloudErrorText("network"));
      } finally {
        try { await reader.cancel(); } catch { /* 已经关了 */ }
      }
    },
  };
}

export type CloudApi = ReturnType<typeof createCloudApi>;
