/**
 * 项目版本模块（契约 `docs/plan/docservice-contract.md` 第 1 节），以及 M5b 的项目快照
 * （`docs/plan/render-queue-contract.md` J.1）。
 *
 * 页面每次改完项目，把项目内容的摘要报上来（`project.announce`）；摘要变了，本模块就发下一个 `projectRev`、
 * 记一行版本日志，并在 `project:<projectId>` 频道上广播 `project.rev`。打开项目（`project.open`）即订阅这个频道。
 *
 * 这是 D1 之前的过渡：本阶段文档服务**不持有项目内容的真身**，页面仍是项目的真身，这里只做编号与通知
 * （语义 `docs/semantics/architecture/document-service.md`「版本与身份」）。操作格式、撤销与重做留给后续阶段，
 * 届时由操作日志取代本模块。
 *
 * 写入者身份取建连时的 principal，消息里自报的 `userId` 一律不认；`session` 是页面自报的会话标识，只作记录。
 * 版本号从 1 起、只增不减，跨重启保持：第一次用到某个项目时从日志回放一次，之后只在内存里维护。
 *
 * **项目快照**（J.1）：发布方把某一版的项目 JSON 分片传上来（`project.snapshot.put`），收齐、校验摘要后
 * 整份落盘成一个不可变文件 `projects/<编码后的 projectId>@<projectRev>.json`（存储层 `writeBlob`，原子写入）；
 * 节点按版本取回（`project.snapshot.get`），服务端重新分片、按序发回，最后一条是 `project.snapshot.end`。
 * - 上传的分片按 `(projectId, projectRev)` 汇在一起，可以乱序、可以重传、可以来自不同连接；
 *   摘要不符时已收的分片全部丢弃。未收齐的上传放在内存里，闲置太久或太多时丢掉最旧的（见 `SNAPSHOT_LIMITS`）。
 * - 取回时先核对文件内容的 sha256 等于这一版登记的摘要：Windows 文件名不分大小写，只差大小写的两个项目
 *   同一版会落进同一个文件，对不上就当没有（回 `missing`），不会把别的项目的内容发出去。
 * - 发回的分片按积压节流：核心的出站队列加底层积压超过上限（缺省 1 MiB）就以 1013 断开（H.2），整份一次发完会被断开。
 *   每发一片之前等这条连接的积压（`ctx.pendingBytes`）降到上限（`ctx.maxPendingBytes`）的一半以下（J.11）。
 *   同一条连接上的多次取回排队依次发，连接断开就停。
 */
import { createHash } from 'node:crypto';
import { createMemoryStore, fileNameOf } from '../store/index.mjs';

export const PROJECT_MODULE = 'project';

const PROJECT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const DIGEST_RE = /^[0-9a-f]{16,128}$/;

/** 快照的上限（J.1）：每片 ≤ 512 KiB（UTF-8 字节）、最多 64 片；未收齐的上传最多留这么多份、闲置这么久 */
export const SNAPSHOT_LIMITS = Object.freeze({
  PART_BYTES: 512 * 1024,
  MAX_PARTS: 64,
  /** 发回时每片的上限（按 JSON 转义后的字节数），比上传的小，便于按节奏发 */
  OUT_PART_BYTES: 256 * 1024,
  MAX_PENDING_UPLOADS: 32,
  PENDING_IDLE_MS: 10 * 60_000,
});

/** 发回快照的节流（J.11）：积压没降到上限的一半以下时，隔 `pollMs` 再查 */
export const SNAPSHOT_PACE = Object.freeze({ pollMs: 20 });

/** 核心没给 `ctx.maxPendingBytes` 时按这个上限算（与核心的缺省值相同，H.2） */
const DEFAULT_MAX_PENDING_BYTES = 1024 * 1024;

const isReqId = (v) => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));

class BadMessage extends Error {}
function bad(detail) { throw new BadMessage(detail); }

