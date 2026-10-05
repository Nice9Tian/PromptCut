/**
 * 页面到文档服务的一条**会话**,外加这条会话上的一个 DocSync(c65-design.md 第 4 节「页面一侧」;
 * 会话见 `docs/plan/http-transport-contract.md` 第 3、4、9 节)。
 *
 * - 会话:`server/render-node/session-link.mjs` 的 `createDocEndpoint`,本阶段(HT-a)只走 WebSocket。
 *   一个端点只跑一个会话(`renew: false`):传输断了(换网、代理掐断、休眠)在会话层里接续,未确认的提交与请求
 *   按序补发,这里和 DocSync 都看不见;会话结束(服务端关、保留期内没接续上)才算断线。
 * - 断线与重连:子协议每次建会话之前现取(共享项目的证明里 nonce 只能用一次);断线后按退避重建会话
 *   (0.5 s 起、翻倍、最长 5 s)。建成调 `ds.connect()`(重新 `project.open`、补发没确认的提交),断线调 `ds.disconnect()`。
 * - 分发:`project.*` 交给 DocSync;带 `reqId` 的回包交给等它的 `request()`;其余(`shared.*`、`events.*`、
 *   `error` 等)交给 `onMessage`。
 * - 关闭码 4003(`kicked` / `removed`)、4004(`deleted`)是创建者操作的结果(契约 `auth-contract.md` 第 7 节),
 *   不再重连,由 `onClosed` 告诉界面弹阻断弹窗。传输脱开期间会话因这两个码结束的,会话层把接续得到的 4410
 *   还原成原关闭码报上来(`session-link.mjs` 的 `FINAL_CLOSE`,与本文件的 `FATAL_CLOSE` 一致),界面照样弹。
 *
 * 不认识 store,也不认识界面:浏览器与 Node(测试)通用,WebSocket 可以注入。
 */
import { DocSync, type LocalBackup, type ServerMsg } from "../../store/docsync";
import type { Project } from "../../kernel/project";
// @ts-expect-error 无类型声明的 .mjs(浏览器与 Node 通用,只用 WebSocket 与计时器)
import { createDocEndpoint as createDocEndpointUntyped } from "../../../server/render-node/session-link.mjs";

/** 文档服务发来的任意一条消息 */
export type AnyMsg = { type: string; reqId?: string | number; [k: string]: unknown };

export interface CloseInfo {
  code: number;
  reason: string;
  /** 4003 / 4004:不再重连 */
  fatal: boolean;
  /** 这条连接一次都没连上过(共享项目的握手被拒在浏览器里只看得到这个) */
  neverOpened: boolean;
}

type WsLike = {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "message" | "close" | "error", cb: (ev: unknown) => void): void;
};
type WsCtor = new (url: string, protocols?: string | string[]) => WsLike;

/** 端点的诊断(`createDocEndpoint` 的 `stats()` 里页面用到的部分) */
export interface LinkStats {
  transport: "ws" | "http" | null;
  resumes: number;
  pendingBytes: number;
  legacy: boolean;
  detached: boolean;
  [k: string]: unknown;
}

/** `createDocEndpoint` 返回值里页面用到的部分 */
interface DocEndpoint {
  send(message: object): boolean;
  onMessage(handler: (message: AnyMsg) => void): void;
  onOpen(handler: () => void): void;
  onResume(handler: () => void): void;
  onClose(handler: (info: { code: number; reason: string }) => void): void;
  onConnectFail(handler: (info: { code: number; reason: string }) => void): void;
  close(): void;
  dropTransport(): boolean;
  readonly connected: boolean;
  readonly closed: boolean;
  stats(): LinkStats;
}
const createDocEndpoint = createDocEndpointUntyped as (options: {
  url: string;
  protocols: () => string[];
  resumeProtocols?: () => Promise<string[]> | string[];
  WebSocket?: WsCtor;
  transport: "ws";
  renew: false;
  backoff: { baseMs: number; factor: number; maxMs: number; jitter: number };
  maxPendingBytes: number;
}) => DocEndpoint;

/**
 * 页面未确认出站的上限。契约第 3.4 节给的是 1 MiB;页面的根替换分片上传(`project.upload`,最多 64 片 ×
 * 128 Ki 字符)一口气就发出好几 MiB,第一条确认回来之前就会超过 1 MiB,会话被自己以 1013 结束、重建后重发、
 * 又超 —— 所以页面放宽到 32 MiB(报告 `docs/archive/agent-reports/AGENT-ht-client.md` 写明,待契约定)。
 */
