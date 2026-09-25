/**
 * 页面到文档服务的一条 WebSocket 连接,外加这条连接上的一个 DocSync(c65-design.md 第 4 节「页面一侧」)。
 *
 * - 连接:`new WebSocket(url, protocols())`,子协议每次连之前现取(共享项目的证明里 nonce 只能用一次);
 *   断了按退避重连(0.5 s 起、翻倍、最长 5 s)。连上调 `ds.connect()`,断了调 `ds.disconnect()`。
 * - 分发:`project.*` 交给 DocSync;带 `reqId` 的回包交给等它的 `request()`;其余(`shared.*`、`events.*`、
 *   `error` 等)交给 `onMessage`。
 * - 关闭码 4003(`kicked` / `removed`)、4004(`deleted`)是创建者操作的结果(契约 `auth-contract.md` 第 7 节),
 *   不再重连,由 `onClosed` 告诉界面弹阻断弹窗。
 *
 * 不认识 store,也不认识界面:浏览器与 Node(测试)通用,WebSocket 可以注入。
 */
import { DocSync, type LocalBackup, type ServerMsg } from "../../store/docsync";
import type { Project } from "../../kernel/project";

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

export interface LinkOptions {
  url: string;
  protocols: () => Promise<string[]> | string[];
  projectId: string;
  session: string;
  initial: Project;
  saveBackup?: (b: LocalBackup) => void;
  onMessage?: (msg: AnyMsg) => void;
  onOpen?: () => void;
  onClosed?: (info: CloseInfo) => void;
  WebSocketImpl?: WsCtor;
  reconnect?: { minMs: number; maxMs: number };
}

export const FATAL_CLOSE = new Set([4003, 4004]);

let reqSeq = 0;

export class SyncLink {
  readonly ds: DocSync;
  private readonly o: LinkOptions;
  private ws: WsLike | null = null;
  private open = false;
  private everOpened = false;
  private stopped = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private delay: number;
  private waiting = new Map<string, { resolve: (m: AnyMsg) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(o: LinkOptions) {
    this.o = o;
    this.delay = o.reconnect?.minMs ?? 500;
    this.ds = new DocSync(o.initial, {
      projectId: o.projectId,
      session: o.session,
      send: (msg) => this.send(msg as unknown as AnyMsg),
      saveBackup: o.saveBackup,
    });
  }

  get connected(): boolean {
    return this.open;
  }

  get hasOpened(): boolean {
    return this.everOpened;
  }

  start() {
    if (this.stopped || this.ws) return;
    void this.dial();
  }

  /** 关连接、不再重连;等待中的请求全部失败 */
  stop() {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const ws = this.ws;
    this.ws = null;
    if (this.open) {
      this.open = false;
      this.ds.disconnect();
    }
    try {
      ws?.close(1000, "bye");
    } catch {
      /* 已经关了 */
    }
    for (const [, w] of this.waiting) {
      clearTimeout(w.timer);
      w.reject(new Error("连接已关闭"));
    }
    this.waiting.clear();
  }

  /** 发一条;没连上就丢(DocSync 自己会在重连后补发它的提交) */
  send(msg: AnyMsg): boolean {
    if (!this.ws || !this.open) return false;
    try {
      this.ws.send(JSON.stringify(msg));
      return true;
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

  private scheduleRetry() {
    if (this.stopped || this.retryTimer) return;
    const wait = this.delay;
    this.delay = Math.min(this.o.reconnect?.maxMs ?? 5000, this.delay * 2);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.dial();
    }, wait);
  }

  private async dial() {
    if (this.stopped) return;
    let protocols: string[];
    try {
      protocols = await this.o.protocols();
    } catch {
      this.o.onClosed?.({ code: 0, reason: "protocols", fatal: false, neverOpened: !this.everOpened });
      this.scheduleRetry();
      return;
    }
    if (this.stopped) return;
    const Impl = this.o.WebSocketImpl ?? (globalThis.WebSocket as unknown as WsCtor);
    let sock: WsLike;
    try {
      sock = new Impl(this.o.url, protocols);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = sock;
    let done = false;
    const onGone = (code: number, reason: string) => {
      if (done) return;
      done = true;
      if (this.ws !== sock) return;
      this.ws = null;
      const wasOpen = this.open;
      if (wasOpen) {
        this.open = false;
        this.ds.disconnect();
      }
      for (const [, w] of this.waiting) {
        clearTimeout(w.timer);
        w.reject(new Error("连接断了"));
      }
      this.waiting.clear();
      const fatal = FATAL_CLOSE.has(code);
      this.o.onClosed?.({ code, reason, fatal, neverOpened: !this.everOpened });
      if (!fatal) this.scheduleRetry();
      else this.stopped = true;
    };
    sock.addEventListener("open", () => {
      if (this.ws !== sock || this.stopped) return;
      this.open = true;
      this.everOpened = true;
      this.delay = this.o.reconnect?.minMs ?? 500;
      this.ds.connect();
      this.o.onOpen?.();
    });
    sock.addEventListener("message", (ev) => {
      if (this.ws !== sock) return;
      let msg: AnyMsg;
      try {
        msg = JSON.parse(String((ev as { data: unknown }).data));
      } catch {
        return;
      }
      if (!msg || typeof msg.type !== "string") return;
      this.dispatch(msg);
    });
    sock.addEventListener("close", (ev) => {
      const e = ev as { code?: number; reason?: string };
      onGone(e.code ?? 1006, e.reason ?? "");
    });
    sock.addEventListener("error", () => {
      // 浏览器里 error 之后总会有 close;Node 的实现也一样。这里什么都不做,等 close
    });
  }

  private dispatch(msg: AnyMsg) {
    if (msg.reqId !== undefined) {
      const w = this.waiting.get(String(msg.reqId));
      if (w) {
        this.waiting.delete(String(msg.reqId));
        clearTimeout(w.timer);
        w.resolve(msg);
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
