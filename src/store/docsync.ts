/**
 * 页面到文档服务的同步层(c65-design.md 第 4、6、8 节)。
 *
 * 一个 DocSync 实例 = 一个页面会话对一个项目的副本。它不认识 store,也不认识网络:
 *   - 往外发消息用构造时注入的 `send`;收到的消息由接线的一方调 `receive(msg)` 交进来;
 *   - 连上 / 断开由接线的一方调 `connect()` / `disconnect()` 告诉它;
 *   - 本地副本变了就发 `project` 事件,接 store 的那一侧(`bindStore`)把它写进 state。
 * 测试里用内存假件当文档服务,真连接由后续分支接。
 *
 * 数据流:
 *   - 本地修改:`commit(next)` 算 `diffProject(local, next)`,本地先落地(乐观),进待确认队列,
 *     按顺序提交 `project.op`。本地存的是 `applyOps(local, ops)` 的结果而不是 next 本身,
 *     这样本地副本与文档服务的副本连键的顺序都一样。
 *   - 别人的 `project.ops`:应用到「已确认副本」上,再把还没确认的本地操作重放一遍得到本地副本。
 *     这就是设计稿说的「撤回 - 应用远端 - 重放」,只是撤回不靠逆操作,而是直接从已确认副本重放,
 *     结果与文档服务里的顺序(先远端、后本地)逐字节一致。
 *   - 离线:操作照常落地、进队列;重连后第一条带 `expectRev: offlineRev`,被接受就依次发其余的,
 *     被拒(stale)就整批停下(status = "paused"),等 `replayOffline()` 或 `discardOffline()`。
 *   - `.proc` 保存:`whenSettled()` 等所有本地操作都拿到 ok。
 *   - 撤销:每个实例一个栈,撤销 = 提交逆操作(带 undoOf);这一步之后被别的写入身份改过的实体不撤。
 */
import {
  applyOps,
  diffProject,
  entitiesOf,
  entitiesOverlap,
  entityOfOp,
  entityValuePath,
  getAt,
  type PathOp,
} from "../kernel/diffProject";
import type { Project } from "../kernel/project";
import { attachProjectSync, set, state } from "./core";

/* ---------------- 消息 ---------------- */

/** 写入身份:actor 来自连接凭证(文档服务填),session 是页面会话或 Agent 对话号 */
export interface Writer {
  actor?: unknown;
  session?: string;
}

export interface OpenMsg {
  type: "project.open";
  projectId: string;
}

export interface OpMsg {
  type: "project.op";
  projectId: string;
  opId: string;
  session: string;
  ops: PathOp[];
  expectRev?: number;
  undoOf?: string;
}

export type ClientMsg = OpenMsg | OpMsg;

export interface StateMsg {
  type: "project.state";
  projectId?: string;
  rev: number;
  /** 大项目不带 project、带 parts(分片数),随后是 project.state.part / project.state.end */
  project?: Project | null;
  parts?: number;
  writers?: unknown;
}

export interface StatePartMsg {
  type: "project.state.part";
  projectId?: string;
  rev: number;
  index: number;
  count: number;
  data: string;
}

export interface StateEndMsg {
  type: "project.state.end";
  projectId?: string;
  rev: number;
  digest?: string;
}

export interface OkMsg {
  type: "project.op.ok";
  opId: string;
  rev: number;
  overwrote?: { entity: string; by: Writer }[];
}

export interface SinceEntry {
  rev: number;
  actor?: unknown;
  session?: string;
  paths?: string[];
}

export interface RejectedMsg {
  type: "project.op.rejected";
  opId: string;
  reason: "stale" | "bad-path" | "too-large" | "forbidden" | string;
  currentRev?: number;
  since?: SinceEntry[];
}

export interface OpsMsg {
  type: "project.ops";
  rev: number;
  opId: string;
  /** 上传引用的大根替换广播时不带 ops、带 resync: true,页面重新 open */
  ops?: PathOp[];
  resync?: boolean;
  actor?: unknown;
  session?: string;
  undoOf?: string;
}

export interface OverwrittenMsg {
  type: "project.overwritten";
  entity: string;
  by: Writer;
  rev: number;
}

export type ServerMsg = StateMsg | StatePartMsg | StateEndMsg | OkMsg | RejectedMsg | OpsMsg | OverwrittenMsg;

