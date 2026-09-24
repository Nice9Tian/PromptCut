import { mergeRanges } from './snapshot-store.mjs';

/**
 * C3 就绪索引:**按层**记「这一层现在有哪些本地帧」,并把变化推给页面。
 *
 * 一层 = (片段 clipId, 档位 kind)。同一张重卡的 `stream` 表和 `html` 表并存、
 * 互不覆盖 —— 播放贴流、拖动贴快照,两条路各查各的。
 *
 * # 档位名的三处同义
 *
 *   目录 `controls-html`  ↔ `snapshotTier()` 的 `'shared'` ↔ 线上 `kind: 'html'`
 *   目录 `controls-local` ↔ `snapshotTier()` 的 `'local'`  ↔ 线上 `kind: 'local'`
 *   轨道流(R8)                                            ↔ 线上 `kind: 'stream'`
 *
 * `snapshotTier` 的返回值由调用方用 `kindOfTier` 映射成 `kind`。K1 记录里的
 * `kind: 'random' | 'stepped'` 是探针方法,同字不同物。
 *
 * # 消息三种(格式定死,C3)
 *
 *   { type: 'reset', localRev }                       项目版本换了,页面清表
 *   { type: 'layer', clipId, kind, key, ranges, groupClipIds? }
 *                                                     该层当前**全部**就绪的本地帧
 *                                                     闭区间,**每次发全量、不发增量**
 *   { type: 'done', localRev }                        锚帧全部就绪(C2 的门槛)
 *
 * 全量语义是刻意的:一条消息丢了不会让页面的表永远缺一段,下一条同层消息就补回来;
 * 重连时服务端先发 `reset` 再发全量 `layer`,所以不需要轮询端点(J3 / F5 共用这条路)。
 *
 * # 为什么 `layer` 要等项目到位(F5)
 *
 * 扫盘只得到「键 → 区间」:目录名是剥掉 clipId 的共享键,而 `layer` 和页面的
 * `readyIndex` 都按 clipId 索引。所以重启后先把区间挂在键上(`stageByKey`),
 * 等 card plan 算出来(`control.clipId` ↔ `control.snapshotKey`)再反查、
 * 一次性 `reset` + 全量 `layer`。项目没到之前一条 `layer` 都不发。
 */

/** `snapshotTier()` → 线上的 `kind`;不产快照的档回 null */
export function kindOfTier(tier) {
  if (tier === 'shared') return 'html';
  if (tier === 'local') return 'local';
  return null;
}

export const READY_KINDS = ['html', 'local', 'stream'];

/**
 * 线上的 `key`(C3 / J3):共享档就是共享键;本地档**自带一个斜杠** ——
 * `<entry.key>/<共享键>`,因为同一个共享键在不同项目下各有一棵本地档子树。
 * 目录形状(`snapshot-store.mjs` 的两层目录)和线上的键在这里对齐,只此一处。
 */
export function wireSnapshotKey(tier, entryKey, snapshotKey) {
  if (!snapshotKey) return null;
  if (tier === 'shared') return snapshotKey;
  if (tier === 'local') return entryKey ? `${entryKey}/${snapshotKey}` : null;
  return null;
}

const layerId = (clipId, kind) => `${kind}:${clipId}`;

/**
 * `staged`:还没认领的「键 → 区间」。缺省每个索引自带一份;按会话分片时(`createReadyHub`)
 * 所有会话共用 hub 的那一份 —— 扫盘和轨道流挂上去的区间是内容寻址的,和哪个会话无关。
 */