export const PAGE_MAX_PENDING_BYTES = 32 * 1024 * 1024;

export interface LinkOptions {
  docSync?: DocSync;
  initialize?: boolean;
  url: string;
  protocols: () => Promise<string[]> | string[];
  resumeProtocols?: () => Promise<string[]> | string[];
  projectId: string;
  session: string;
  initial: Project;
  saveBackup?: (b: LocalBackup) => void;
  onMessage?: (msg: AnyMsg) => void;
  /** Validate delegated tickets before a caller can use them through a relay. */
  onResponse?: (msg: AnyMsg) => Promise<void>;
  onOpen?: () => void;
  /** 传输断过、在保留期内接续上了(会话没断,不用重新订阅) */
  onResume?: () => void;
  onClosed?: (info: CloseInfo) => void;
  /** 重新取认证证明时接口明确拒绝；返回 true 终止此连接，不再盲目重试。 */
  onProtocolError?: (error: unknown) => boolean;
  WebSocketImpl?: WsCtor;
  reconnect?: { minMs: number; maxMs: number };
}

export const FATAL_CLOSE = new Set([4003, 4004]);

let reqSeq = 0;

export class SyncLink {
  readonly ds: DocSync;
  private readonly o: LinkOptions;
  private ep: DocEndpoint | null = null;
  private dialing = false;
  private open = false;
  private everOpened = false;
  private stopped = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private delay: number;
  private waiting = new Map<string, { resolve: (m: AnyMsg) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(o: LinkOptions) {
    this.o = o;
    this.delay = o.reconnect?.minMs ?? 500;
    this.ds = o.docSync ?? new DocSync(o.initial, {
      projectId: o.projectId,
      session: o.session,
      send: (msg) => this.send(msg as unknown as AnyMsg),
      saveBackup: o.saveBackup,
      initialize: o.initialize,
    });
  }

  /** 会话在(传输脱开、正在接续时也算:这时发的消息接续后补发) */
  get connected(): boolean {
    return this.open;
  }

  get hasOpened(): boolean {
    return this.everOpened;
  }

  /** 诊断:实际用的传输(脱开时为 null)、接续次数、未确认的字节数、是否对着没有会话层的旧服务端 */
  stats(): LinkStats | null {
    return this.ep?.stats() ?? null;
  }

  start() {
    if (this.stopped || this.ep || this.dialing) return;
    void this.dial();
  }

  /** 结束会话、不再重连;等待中的请求全部失败 */
  stop() {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const ep = this.ep;
    this.ep = null;
    if (this.open) {
      this.open = false;
      this.ds.disconnect();
    }
    try {
      ep?.close();
    } catch {
      /* 已经关了 */
    }
    this.failWaiting("连接已关闭");
  }

  /** 发一条;会话不在就丢(DocSync 自己会在重连后补发它的提交) */
  send(msg: AnyMsg): boolean {
    if (!this.ep || !this.open) return false;
    try {
      return this.ep.send(msg) !== false;
    } catch {
      return false;
    }
  }

  /** 发一条带 reqId 的请求,等同一 reqId 的回包(`error` 也算回包) */
  request(msg: AnyMsg, timeoutMs = 10_000): Promise<AnyMsg> {
    const reqId = `r${++reqSeq}`;
    return new Promise((resolve, reject) => {
      if (!this.open) return reject(new Error("没连上文档服务"));
      const timer = setTimeout(() => {
        this.waiting.delete(reqId);
        reject(new Error("文档服务没有回应"));
      }, timeoutMs);
      this.waiting.set(reqId, { resolve, reject, timer });
      if (!this.send({ ...msg, reqId })) {
        clearTimeout(timer);
        this.waiting.delete(reqId);
        reject(new Error("没连上文档服务"));
      }
    });
  }

  /**
   * 测试与演示用:结束当前会话,`ms` 之内不重建(模拟长时间断网:会话没了、DocSync 离线;离线对话框的验收用它)。
   * 只断传输、会话接续的情形用 `cutTransport()`。
   */
  private holdUntil = 0;
  dropFor(ms: number) {
    this.holdUntil = Date.now() + ms;
    const ep = this.ep;
    if (!ep) return;
    try {
      ep.close();
    } catch {
      /* 已经关了 */
    }
    // 会话还没建成时 close() 不报 onClose:这里补上断线处理
    if (this.ep === ep) this.gone(ep, 1000, "drop");
  }

  /** 测试与演示用:只断当前传输(模拟换网、代理掐断),会话在保留期内接续,页面不该丢改动也不该重放。回有没有断 */
  cutTransport(): boolean {
    return this.ep?.dropTransport() ?? false;
  }

  private scheduleRetry() {
    if (this.stopped || this.retryTimer) return;
    const wait = Math.max(this.delay, this.holdUntil - Date.now());
    this.delay = Math.min(this.o.reconnect?.maxMs ?? 5000, this.delay * 2);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.dial();
    }, wait);
  }

  private failWaiting(message: string) {
    for (const [, w] of this.waiting) {
      clearTimeout(w.timer);
      w.reject(new Error(message));
    }
    this.waiting.clear();
  }

  /** 会话结束,或这一次没建成 */
  private gone(ep: DocEndpoint, code: number, reason: string) {
    if (this.ep !== ep) return;
    this.ep = null;
    if (this.open) {
      this.open = false;
      this.ds.disconnect();
    }
    this.failWaiting("连接断了");
    const fatal = FATAL_CLOSE.has(code);
    this.o.onClosed?.({ code, reason, fatal, neverOpened: !this.everOpened });
    if (!fatal) this.scheduleRetry();
    else this.stopped = true;
  }

  private async dial() {
    if (this.stopped || this.ep || this.dialing) return;
    this.dialing = true;
    let protocols: string[];
    try {
      protocols = await this.o.protocols();
    } catch (error) {
      this.dialing = false;
      if (this.stopped) return;
      if (this.o.onProtocolError?.(error)) { this.stop(); return; }
      this.o.onClosed?.({ code: 0, reason: "protocols", fatal: false, neverOpened: !this.everOpened });
      this.scheduleRetry();
      return;
    }
    this.dialing = false;
    if (this.stopped) return;
    let ep: DocEndpoint;
    try {
      ep = createDocEndpoint({
        url: this.o.url,
        protocols: () => protocols,
        resumeProtocols: this.o.resumeProtocols ? async () => {
          try { return await this.o.resumeProtocols!(); }
          catch (error) {
            if (!this.stopped && this.ep === ep && this.o.onProtocolError?.(error)) this.stop();
            throw error;
          }
        } : undefined,
        ...(this.o.WebSocketImpl ? { WebSocket: this.o.WebSocketImpl } : {}),
        transport: "ws",
        renew: false,
        // 同一会话接续的退避;建新会话的退避在本类的 scheduleRetry
        backoff: { baseMs: this.o.reconnect?.minMs ?? 500, factor: 2, maxMs: this.o.reconnect?.maxMs ?? 5000, jitter: 0.2 },
        maxPendingBytes: PAGE_MAX_PENDING_BYTES,
      });
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ep = ep;
    ep.onOpen(() => {
      if (this.ep !== ep || this.stopped) return;
      this.open = true;
      this.everOpened = true;
      this.delay = this.o.reconnect?.minMs ?? 500;
      this.ds.connect();
      this.o.onOpen?.();
    });
    ep.onResume(() => {
      if (this.ep !== ep) return;
      this.o.onResume?.();
    });
    ep.onMessage((msg) => {
      if (this.ep !== ep) return;
      if (!msg || typeof msg.type !== "string") return;
      this.dispatch(msg);
    });
    ep.onClose((info) => this.gone(ep, info.code, info.reason));
    // 建不成(握手被拒、网络不通、取不到子协议):浏览器里分不出前两种,按「一次都没连上过」报给调用方
    ep.onConnectFail((info) => this.gone(ep, info.code === 0 ? 1006 : info.code, info.reason));
  }

  private dispatch(msg: AnyMsg) {
    if (msg.reqId !== undefined) {
      const w = this.waiting.get(String(msg.reqId));
      if (w) {
        this.waiting.delete(String(msg.reqId));
        clearTimeout(w.timer);
        if (this.o.onResponse) void this.o.onResponse(msg).then(() => w.resolve(msg), w.reject);
        else w.resolve(msg);
        // project.* 的回包也要交给 DocSync(它不带 reqId 发,正常不会走到这里)
        if (!msg.type.startsWith("project.")) return;
      }
    }
    if (msg.type.startsWith("project.")) {
      this.ds.receive(msg as unknown as ServerMsg);
      return;
    }
    this.o.onMessage?.(msg);
  }
}