/* ---------------- 对外的状态与通知 ---------------- */

/**
 * idle:还没连;connecting:发了 open 在等 project.state;online:正常;
 * offline:断线,操作进队列;paused:离线批次的第一条被拒,等用户选「重放 / 丢弃」
 */
export type SyncStatus = "idle" | "connecting" | "online" | "offline" | "paused";

export interface SkippedEntity {
  entity: string;
  /** 这一步之后改过它的写入身份(最近的那一个) */
  by: Writer;
}

export interface UndoResult {
  /** 至少撤了一处 */
  done: boolean;
  /** 因为别的写入身份后来改过而没撤的实体 */
  skipped: SkippedEntity[];
  /** 逆操作落不下去(比如父级已被删)而没撤的实体 */
  failed: string[];
  /** 这次撤销 / 重做提交的 opId;done 为 false 时没有 */
  opId?: string;
}

export type SyncNotice =
  | { kind: "rejected"; opId: string; reason: string }
  | { kind: "replay-dropped"; opId: string; detail: string }
  | { kind: "overwrote"; opId: string; entities: { entity: string; by: Writer }[] }
  | { kind: "overwritten"; entity: string; by: Writer; rev: number }
  | { kind: "undo"; redo: boolean; result: UndoResult }
  | { kind: "resync"; reason: string };

/** 本地备份:被覆盖的实体、或被丢弃的离线批次。由接线的一方落盘(草稿目录下 backups/) */
export type LocalBackup =
  | { kind: "overwritten"; projectId: string; entity: string; by: Writer; rev: number; value: unknown; at: number }
  | { kind: "offline-discard"; projectId: string; baseRev: number; batch: { opId: string; ops: PathOp[] }[]; project: Project; at: number };

export interface PausedInfo {
  /** 离线时记下的版本 */
  offlineRev: number;
  /** 文档服务当前的版本 */
  currentRev?: number;
  /** 离线期间别人落地的改动 */
  since?: SinceEntry[];
  /** 攒着没发的本地操作条数 */
  queued: number;
}

export interface CommitOptions {
  /** false:不进撤销栈(素材元数据回填、总时长跟随等) */
  undoable?: boolean;
  /** 数字框连续输入:同一个 key、300 ms 内的提交合并成撤销栈上的一步 */
  mergeKey?: string;
}

export interface DocSyncOptions {
  projectId: string;
  /** 这个页面会话的 id,写进每次提交 */
  session: string;
  send: (msg: ClientMsg) => void;
  newOpId?: () => string;
  now?: () => number;
  saveBackup?: (backup: LocalBackup) => void;
}

/* ---------------- 内部 ---------------- */

interface Pending {
  opId: string;
  ops: PathOp[];
  inverse: PathOp[];
  undoOf?: string;
  sent: boolean;
  /** 拿到 ok 但还没并进已确认副本(在等 project.state 时) */
  ackRev?: number;
  /** 已发出、但在最新的已确认副本上重放失败 —— 文档服务那边也会拒 */
  brokenLocally?: boolean;
}

interface Step {
  opIds: string[];
  /** 撤这一步要应用的操作(按顺序) */
  inverse: PathOp[];
  entities: string[];
  /** 这一步第一条提交落地的版本;还没确认时为 undefined */
  rev?: number;
  mergeKey?: string;
  lastAt: number;
}

interface RemoteWrite {
  rev: number;
  by: Writer;
  entities: string[];
}

type Events = {
  project: (project: Project, cause: "commit" | "remote" | "state" | "rejected" | "undo" | "redo" | "discard" | "replay" | "load") => void;
  status: (status: SyncStatus) => void;
  notice: (notice: SyncNotice) => void;
};

export const UNDO_LIMIT = 100;
export const MERGE_WINDOW_MS = 300;
const BEFORE_REMOTE_KEEP = 32;

let opSeq = 0;
function defaultOpId(session: string): string {
  opSeq++;
  const rand = globalThis.crypto?.randomUUID?.().slice(0, 8) ?? Math.random().toString(36).slice(2, 10);
  return `${session}:${Date.now().toString(36)}:${opSeq.toString(36)}:${rand}`;
}