export function createReadyIndex({ staged: shared = null } = {}) {
  const staged = shared ?? new Map();
  /** layerId -> { clipId, kind, key, ranges, groupClipIds? } */
  const layers = new Map();
  const subscribers = new Set();
  let localRev = 0;
  let done = false;

  function emit(message) {
    for (const send of subscribers) { try { send(message); } catch { /* 一个订阅者断了不影响别人 */ } }
  }

  /** 项目版本换了:清表、通知页面清表。`layer` 从这一刻起重新长。 */
  function reset(rev = localRev) {
    localRev = Number(rev) || 0;
    layers.clear();
    done = false;
    emit({ type: 'reset', localRev });
  }

  /**
   * 把这一批新帧并进某一层,并发一条**全量** `layer`。
   * `frames` 可以是帧号、闭区间,或两者混排(`mergeRanges` 的口径)。
   */
  function addFrames({ clipId, kind, key, frames, groupClipIds = undefined }) {
    if (!clipId || !READY_KINDS.includes(kind) || !key) return null;
    const id = layerId(clipId, kind);
    const before = layers.get(id);
    // 换了键(卡的参数变了)就从头记:旧键的区间和新键没有关系
    const base = before && before.key === key ? before.ranges : [];
    const ranges = mergeRanges([...base, ...(frames ?? [])]);
    const layer = { clipId, kind, key, ranges, ...(groupClipIds ? { groupClipIds } : {}) };
    layers.set(id, layer);
    emit({ type: 'layer', ...layer });
    return layer;
  }

  /** 整层直接给一份区间表(F5 的重建路);和 `addFrames` 一样发全量 `layer`。 */
  function setLayer({ clipId, kind, key, ranges, groupClipIds = undefined }) {
    if (!clipId || !READY_KINDS.includes(kind) || !key) return null;
    const layer = { clipId, kind, key, ranges: mergeRanges(ranges), ...(groupClipIds ? { groupClipIds } : {}) };
    layers.set(layerId(clipId, kind), layer);
    emit({ type: 'layer', ...layer });
    return layer;
  }

  /** 锚帧全部就绪(C2 的门槛)。重复调只发一次。 */
  function markDone() {
    if (done) return;
    done = true;
    emit({ type: 'done', localRev });
  }

  /** 扫盘得到的「键 → 区间」:先挂着,等 card plan 到位再认领(F5) */
  function stageByKey({ kind, key, ranges }) {
    if (!READY_KINDS.includes(kind) || !key) return;
    const id = `${kind}:${key}`;
    const before = staged.get(id);
    staged.set(id, { kind, key, ranges: mergeRanges([...(before?.ranges ?? []), ...(ranges ?? [])]) });
  }

  /**
   * card plan 到位:用 `control.clipId` ↔ `control.snapshotKey` 把挂着的区间认领成层。
   * `layers` = [{ clipId, kind, key }],`key` 已经是**线上的键**(本地档是
   * `<entry.key>/<共享键>`,C3),由调用方用 `wireSnapshotKey` 拼好。返回认领了几层。
   *
   * 认领是**全量重发**:先 `reset`(页面清表),再对每一层发一条 `layer`。这和 C3
   * 的语义一致,所以不需要新端点。
   */
  function claim(layers_, rev = localRev) {
    const claimed = [];
    for (const item of layers_ ?? []) {
      if (!READY_KINDS.includes(item?.kind) || !item.clipId || !item.key) continue;
      const hit = staged.get(`${item.kind}:${item.key}`);
      if (!hit?.ranges?.length) continue;
      claimed.push({ clipId: item.clipId, kind: item.kind, key: item.key, ranges: hit.ranges });
    }
    if (!claimed.length) return 0;
    localRev = Number(rev) || 0;
    layers.clear();
    done = false;
    emit({ type: 'reset', localRev });
    for (const layer of claimed) {
      layers.set(layerId(layer.clipId, layer.kind), layer);
      emit({ type: 'layer', ...layer });
    }
    return claimed.length;
  }

  /**
   * 按会话分片之后的认领(`createReadyHub().claim`):**不 reset**,把挂着的区间并进已有的层
   * (同一层同一个键时取并集,键不同就以挂着的为准),只对真的变了的层发全量 `layer`。
   * 会话换版本时的清表由 `reset` 单独做(hub 的 `adopt`),认领只负责「补」。返回变了几层。
   */
  function absorb(layers_) {
    let changed = 0;
    for (const item of layers_ ?? []) {
      if (!READY_KINDS.includes(item?.kind) || !item.clipId || !item.key) continue;
      const hit = staged.get(`${item.kind}:${item.key}`);
      if (!hit?.ranges?.length) continue;
      const id = layerId(item.clipId, item.kind);
      const before = layers.get(id);
      const ranges = mergeRanges([...(before?.key === item.key ? before.ranges : []), ...hit.ranges]);
      if (before?.key === item.key && JSON.stringify(before.ranges) === JSON.stringify(ranges)) continue;
      const layer = { clipId: item.clipId, kind: item.kind, key: item.key, ranges,
        ...(before?.key === item.key && before.groupClipIds ? { groupClipIds: before.groupClipIds } : {}) };
      layers.set(id, layer);
      emit({ type: 'layer', ...layer });
      changed++;
    }
    return changed;
  }

  /** 连上 SSE 时先灌的那一份:`reset` + 每层一条全量 `layer`(+ 已经 done 的话再一条) */
  function backlog() {
    const out = [{ type: 'reset', localRev }];
    for (const layer of layers.values()) out.push({ type: 'layer', ...layer });
    if (done) out.push({ type: 'done', localRev });
    return out;
  }

  function subscribe(send) {
    subscribers.add(send);
    for (const message of backlog()) { try { send(message); } catch { /* 刚连上就断了 */ } }
    return () => subscribers.delete(send);
  }

  return {
    reset, addFrames, setLayer, markDone, stageByKey, claim, absorb, backlog, subscribe,
    get localRev() { return localRev; },
    set localRev(value) { localRev = Number(value) || 0; },
    get done() { return done; },
    /** 测试 / 探针用 */
    list: () => [...layers.values()].map(layer => ({ ...layer })),
    stagedKeys: () => [...staged.values()].map(item => ({ ...item })),
    subscriberCount: () => subscribers.size,
    // 共用的 `staged` 属于 hub,一个会话清不掉别的会话要认领的东西
    clear: () => { layers.clear(); if (!shared) staged.clear(); done = false; },
  };
}