/** 业务错误：回 `error { reason }`，不算 bad-message */
class Refused extends Error {
  constructor(reason, detail) {
    super(detail);
    this.reason = reason;
  }
}

function checkProjectId(v) {
  if (typeof v !== 'string' || !PROJECT_ID_RE.test(v)) bad('projectId 不合法');
  return v;
}

function checkDigest(v) {
  if (typeof v !== 'string' || !DIGEST_RE.test(v)) bad('digest 必须是 16～128 位小写十六进制');
  return v;
}

function checkRev(v) {
  if (!Number.isSafeInteger(v) || v < 1) bad('projectRev 必须是正整数');
  return v;
}

/** `session` 可选：没给（或 null）记为 null；给了就得是 1～128 个字符的字符串 */
function checkSession(v) {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || v.length < 1 || v.length > 128) bad('session 必须是 1～128 个字符的字符串');
  return v;
}

const streamOf = (projectId) => `projects/${projectId}`;
const channelOf = (projectId) => `project:${projectId}`;
/** 快照文件名（J.1）：projectId 按 C6.3 第 10 节第 10 条编码，`@<projectRev>.json` 原样 */
export const snapshotBlobName = (projectId, projectRev) => `projects/${fileNameOf(projectId)}@${projectRev}.json`;

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/** 一个 UTF-16 码元在 JSON 字符串里转义后的 UTF-8 字节数；代理对整体算 4 */
function escapedWidth(text, i) {
  const c = text.charCodeAt(i);
  if (c === 0x22 || c === 0x5c) return [2, 1];
  if (c < 0x20) return [c === 8 || c === 9 || c === 10 || c === 12 || c === 13 ? 2 : 6, 1];
  if (c < 0x80) return [1, 1];
  if (c < 0x800) return [2, 1];
  if (c >= 0xd800 && c <= 0xdbff) {
    const d = text.charCodeAt(i + 1);
    return d >= 0xdc00 && d <= 0xdfff ? [4, 2] : [6, 1];
  }
  if (c >= 0xdc00 && c <= 0xdfff) return [6, 1];
  return [3, 1];
}

/** 按「JSON 转义后的 UTF-8 字节数 ≤ limit」切文本，不拆代理对；空文本也回一片 */
export function splitSnapshotText(text, limit) {
  const parts = [];
  let start = 0;
  let bytes = 0;
  for (let i = 0; i < text.length;) {
    const [w, step] = escapedWidth(text, i);
    if (bytes + w > limit && i > start) {
      parts.push(text.slice(start, i));
      start = i;
      bytes = 0;
    }
    bytes += w;
    i += step;
  }
  if (start < text.length || parts.length === 0) parts.push(text.slice(start));
  return parts;
}

/**
 * @param {object} [options]
 * @param {{ append(stream: string, record: object): void, read(stream: string): object[],
 *   writeBlob?(name: string, text: string): void, readBlob?(name: string): string | null }} [options.store]
 *   日志与快照存储（`../store/index.mjs`）；缺省用内存存储，不跨重启。没有 `writeBlob` / `readBlob` 的存储
 *   不支持快照，快照消息回 `unsupported`
 * @param {() => number} [options.now] 缺省用 `ctx.now()`
 * @param {number} [options.pollMs] 积压没降下来时隔多久再查，缺省 `SNAPSHOT_PACE.pollMs`（20 ms）
 */