export class DocSync {
  readonly projectId: string;
  readonly session: string;
  private readonly sendMsg: (msg: ClientMsg) => void;
  private readonly newOpId: () => string;
  private readonly now: () => number;
  private readonly saveBackup?: (backup: LocalBackup) => void;

  private local: Project;
  private confirmed: Project | null = null;
  private confirmedRev = 0;
  private pending: Pending[] = [];

  private connected = false;
  private awaitingState = false;
  /** 断线时最后知道的版本;没有离线批次时为 null */
  private offlineRev: number | null = null;
  /** 离线批次的第一条已发出、在等它的回音;这期间其余的不发 */
  private gateOpId: string | null = null;
  private paused: PausedInfo | null = null;

  private undoStack: Step[] = [];
  private redoStack: Step[] = [];
  private stepOf = new Map<string, Step>();
  private remoteWrites: RemoteWrite[] = [];
  /** rev → 应用这次远端改动之前的本地副本,给覆盖备份用 */
  private beforeRemote = new Map<number, Project>();

  private listeners: { [K in keyof Events]: Set<Events[K]> } = { project: new Set(), status: new Set(), notice: new Set() };
  private settleWaiters: { resolve: (v: { rev: number; project: Project }) => void; reject: (e: Error) => void; timer?: ReturnType<typeof setTimeout> }[] = [];

  constructor(initial: Project, opts: DocSyncOptions) {
    this.local = initial;
    this.projectId = opts.projectId;
    this.session = opts.session;
    this.sendMsg = opts.send;
    this.newOpId = opts.newOpId ?? (() => defaultOpId(opts.session));
    this.now = opts.now ?? (() => Date.now());
    this.saveBackup = opts.saveBackup;
  }

  /* ---------- 读 ---------- */

  get project(): Project {
    return this.local;
  }

  /** 文档服务确认过的版本号 */
  get rev(): number {
    return this.confirmedRev;
  }

  get status(): SyncStatus {
    if (this.paused) return "paused";
    if (!this.connected) return this.confirmed || this.offlineRev !== null ? "offline" : "idle";
    if (this.awaitingState) return "connecting";
    return "online";
  }

  get pausedInfo(): PausedInfo | null {
    return this.paused ? { ...this.paused, queued: this.pending.length } : null;
  }