/** 不带 session 的调用方(脚本、探针、迁移期带整份 `project` 的页面)共用的那个会话 */
export const DEFAULT_READY_SESSION = '';
/** 没有订阅者、也这么久没发过 preload 的会话被回收 */
export const READY_SESSION_IDLE_MS = 10 * 60 * 1000;
/** 同时记着的会话上限;超了先回收最久没动静、又没有订阅者的 */
export const READY_SESSION_MAX = 64;

/**
 * 按会话分片的就绪索引(Item 4,`docs/reports/REPORT-item4-session-isolation.md`)。
 *
 * 每个页面会话(镜像的 `session`)一份 `createReadyIndex`,`/api/frames/ready?session=` 只订阅自己那份。
 * 会话的「当前版本」(`entryKey`)**只由页面发起的 `preload` 设定**(`adopt`),别的渲染
 * (Agent 查询、导出、交互帧)不认领、不 reset 任何会话的索引。
 *
 * 发布一律带上它属于的 entry(`publish(entryKey, layer)`):只写进当前版本正是这个 entry 的会话,
 * 其余丢弃 —— 旧版本晚到的批次、别的会话 / 后台任务渲的版本都进不来。
 *
 * 扫盘(F5)和轨道流挂上去的「键 → 区间」是内容寻址的,所有会话共用一份 `staged`。
 */