export function projectModule({ store = createMemoryStore(), now, pollMs = SNAPSHOT_PACE.pollMs } = {}) {
  /** projectId → { projectRev, digest, at }；第一次用到时从日志回放 */
  const projects = new Map();
  /** projectId → Map<rev, digest>：每一版登记的摘要，快照按它校验 */
  const revDigests = new Map();
  /** connId → principal */
  const principals = new Map();
  /** `${projectId}@${rev}` → { projectId, projectRev, digest, count, parts: Map<index, data>, bytes, touched } */
  const uploads = new Map();
  /** connId → { chain: Promise, alive: boolean }：取回快照的发送队列 */
  const senders = new Map();
  const stats = { snapshotsStored: 0, snapshotsServed: 0, digestMismatches: 0, uploadsEvicted: 0 };

  const clock = (ctx) => (typeof now === 'function' ? now() : ctx.now());

  function stateOf(projectId) {
    let st = projects.get(projectId);
    if (st) return st;
    st = { projectRev: 0, digest: null, at: null };
    const revs = new Map();
    for (const rec of store.read(streamOf(projectId))) {
      // 同一个文件里可能混进只差大小写的项目（Windows 文件名不分大小写），按记录自己的键过滤
      if (rec.projectId !== projectId) continue;
      if (!Number.isSafeInteger(rec.rev) || rec.rev <= st.projectRev) continue;
      if (typeof rec.digest !== 'string') continue;
      st = { projectRev: rec.rev, digest: rec.digest, at: Number.isFinite(rec.at) ? rec.at : null };
      revs.set(rec.rev, rec.digest);
    }
    projects.set(projectId, st);
    revDigests.set(projectId, revs);
    return st;
  }

  /** 这一版登记的摘要；没登记过回 undefined */
  function digestOfRev(projectId, rev) {
    stateOf(projectId);
    return revDigests.get(projectId)?.get(rev);
  }

  function reply(ctx, connId, message, reqId) {
    if (reqId !== undefined) message.reqId = reqId;
    ctx.send(connId, message);
  }

  function open(ctx, connId, msg, reqId) {
    const projectId = checkProjectId(msg.projectId);
    const st = stateOf(projectId);
    ctx.subscribe(connId, channelOf(projectId));
    reply(ctx, connId, { type: 'project.state', projectId, projectRev: st.projectRev, digest: st.digest, at: st.at }, reqId);
  }

  function announce(ctx, connId, msg, reqId) {
    const projectId = checkProjectId(msg.projectId);
    const digest = checkDigest(msg.digest);
    const session = checkSession(msg.session);
    const st = stateOf(projectId);
    if (st.digest === digest) {
      return reply(ctx, connId, { type: 'project.announced', projectId, projectRev: st.projectRev, changed: false }, reqId);
    }
    const principal = principals.get(connId);
    const actor = { userId: principal?.userId ?? null, session };
    const at = clock(ctx);
    const rev = st.projectRev + 1;
    // 先落日志再改内存：落盘失败时状态不变，核心回 internal
    store.append(streamOf(projectId), { projectId, rev, digest, actor, at });
    projects.set(projectId, { projectRev: rev, digest, at });
    revDigests.get(projectId).set(rev, digest);
    reply(ctx, connId, { type: 'project.announced', projectId, projectRev: rev, changed: true }, reqId);
    ctx.publish(channelOf(projectId), { type: 'project.rev', projectId, projectRev: rev, digest, actor, at }, { coalesceKey: `project-rev:${projectId}` });
  }

  function close(ctx, connId, msg, reqId) {
    const projectId = checkProjectId(msg.projectId);
    ctx.unsubscribe(connId, channelOf(projectId));
    reply(ctx, connId, { type: 'project.closed', projectId }, reqId);
  }

  // ---------- 快照：上传 ----------

  function requireBlobStore() {
    if (typeof store.writeBlob !== 'function' || typeof store.readBlob !== 'function') {
      throw new Refused('unsupported', '这个存储不支持项目快照');
    }
  }

  /** 丢掉闲置太久的上传；超过份数上限时丢最旧的 */
  function evictUploads(nowMs, keep) {
    for (const [key, up] of uploads) {
      if (key !== keep && nowMs - up.touched > SNAPSHOT_LIMITS.PENDING_IDLE_MS) {
        uploads.delete(key);
        stats.uploadsEvicted += 1;
      }
    }
    while (uploads.size > SNAPSHOT_LIMITS.MAX_PENDING_UPLOADS) {
      let oldestKey = null;
      let oldest = Infinity;
      for (const [key, up] of uploads) {
        if (key !== keep && up.touched < oldest) { oldest = up.touched; oldestKey = key; }
      }
      if (oldestKey === null) break;
      uploads.delete(oldestKey);
      stats.uploadsEvicted += 1;
    }
  }

  function snapshotPut(ctx, connId, msg, reqId) {
    const projectId = checkProjectId(msg.projectId);
    const projectRev = checkRev(msg.projectRev);
    const digest = checkDigest(msg.digest);
    const { index, count, data } = msg;
    if (!Number.isSafeInteger(count) || count < 1 || count > SNAPSHOT_LIMITS.MAX_PARTS) bad(`count 必须是 1～${SNAPSHOT_LIMITS.MAX_PARTS} 的整数`);
    if (!Number.isSafeInteger(index) || index < 0 || index >= count) bad('index 必须是 0～count-1 的整数');
    if (typeof data !== 'string') bad('data 必须是字符串');
    if (Buffer.byteLength(data, 'utf8') > SNAPSHOT_LIMITS.PART_BYTES) bad(`每片不能超过 ${SNAPSHOT_LIMITS.PART_BYTES} 字节`);
    requireBlobStore();

    const key = `${projectId}@${projectRev}`;
    const announced = digestOfRev(projectId, projectRev);
    if (announced === undefined) {
      uploads.delete(key);
      throw new Refused('unknown-rev', `项目 ${projectId} 没有登记过版本 ${projectRev}`);
    }
    if (announced !== digest) {
      uploads.delete(key);
      stats.digestMismatches += 1;
      throw new Refused('digest-mismatch', '摘要与这一版登记的不一致');
    }

    const nowMs = Date.now();
    let up = uploads.get(key);
    // 分片数变了（发布方换了切法重传）：按新的切法从头收
    if (up && up.count !== count) {
      uploads.delete(key);
      up = undefined;
    }
    if (!up) {
      up = { projectId, projectRev, digest, count, parts: new Map(), touched: nowMs };
      uploads.set(key, up);
    }
    up.parts.set(index, data);
    up.touched = nowMs;
    evictUploads(nowMs, key);

    if (up.parts.size < up.count) {
      return reply(ctx, connId, { type: 'project.snapshot.stored', projectId, projectRev, received: up.parts.size, count, complete: false }, reqId);
    }

    uploads.delete(key);
    let text = '';
    for (let i = 0; i < up.count; i += 1) text += up.parts.get(i);
    if (sha256(text) !== digest) {
      stats.digestMismatches += 1;
      throw new Refused('digest-mismatch', '收齐后的内容与摘要不符');
    }
    store.writeBlob(snapshotBlobName(projectId, projectRev), text);
    stats.snapshotsStored += 1;
    ctx.log('project.snapshot.stored', { projectId, projectRev, bytes: Buffer.byteLength(text, 'utf8'), count });
    reply(ctx, connId, { type: 'project.snapshot.stored', projectId, projectRev, received: count, count, complete: true }, reqId);
  }

  // ---------- 快照：取回 ----------

  const wait = (ms) => new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
  const nextTurn = () => new Promise((resolve) => setImmediate(resolve));
  const maxPendingOf = (ctx) => (Number.isFinite(ctx.maxPendingBytes) && ctx.maxPendingBytes > 0 ? ctx.maxPendingBytes : DEFAULT_MAX_PENDING_BYTES);

  /**
   * 按积压节流，把一串消息发给一条连接（J.11）：每发一条之前，这条连接的积压（核心出站队列 + 底层缓冲，
   * `ctx.pendingBytes`）必须低于上限（`ctx.maxPendingBytes`）的一半，否则隔 `pollMs` 再查。
   * 每片 ≤ min(256 KiB, 上限的四分之一)，所以发出后积压不超过上限的四分之三，到不了 1013。连接断开或被核心关掉就停。
   * 核心没有这两个接口时（测试替身）按上限 1 MiB 算、积压当 0，每条之间只让一次事件循环。
   */
  async function stream(ctx, connId, sender, messages) {
    const limit = maxPendingOf(ctx);
    const pendingOf = typeof ctx.pendingBytes === 'function' ? (id) => ctx.pendingBytes(id) : () => 0;
    for (let i = 0; i < messages.length; i += 1) {
      if (!sender.alive) return;
      if (i > 0) await nextTurn();
      while (sender.alive && pendingOf(connId) >= limit / 2) await wait(pollMs);
      if (!sender.alive) return;
      if (ctx.send(connId, messages[i]) === false) return;
    }
  }

  function snapshotGet(ctx, connId, msg, reqId) {
    const projectId = checkProjectId(msg.projectId);
    const projectRev = checkRev(msg.projectRev);
    requireBlobStore();

    const withReq = (m) => (reqId === undefined ? m : { ...m, reqId });
    const missing = () => reply(ctx, connId, { type: 'project.snapshot.part', projectId, projectRev, missing: true }, reqId);
    const digest = digestOfRev(projectId, projectRev);
    if (digest === undefined) return missing();
    const text = store.readBlob(snapshotBlobName(projectId, projectRev));
    if (text === null) return missing();
    if (sha256(text) !== digest) {
      ctx.log('project.snapshot.foreign', { projectId, projectRev });
      return missing();
    }

    // 每片不超过 256 KiB，也不超过积压上限的四分之一：节流线是上限的一半，发出一片后仍留余量
    const partBytes = Math.max(1024, Math.min(SNAPSHOT_LIMITS.OUT_PART_BYTES, Math.floor(maxPendingOf(ctx) / 4)));
    const parts = splitSnapshotText(text, partBytes);
    const count = parts.length;
    const messages = parts.map((data, index) => withReq({ type: 'project.snapshot.part', projectId, projectRev, index, count, data }));
    messages.push(withReq({ type: 'project.snapshot.end', projectId, projectRev, digest }));
    stats.snapshotsServed += 1;

    let sender = senders.get(connId);
    if (!sender) senders.set(connId, (sender = { chain: Promise.resolve(), alive: true }));
    const s = sender;
    s.chain = s.chain
      .then(() => stream(ctx, connId, s, messages))
      .catch((err) => ctx.log('module.error', { module: PROJECT_MODULE, type: 'project.snapshot.get', message: String(err?.message ?? err) }));
  }

  const HANDLERS = {
    'project.open': open,
    'project.announce': announce,
    'project.close': close,
    'project.snapshot.put': snapshotPut,
    'project.snapshot.get': snapshotGet,
  };

  return {
    name: PROJECT_MODULE,
    types: ['project.'],
    channels: ['project'],

    connect(ctx, connId, principal) {
      principals.set(connId, { ...principal });
    },

    disconnect(ctx, connId) {
      // 频道订阅由核心在断开时清掉
      principals.delete(connId);
      const sender = senders.get(connId);
      if (sender) {
        sender.alive = false;
        senders.delete(connId);
      }
    },

    handle(ctx, connId, msg) {
      const reqId = isReqId(msg.reqId) ? msg.reqId : undefined;
      const fn = HANDLERS[msg.type];
      if (!fn) return reply(ctx, connId, { type: 'error', reason: 'unsupported', detail: '项目版本模块不支持这种消息' }, reqId);
      try {
        fn(ctx, connId, msg, reqId);
      } catch (err) {
        if (err instanceof Refused) return reply(ctx, connId, { type: 'error', reason: err.reason, detail: err.message }, reqId);
        if (!(err instanceof BadMessage)) throw err;
        reply(ctx, connId, { type: 'error', reason: 'bad-message', detail: err.message }, reqId);
      }
    },

    describe() {
      return {
        projects: [...projects.entries()]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([projectId, st]) => ({ projectId, ...st })),
        snapshots: { ...stats, pendingUploads: uploads.size },
      };
    },
  };
}

/** 别名：与其它工厂的命名习惯对齐 */
export const createProjectModule = projectModule;
export default projectModule;