  /** 还没拿到 ok 的本地提交条数 */
  get unconfirmed(): number {
    return this.pending.length;
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  on<K extends keyof Events>(event: K, cb: Events[K]): () => void {
    (this.listeners[event] as Set<Events[K]>).add(cb);
    return () => {
      (this.listeners[event] as Set<Events[K]>).delete(cb);
    };
  }

  private emit<K extends keyof Events>(event: K, ...args: Parameters<Events[K]>) {
    for (const cb of this.listeners[event] as Set<(...a: Parameters<Events[K]>) => void>) cb(...args);
  }

  private setLocal(p: Project, cause: Parameters<Events["project"]>[1]) {
    if (p === this.local) return;
    this.local = p;
    this.emit("project", p, cause);
  }

  private statusChanged(before: SyncStatus) {
    const after = this.status;
    if (after !== before) this.emit("status", after);
  }

  /* ---------- 连接 ---------- */

  /** 连上了(或重连上了):发 project.open,等 project.state */
  connect() {
    const before = this.status;
    this.connected = true;
    this.awaitingState = true;
    this.partial = null;
    this.sendMsg({ type: "project.open", projectId: this.projectId });
    this.statusChanged(before);
  }

  /** 断了:在途的提交当没发(重连后用原 opId 重发,文档服务按 opId 去重) */
  disconnect() {
    if (!this.connected) return;
    const before = this.status;
    this.connected = false;
    this.awaitingState = false;
    this.partial = null;
    if (this.confirmed && this.offlineRev === null) this.offlineRev = this.confirmedRev;
    this.gateOpId = null;
    for (const p of this.pending) if (p.ackRev === undefined) p.sent = false;
    this.statusChanged(before);
  }

  /** 收到文档服务的一条消息 */
  receive(msg: ServerMsg) {
    const before = this.status;
    switch (msg.type) {
      case "project.state":
        if (msg.project === undefined && typeof msg.parts === "number") this.onStateStart(msg);
        else this.onState(msg);
        break;
      case "project.state.part":
        this.onStatePart(msg);
        break;
      case "project.state.end":
        this.onStateEnd(msg);
        break;
      case "project.ops":
        this.onOps(msg);
        break;
      case "project.op.ok":
        this.onOk(msg);
        break;
      case "project.op.rejected":
        this.onRejected(msg);
        break;
      case "project.overwritten":
        this.onOverwritten(msg);
        break;
    }
    this.statusChanged(before);
    this.checkSettled();
  }

  private resync(reason: string) {
    this.emit("notice", { kind: "resync", reason });
    if (!this.connected) return;
    this.awaitingState = true;
    this.partial = null;
    this.sendMsg({ type: "project.open", projectId: this.projectId });
  }

  private onState(msg: StateMsg) {
    if (!this.awaitingState) return;
    this.awaitingState = false;
    if (this.gateOpId) {
      // 离线批次的第一条还没回音就重新同步了:按没发处理,下面重新试
      const g = this.pending.find((p) => p.opId === this.gateOpId);
      if (g && g.ackRev === undefined) g.sent = false;
      this.gateOpId = null;
    }
    if (msg.project == null) {
      // 文档服务还没有这个项目:把本地这一份(连同还没确认的修改)以根替换写进去
      const seed: Pending = { opId: this.newOpId(), ops: [{ op: "set", path: "", value: this.local }], inverse: [], sent: false };
      for (const p of this.pending) {
        const step = this.stepOf.get(p.opId);
        if (step) this.stepOf.set(seed.opId, step);
      }
      this.pending = [seed];
      this.confirmed = null;
      this.confirmedRev = msg.rev;
      this.offlineRev = null;
      this.flush();
      return;
    }
    // 已经在这份快照里的(拿过 ok、rev 不超过快照)不再重放
    this.pending = this.pending.filter((p) => p.ackRev === undefined || p.ackRev > msg.rev);
    this.confirmed = msg.project;
    this.confirmedRev = msg.rev;
    this.beforeRemote.clear();
    const hasBacklog = this.offlineRev !== null && this.pending.some((p) => !p.sent);
    if (hasBacklog && !this.paused) {
      // 离线批次:本地副本先不动,第一条带 offlineRev 去试
      this.sendGate();
      return;
    }
    if (this.paused) return;
    this.offlineRev = null;
    this.setLocal(this.pending.length ? this.replay(this.confirmed) : this.confirmed, "state");
    this.flush();
  }

  /** 分片接收中的快照:拼完之前到的 project.ops(rev 大于快照的)先攒着 */
  private partial: { rev: number; count: number; chunks: string[]; buffered: OpsMsg[] } | null = null;

  private onStateStart(msg: StateMsg) {
    if (!this.awaitingState) return;
    this.partial = { rev: msg.rev, count: msg.parts!, chunks: [], buffered: [] };
  }

  private onStatePart(msg: StatePartMsg) {
    if (!this.partial || msg.rev !== this.partial.rev) return;
    this.partial.chunks[msg.index] = msg.data;
  }

  private onStateEnd(msg: StateEndMsg) {
    const part = this.partial;
    if (!part || msg.rev !== part.rev) return;
    this.partial = null;
    let project: Project;
    try {
      if (part.chunks.length !== part.count || part.chunks.some((c) => typeof c !== "string")) throw new Error("分片不全");
      project = JSON.parse(part.chunks.join(""));
    } catch (e) {
      this.resync(`项目分片拼不起来:${(e as Error).message}`);
      return;
    }
    this.onState({ type: "project.state", rev: part.rev, project });
    for (const m of part.buffered) this.onOps(m);
  }

  private onOps(msg: OpsMsg) {
    // 文档服务不回发给提交者;万一回发了,当 ok 处理
    if (this.pending.some((p) => p.opId === msg.opId)) {
      this.onOk({ type: "project.op.ok", opId: msg.opId, rev: msg.rev });
      return;
    }
    if (this.partial) {
      if (msg.rev > this.partial.rev) this.partial.buffered.push(msg);
      return;
    }
    if (this.awaitingState || !this.confirmed) return;
    if (msg.rev <= this.confirmedRev) return;
    if (msg.resync || !Array.isArray(msg.ops)) {
      this.resync("远端的大根替换没带操作,重新打开");
      return;
    }
    if (msg.rev !== this.confirmedRev + 1) {
      this.resync(`版本跳号:本地 ${this.confirmedRev},收到 ${msg.rev}`);
      return;
    }
    const r = applyOps(this.confirmed, msg.ops);
    if (!r.ok) {
      this.resync(`远端操作在已确认副本上落不下去:${r.detail}`);
      return;
    }
    this.confirmed = r.value;
    this.confirmedRev = msg.rev;
    const by: Writer = { actor: msg.actor, session: msg.session ?? (msg.actor as { session?: string } | undefined)?.session };
    this.remoteWrites.push({ rev: msg.rev, by, entities: entitiesOf(msg.ops) });
    this.pruneRemoteWrites();
    this.beforeRemote.set(msg.rev, this.local);
    if (this.beforeRemote.size > BEFORE_REMOTE_KEEP) this.beforeRemote.delete(this.beforeRemote.keys().next().value!);

    // 离线批次在等回音、或已暂停:本地副本先不动
    if (this.gateOpId || this.paused) return;
    if (this.pending.length === 0) {
      // 没有未确认的:直接在本地副本上应用,与已确认副本合成同一棵树
      const r2 = applyOps(this.local, msg.ops);
      if (r2.ok) {
        this.confirmed = r2.value;
        this.setLocal(r2.value, "remote");
      } else {
        this.setLocal(this.confirmed, "remote");
      }
      return;
    }
    this.setLocal(this.replay(this.confirmed), "remote");
  }

  private onOk(msg: OkMsg) {
    const idx = this.pending.findIndex((p) => p.opId === msg.opId);
    if (idx < 0) return;
    const entry = this.pending[idx];
    const step = this.stepOf.get(entry.opId);
    if (step && step.rev === undefined) step.rev = msg.rev;
    if (msg.overwrote?.length) this.emit("notice", { kind: "overwrote", opId: entry.opId, entities: msg.overwrote });

    if (this.awaitingState) {
      entry.ackRev = msg.rev;
      return;
    }
    if (msg.rev <= this.confirmedRev) {
      // 重发的提交其实早已落地(已经含在快照里):去掉,不再应用
      this.pending.splice(idx, 1);
      if (this.gateOpId === entry.opId) this.openGate();
      else if (!this.gateOpId && !this.paused && this.confirmed) this.setLocal(this.replay(this.confirmed), "commit");
      return;
    }
    if (idx !== 0 || msg.rev !== this.confirmedRev + 1 || entry.brokenLocally) {
      this.resync(`确认乱序或与本地不一致:${entry.opId} rev ${msg.rev}`);
      return;
    }
    if (this.confirmed === null) {
      // 根替换建项目
      const r0 = applyOps({} as Project, entry.ops);
      if (!r0.ok) return this.resync("建项目的根替换落不下去");
      this.confirmed = r0.value;
    } else {
      const r = applyOps(this.confirmed, entry.ops);
      if (!r.ok) {
        this.resync(`已确认的提交在已确认副本上落不下去:${r.detail}`);
        return;
      }
      this.confirmed = r.value;
    }
    this.confirmedRev = msg.rev;
    this.pending.shift();
    if (this.gateOpId === entry.opId) {
      this.openGate();
      return;
    }
    // 全部确认完:本地副本就是已确认副本,并成同一棵树
    if (this.pending.length === 0 && !this.paused && !this.gateOpId) this.confirmed = this.local;
  }

  private onRejected(msg: RejectedMsg) {
    const idx = this.pending.findIndex((p) => p.opId === msg.opId);
    if (idx < 0) return;
    const entry = this.pending[idx];
    if (msg.reason === "stale" && this.gateOpId === entry.opId) {
      entry.sent = false;
      this.gateOpId = null;
      this.paused = { offlineRev: this.offlineRev ?? this.confirmedRev, currentRev: msg.currentRev, since: msg.since, queued: this.pending.length };
      return;
    }
    this.pending.splice(idx, 1);
    this.dropSteps([entry.opId]);
    this.emit("notice", { kind: "rejected", opId: entry.opId, reason: msg.reason });
    if (this.gateOpId === entry.opId) {
      // 离线批次的第一条因为别的原因被拒:下一条接着当「第一条」去试
      this.gateOpId = null;
      this.sendGate();
      return;
    }
    if (this.confirmed && !this.paused && !this.gateOpId) this.setLocal(this.replay(this.confirmed), "rejected");
  }

  private onOverwritten(msg: OverwrittenMsg) {
    // 先把自己那一版的该实体存成本地备份,再(或已经)换成新版本
    const mine = this.beforeRemote.get(msg.rev) ?? this.local;
    this.saveBackup?.({ kind: "overwritten", projectId: this.projectId, entity: msg.entity, by: msg.by, rev: msg.rev, value: getAt(mine, entityValuePath(msg.entity)), at: this.now() });
    this.emit("notice", { kind: "overwritten", entity: msg.entity, by: msg.by, rev: msg.rev });
  }

  /* ---------- 离线批次 ---------- */

  private sendGate() {
    const first = this.pending.find((p) => !p.sent);
    if (!first || !this.connected || this.awaitingState) {
      if (!first) this.openGate();
      return;
    }
    this.gateOpId = first.opId;
    first.sent = true;
    this.sendOp(first, this.offlineRev ?? this.confirmedRev);
  }

  private openGate() {
    this.gateOpId = null;
    this.offlineRev = null;
    if (this.confirmed) this.setLocal(this.pending.length ? this.replay(this.confirmed) : this.confirmed, "replay");
    this.flush();
  }

  /** 离线批次被拒后,用户选「重放」:去掉期望版本,依次提交 */
  replayOffline() {
    if (!this.paused) return;
    const before = this.status;
    this.paused = null;
    this.offlineRev = null;
    if (this.confirmed) this.setLocal(this.replay(this.confirmed), "replay");
    this.flush();
    this.statusChanged(before);
    this.checkSettled();
  }

  /** 离线批次被拒后,用户选「丢弃」:先把这批存成本地备份,再回到文档服务的版本 */
  discardOffline() {
    if (!this.paused) return;
    const before = this.status;
    const batch = this.pending.map((p) => ({ opId: p.opId, ops: p.ops }));
    this.saveBackup?.({ kind: "offline-discard", projectId: this.projectId, baseRev: this.paused.offlineRev, batch, project: this.local, at: this.now() });
    this.dropSteps(batch.map((b) => b.opId));
    this.redoStack = [];
    this.pending = [];
    this.paused = null;
    this.offlineRev = null;
    if (this.confirmed) this.setLocal(this.confirmed, "discard");
    this.statusChanged(before);
    this.checkSettled();
  }

  /* ---------- 本地修改 ---------- */

  /**
   * 本地改成 next:算差异、乐观落地、进队列并尽量发出。
   * 返回落地后的本地副本(键的顺序以它为准),调用方把它写进 store。
   */
  commit(next: Project, opts: CommitOptions = {}): Project {
    return this.commitInternal(next, opts, undefined, undefined);
  }

  /** 载入另一份内容(打开旧 .proc、Skill 合并结果):一次根替换,清空撤销栈 */
  load(next: Project): Project {
    this.undoStack = [];
    this.redoStack = [];
    this.stepOf.clear();
    const entry: Pending = { opId: this.newOpId(), ops: [{ op: "set", path: "", value: next }], inverse: [{ op: "set", path: "", value: this.local }], sent: false };
    this.pending.push(entry);
    this.setLocal(next, "load");
    this.flush();
    return this.local;
  }

  private commitInternal(next: Project, opts: CommitOptions, undoOf: string | undefined, target: "undo" | "redo" | undefined): Project {
    const prev = this.local;
    const d = diffProject(prev, next);
    if (d.ops.length === 0) return prev;
    const r = applyOps(prev, d.ops);
    if (!r.ok) throw new Error(`diffProject 产出的操作落不下去:${r.detail}`);
    const entry: Pending = { opId: this.newOpId(), ops: d.ops, inverse: d.inverse, undoOf, sent: false };
    this.pending.push(entry);
    const now = this.now();
    if (target) {
      // 撤销 / 重做本身:它的逆操作进对面的栈
      const step: Step = { opIds: [entry.opId], inverse: d.inverse, entities: entitiesOf(d.ops), lastAt: now };
      this.stepOf.set(entry.opId, step);
      const stack = target === "undo" ? this.redoStack : this.undoStack;
      stack.push(step);
      if (stack.length > UNDO_LIMIT) stack.shift();
    } else if (opts.undoable !== false) {
      const top = this.undoStack[this.undoStack.length - 1];
      if (opts.mergeKey && top && top.mergeKey === opts.mergeKey && now - top.lastAt <= MERGE_WINDOW_MS && this.redoStack.length === 0) {
        top.opIds.push(entry.opId);
        top.inverse = [...d.inverse, ...top.inverse];
        for (const e of entitiesOf(d.ops)) if (!top.entities.includes(e)) top.entities.push(e);
        top.lastAt = now;
        this.stepOf.set(entry.opId, top);
      } else {
        const step: Step = { opIds: [entry.opId], inverse: d.inverse, entities: entitiesOf(d.ops), mergeKey: opts.mergeKey, lastAt: now };
        this.stepOf.set(entry.opId, step);
        this.undoStack.push(step);
        if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
      }
      this.redoStack = [];
    }
    this.setLocal(r.value, target ?? "commit");
    this.flush();
    return this.local;
  }

  private sendOp(p: Pending, expectRev?: number) {
    const msg: OpMsg = { type: "project.op", projectId: this.projectId, opId: p.opId, session: this.session, ops: p.ops };
    if (expectRev !== undefined) msg.expectRev = expectRev;
    if (p.undoOf) msg.undoOf = p.undoOf;
    this.sendMsg(msg);
  }

  /** 能发就按顺序把没发的都发出去 */
  private flush() {
    if (!this.connected || this.awaitingState || this.gateOpId || this.paused) return;
    for (const p of this.pending) {
      if (p.sent) continue;
      p.sent = true;
      this.sendOp(p);
    }
  }

  /** 在已确认副本上依次重放未确认的本地操作;没发出去又落不下去的直接丢掉 */
  private replay(base: Project): Project {
    let cur = base;
    const dropped: string[] = [];
    for (const p of this.pending) {
      if (p.ackRev !== undefined && p.ackRev <= this.confirmedRev) continue;
      const r = applyOps(cur, p.ops);
      if (r.ok) {
        cur = r.value;
        p.brokenLocally = false;
      } else if (!p.sent) {
        dropped.push(p.opId);
        this.emit("notice", { kind: "replay-dropped", opId: p.opId, detail: r.detail });
      } else {
        p.brokenLocally = true;
      }
    }
    if (dropped.length) {
      this.pending = this.pending.filter((p) => !dropped.includes(p.opId));
      this.dropSteps(dropped);
    }
    return cur;
  }

  /** 这些提交作废了:含它们的撤销步整步拿掉(逆操作已经对不上了) */
  private dropSteps(opIds: string[]) {
    const gone = new Set(opIds);
    const keep = (s: Step) => !s.opIds.some((id) => gone.has(id));
    this.undoStack = this.undoStack.filter(keep);
    this.redoStack = this.redoStack.filter(keep);
    for (const id of opIds) this.stepOf.delete(id);
  }

  /* ---------- 撤销 / 重做 ---------- */

  undo(): UndoResult | null {
    const step = this.undoStack.pop();
    if (!step) return null;
    return this.revert(step, "undo");
  }

  redo(): UndoResult | null {
    const step = this.redoStack.pop();
    if (!step) return null;
    return this.revert(step, "redo");
  }

  /** 这一步之后被别的写入身份改过的实体 → 最近改它的是谁 */
  private conflictsFor(step: Step): Map<string, Writer> {
    const out = new Map<string, Writer>();
    if (step.rev === undefined) return out; // 还没确认:之后收到的远端改动都排在它前面
    for (const w of this.remoteWrites) {
      if (w.rev <= step.rev) continue;
      for (const e of step.entities) if (w.entities.some((x) => entitiesOverlap(x, e))) out.set(e, w.by);
    }
    return out;
  }

  private revert(step: Step, kind: "undo" | "redo"): UndoResult {
    const blocked = this.conflictsFor(step);
    const skipped: SkippedEntity[] = [...blocked].map(([entity, by]) => ({ entity, by }));
    const allowed = step.inverse.filter((op) => !blocked.has(entityOfOp(op)));
    const failed: string[] = [];
    let candidate = this.local;
    if (allowed.length) {
      const all = applyOps(candidate, allowed);
      if (all.ok) candidate = all.value;
      else {
        // 整批落不下:按实体分组逐组试,落不下的那组记为没撤成
        const groups = new Map<string, PathOp[]>();
        for (const op of allowed) {
          const e = entityOfOp(op);
          if (!groups.has(e)) groups.set(e, []);
          groups.get(e)!.push(op);
        }
        for (const [e, ops] of groups) {
          const r = applyOps(candidate, ops);
          if (r.ok) candidate = r.value;
          else failed.push(e);
        }
      }
    }
    for (const id of step.opIds) this.stepOf.delete(id);
    let result: UndoResult;
    if (candidate === this.local) {
      // 一处都没撤成:出栈,也不进对面的栈(c65-design.md 第 8 节裁定)
      result = { done: false, skipped, failed };
    } else {
      const undoOf = step.opIds[step.opIds.length - 1];
      const before = this.pending.length;
      this.commitInternal(candidate, { undoable: false }, undoOf, kind);
      const opId = this.pending.length > before ? this.pending[this.pending.length - 1].opId : undefined;
      result = { done: opId !== undefined, skipped, failed, opId };
    }
    this.emit("notice", { kind: "undo", redo: kind === "redo", result });
    return result;
  }

  private pruneRemoteWrites() {
    if (this.remoteWrites.length < 256) return;
    let min = this.confirmedRev;
    for (const s of [...this.undoStack, ...this.redoStack]) if (s.rev !== undefined && s.rev < min) min = s.rev;
    this.remoteWrites = this.remoteWrites.filter((w) => w.rev > min);
  }

  /* ---------- 保存 ---------- */

  private isSettled(): boolean {
    return this.connected && !this.awaitingState && !this.paused && !this.gateOpId && this.pending.length === 0 && this.confirmed !== null;
  }

  /**
   * 等所有本地操作都拿到 ok(`.proc` 只在这之后写)。返回文档服务确认过的版本号和那一版内容。
   * 超时(缺省不超时)就 reject,调用方提示用户。
   */
  whenSettled(opts: { timeoutMs?: number } = {}): Promise<{ rev: number; project: Project }> {
    if (this.isSettled()) return Promise.resolve({ rev: this.confirmedRev, project: this.confirmed! });
    return new Promise((resolve, reject) => {
      const w: (typeof this.settleWaiters)[number] = { resolve, reject };
      if (opts.timeoutMs !== undefined) {
        w.timer = setTimeout(() => {
          this.settleWaiters = this.settleWaiters.filter((x) => x !== w);
          reject(new Error(`等文档服务确认超时(还有 ${this.pending.length} 条没确认,状态 ${this.status})`));
        }, opts.timeoutMs);
      }
      this.settleWaiters.push(w);
    });
  }

  private checkSettled() {
    if (!this.settleWaiters.length || !this.isSettled()) return;
    const waiters = this.settleWaiters;
    this.settleWaiters = [];
    for (const w of waiters) {
      if (w.timer) clearTimeout(w.timer);
      w.resolve({ rev: this.confirmedRev, project: this.confirmed! });
    }
  }
}

/* ---------------- 接 store ---------------- */

/**
 * 把一个 DocSync 接到编辑器 store 上:setProject / loadProject / undo / redo / canUndo / canRedo
 * 改由它接管,别人的改动写进 state(不进撤销栈、不回发)。返回解绑函数,解绑后回到快照栈模式。
 *
 * 换项目(另一个 projectId)时先解绑、再为新项目建一个 DocSync;`loadProject` 在接着的时候
 * 是对**当前这个项目**的一次根替换。
 */
export function bindStore(ds: DocSync): () => void {
  if (ds.project !== state.project) {
    // DocSync 应以 store 里的那一份建;不是的话以 DocSync 为准
    set({ project: ds.project });
  }
  attachProjectSync({
    commit: (_prev, next, opts) => ds.commit(next, opts),
    load: (project) => ds.load(project),
    undo: () => void ds.undo(),
    redo: () => void ds.redo(),
    canUndo: () => ds.canUndo(),
    canRedo: () => ds.canRedo(),
  });
  const off = ds.on("project", (project, cause) => {
    // commit / load 由 setProject / loadProject 自己写进 state
    if (cause === "commit" || cause === "load") return;
    if (project !== state.project) set({ project, dirty: true });
  });
  return () => {
    off();
    attachProjectSync(null);
  };
}