export function createReadyHub({ now = () => Date.now(), idleMs = READY_SESSION_IDLE_MS, maxSessions = READY_SESSION_MAX } = {}) {
  const staged = new Map();
  /** id -> { id, index, entryKey, localRev, seenAt, ticket } */
  const sessions = new Map();
  let tickets = 0;

  const norm = id => (typeof id === 'string' ? id : id == null ? DEFAULT_READY_SESSION : String(id));

  function session(id) {
    id = norm(id);
    let record = sessions.get(id);
    if (!record) {
      record = { id, index: createReadyIndex({ staged }), entryKey: undefined, localRev: undefined, seenAt: now(), ticket: 0 };
      sessions.set(id, record);
      prune(id);
    }
    return record;
  }

  /**
   * 回收:没有订阅者、`idleMs` 内没动静的会话删掉;还超上限就按最久没动静的顺序删(同样只删没有订阅者的)。
   * `keep` 是正在用的那个会话,不删。
   */
  function prune(keep) {
    const t = now();
    for (const [id, record] of sessions) {
      if (id === keep || record.index.subscriberCount() > 0) continue;
      if (t - record.seenAt > idleMs) sessions.delete(id);
    }
    if (sessions.size <= maxSessions) return;
    const idle = [...sessions.values()].filter(r => r.id !== keep && r.index.subscriberCount() === 0).sort((a, b) => a.seenAt - b.seenAt);
    for (const record of idle) {
      if (sessions.size <= maxSessions) break;
      sessions.delete(record.id);
    }
  }

  /**
   * 页面的 preload 刚到:先领一张号。`adopt` 只认最新一张号 —— 两个 preload 在 `await entry()`
   * 那一段交错完成时,晚发出的那个版本赢,不是晚算完的那个。
   */
  function request(id) {
    const record = session(id);
    record.seenAt = now();
    record.ticket = ++tickets;
    return record.ticket;
  }

  /**
   * 设定会话的当前版本(**只有页面的 preload 调**)。版本换了就 reset 这个会话的索引(页面清表);
   * 版本没换只记新的 `localRev`,不清表。回 `true` = 换了版本。
   *
   * 过期的号(`ticket` 不是这个会话最新的那张)或更旧的 `localRev` 一律不认。
   */
  /** 这张号 / 这个 localRev 已经被更新的 preload 取代了吗(取代了就既不认领、也不该再排后台活) */
  function stale(id, ticket, localRev) {
    const record = sessions.get(norm(id));
    if (!record) return false;
    if (ticket !== undefined && ticket !== record.ticket) return true;
    const rev = Number(localRev);
    return localRev != null && Number.isFinite(rev) && Number.isFinite(record.localRev) && rev < record.localRev;
  }

  function adopt(id, entryKey, localRev, ticket) {
    const record = session(id);
    record.seenAt = now();
    if (stale(id, ticket, localRev)) return false;
    const rev = localRev == null ? NaN : Number(localRev);
    if (Number.isFinite(rev)) record.localRev = rev;
    if (record.entryKey === entryKey) {
      if (Number.isFinite(rev)) record.index.localRev = rev;
      return false;
    }
    record.entryKey = entryKey;
    record.index.reset(Number.isFinite(rev) ? rev : record.index.localRev);
    return true;
  }

  function sessionsOn(entryKey) {
    if (!entryKey) return [];
    return [...sessions.values()].filter(record => record.entryKey === entryKey);
  }

  /** 发一层:只写进当前版本是 `entryKey` 的会话。回写进了几个会话(0 = 丢弃) */
  function publish(entryKey, layer) {
    let n = 0;
    for (const record of sessionsOn(entryKey)) if (record.index.setLayer(layer)) n++;
    return n;
  }

  function markDone(entryKey) {
    for (const record of sessionsOn(entryKey)) record.index.markDone();
  }

  /** card plan 到位:把挂着的区间认领进当前版本是 `entryKey` 的会话(不 reset,见 `absorb`) */
  function claim(entryKey, layers) {
    let n = 0;
    for (const record of sessionsOn(entryKey)) n += record.index.absorb(layers);
    return n;
  }

  function stageByKey({ kind, key, ranges }) {
    if (!READY_KINDS.includes(kind) || !key) return;
    const id = `${kind}:${key}`;
    const before = staged.get(id);
    staged.set(id, { kind, key, ranges: mergeRanges([...(before?.ranges ?? []), ...(ranges ?? [])]) });
  }

  /** `/api/frames/ready?session=` 的订阅。退订后这个会话按 `idleMs` 回收 */
  function subscribe(id, send) {
    const record = session(id);
    record.seenAt = now();
    const off = record.index.subscribe(send);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      off();
      record.seenAt = now();
      prune();
    };
  }

  return {
    session: id => session(id),
    peek: id => sessions.get(norm(id)),
    current: id => sessions.get(norm(id))?.entryKey,
    request, stale, adopt, publish, markDone, claim, stageByKey, subscribe, prune, sessionsOn,
    drop: id => sessions.delete(norm(id)),
    sessionCount: () => sessions.size,
    stagedKeys: () => [...staged.values()].map(item => ({ ...item })),
    /** 诊断读口 */
    describe: () => [...sessions.values()].map(r => ({ session: r.id, entryKey: r.entryKey ?? null, localRev: r.localRev ?? null,
      subscribers: r.index.subscriberCount(), layers: r.index.list().length, done: r.index.done, seenAt: r.seenAt })),
  };
}
