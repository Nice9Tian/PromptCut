/**
 * 素材上传队列(C6.6,`docs/plan/c66-design.md` 第 3 节;语义 `docs/semantics/architecture/asset-storage.md`「上传」)。
 *
 * 编辑器进程里一个持久队列,把本机导入的素材(两档:小版、原片)传到**当前连接的素材服务**:
 *   - **逐个素材**:队头那一个两档都在素材服务上 `complete` 了才出队,才轮到下一个。队头在退避时后面的也等着(严格按序)。
 *   - **先小后大**:同一素材先传小版、再传原片;没有小版(不是视频、小版没生成出来)就只传原片。
 *   - **分片、断点续传**:每一档走素材服务客户端的 `putFile`(先问 `chunks`,只补 `received` 里缺的片,最后 `complete`
 *     由服务端按 sha256 校验)。断了按退避重试(5 s、30 s、120 s,之后每 10 min),不放弃。
 *   - **两档都 complete 才出队**:传完再各问一次 `chunks`,两档都报 `complete: true` 才算。同步状态只问素材服务,
 *     不写进项目、不写进 `.proc`(语义「同步状态只问素材服务」);本文件只记「还要传什么」。
 *   - **带素材票据**:由 `target()` 给出的素材服务客户端带(`createAssetClient({ base, ticket })`),本模块不碰票据。
 *   - **低优先级**:每一片发出前取带宽闸(`bandwidth-gate.mjs` 的 `acquireMedia`),预渲染产物的推送优先。
 *   - **连本地素材服务时是空操作**:`target()` 回 null 表示当前连的就是本机素材服务 —— 导入那一步已经是本地写入,
 *     不进队。队里已有的(连远程时进的)在 `target()` 回 null 期间暂停,换回远程再接着传。
 *   - **落盘**:`upload-queue.json`,每次进队、出队、失败都原子写回;重启时读回接着传。
 *
 * 日志事件(T3 按它核对顺序):`upload.enqueued`、`upload.tier-start`、`upload.tier-done`、`upload.item-done`、
 * `upload.retry`、`upload.skip-local`、`upload.missing`。
 *
 * 只用 Node 内置模块;素材服务客户端、带宽闸、找文件的函数都由调用方传进来。
 */
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const UPLOAD_QUEUE_FILE = 'upload-queue.json';
export const UPLOAD_BACKOFF_MS = Object.freeze([5_000, 30_000, 120_000, 600_000]);
const FILE_VERSION = 1;
const HASH = /^[0-9a-f]{64}$/;
const EXT = /^[a-z0-9]{1,8}$/;
const TIER_ORDER = ['small', 'original'];

/** 一个素材的两档整理成「先小后大」;不合格回 null */
export function normalizeUploadItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const tiers = [];
  for (const tier of TIER_ORDER) {
    const t = (raw.tiers ?? []).find?.((x) => x?.tier === tier) ?? null;
    if (!t) continue;
    const hash = String(t.hash ?? '').toLowerCase();
    if (!HASH.test(hash)) return null;
    const ext = t.ext ? String(t.ext).toLowerCase().replace(/^\./, '') : '';
    if (ext && !EXT.test(ext)) return null;
    tiers.push({ tier, hash, ext });
  }
  const original = tiers.find((t) => t.tier === 'original');
  if (!original) return null;
  return { id: original.hash, name: typeof raw.name === 'string' ? raw.name.slice(0, 200) : '', tiers };
}

async function atomicWrite(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, text);
  try { await fs.rename(tmp, file); }
  catch (error) { await fs.rm(tmp, { force: true }); throw error; }
}

/**
 * @param {object} options
 * @param {string | null} options.file  队列文件(`<本机数据目录>/upload-queue.json`);null 只在内存里
 * @param {() => ({ client: any, base?: string } | null)} options.target  当前连接的素材服务;null = 本机素材服务(空操作)
 * @param {(hash: string) => (string | null | Promise<string | null>)} options.resolveFile  哈希 → 本地内容库里的文件
 * @param {any} [options.gate]  带宽闸;不给就不让路
 * @param {(event: string, fields: object) => void} [options.log]
 * @param {number[]} [options.backoff]
 * @param {() => number} [options.now]
 */
export function createUploadQueue({
  file, target, resolveFile, gate = null, log = () => {}, backoff = UPLOAD_BACKOFF_MS, now = Date.now,
} = /** @type {any} */ ({})) {
  if (typeof target !== 'function') throw new TypeError('createUploadQueue needs target()');
  if (typeof resolveFile !== 'function') throw new TypeError('createUploadQueue needs resolveFile()');
  const delays = Array.isArray(backoff) && backoff.length ? backoff.map((ms) => Math.max(0, Number(ms) || 0)) : [...UPLOAD_BACKOFF_MS];
  const say = (event, fields = {}) => { try { log(event, fields); } catch { /* 日志出错不影响上传 */ } };

  /** id(原片哈希)→ { id, name, tiers, attempts, nextAt, seq } */
  const items = new Map();
  let seq = 0;
  let running = false;
  let working = false;
  let timer = null;
  let controller = null;
  const waiters = [];
  const counters = { enqueued: 0, merged: 0, done: 0, failures: 0, chunks: 0, restored: 0, skippedLocal: 0, missing: 0 };
  let lastError = null;
  let current = null;

  /* ---------- 落盘 ---------- */
  let chain = Promise.resolve();
  let pending = null;
  const snapshot = () => JSON.stringify({
    v: FILE_VERSION,
    items: [...items.values()].sort((a, b) => a.seq - b.seq).map(({ id, name, tiers, attempts }) => ({ id, name, tiers, attempts })),
  });
  const persist = () => {
    if (!file) return Promise.resolve();
    if (pending) return pending;
    const write = chain.then(async () => {
      if (pending === write) pending = null;
      try { await atomicWrite(file, snapshot()); }
      catch (error) { say('upload.persist-failed', { message: String(error?.message ?? error) }); }
    });
    pending = write;
    chain = write;
    return write;
  };

  (function restore() {
    if (!file) return;
    let saved = null;
    try { saved = JSON.parse(fsSync.readFileSync(file, 'utf8')); } catch { return; }
    if (!saved || saved.v !== FILE_VERSION || !Array.isArray(saved.items)) return;
    for (const record of saved.items) {
      const item = normalizeUploadItem(record);
      if (!item || items.has(item.id)) continue;
      items.set(item.id, { ...item, attempts: Math.max(0, Math.floor(Number(record.attempts) || 0)), nextAt: 0, seq: seq++ });
      counters.restored++;
    }
  })();

  /* ---------- 调度 ---------- */
  const head = () => {
    let best = null;
    for (const item of items.values()) if (!best || item.seq < best.seq) best = item;
    return best;
  };
  const settle = () => { if (!items.size) for (const resolve of waiters.splice(0)) resolve(); };
  const clearTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };
  const schedule = (delay = 0) => {
    if (!running) return;
    clearTimer();
    timer = setTimeout(() => { timer = null; void pump(); }, Math.max(0, delay));
    timer.unref?.();
  };

  async function pump() {
    if (!running || working) return;
    const item = head();
    if (!item) return settle();
    const wait = item.nextAt - now();
    if (wait > 0) return schedule(wait);
    const where = target();
    if (!where || !where.client) {
      // 当前连的是本机素材服务:暂停,换回远程再接着传(每 5 s 看一次)
      return schedule(5_000);
    }
    working = true;
    current = item.id;
    controller = new AbortController();
    const signal = controller.signal;
    try {
      await uploadItem(item, where.client, signal);
      items.delete(item.id);
      counters.done++;
      say('upload.item-done', { id: item.id, name: item.name, tiers: item.tiers.map((t) => t.tier) });
      await persist();
      settle();
    } catch (error) {
      if (!running && (error?.name === 'AbortError')) {
        // 停下了:留在队里,下次接着传
      } else {
        counters.failures++;
        item.attempts++;
        const delay = delays[Math.min(item.attempts - 1, delays.length - 1)];
        item.nextAt = now() + delay;
        lastError = { id: item.id, code: error?.code ?? error?.status ?? null, message: String(error?.message ?? error), at: now() };
        say('upload.retry', { id: item.id, attempts: item.attempts, delayMs: delay, code: lastError.code, message: lastError.message });
        void persist();
      }
    } finally {
      working = false;
      current = null;
      controller = null;
    }
    if (running) schedule(0);
  }

  async function uploadItem(item, client, signal) {
    const done = [];
    for (const t of item.tiers) {
      const filePath = await resolveFile(t.hash);
      if (!filePath) {
        // 本地内容库里没有这一档(被删了):传不了,记一笔跳过这一档;原片也没有就整个丢掉
        counters.missing++;
        say('upload.missing', { id: item.id, tier: t.tier, hash: t.hash });
        continue;
      }
      say('upload.tier-start', { id: item.id, tier: t.tier, hash: t.hash });
      const r = await client.putFile('media', filePath, {
        hash: t.hash,
        ext: t.ext || undefined,
        beforeChunk: async () => {
          if (!running || signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
          const release = gate ? await gate.acquireMedia({ signal }) : null;
          counters.chunks++;
          return release;
        },
      });
      say('upload.tier-done', { id: item.id, tier: t.tier, hash: t.hash, uploaded: r.uploaded, sent: r.sent });
      done.push(t);
    }
    // 两档都在素材服务上 complete 才出队(同步状态只问素材服务)
    for (const t of done) {
      const st = await client.chunks('media', t.hash);
      if (!st.complete) throw Object.assign(new Error(`素材服务上 ${t.tier} ${t.hash} 还没 complete`), { code: 'not-complete' });
    }
  }

  /* ---------- 对外 ---------- */
  return {
    /**
     * 进队一个素材的两档。当前连的是本机素材服务时是空操作(回 `{ queued: false, reason: 'local' }`)。
     * 同一原片已在队里就合并档位(例如小版后到),不改它的位置。回的 promise 在队列文件写回后兑现。
     * @param {{ name?: string, tiers: { tier: 'small' | 'original', hash: string, ext?: string }[] }} raw
     */
    async enqueue(raw) {
      const item = normalizeUploadItem(raw);
      if (!item) { say('upload.bad-item', {}); return { queued: false, reason: 'bad-item' }; }
      const where = target();
      if (!where || !where.client) {
        counters.skippedLocal++;
        say('upload.skip-local', { id: item.id });
        return { queued: false, reason: 'local' };
      }
      const existing = items.get(item.id);
      if (existing) {
        for (const t of item.tiers) if (!existing.tiers.some((x) => x.tier === t.tier)) existing.tiers.push(t);
        existing.tiers.sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier));
        counters.merged++;
      } else {
        items.set(item.id, { ...item, attempts: 0, nextAt: 0, seq: seq++ });
        counters.enqueued++;
        say('upload.enqueued', { id: item.id, name: item.name, tiers: item.tiers.map((t) => t.tier) });
      }
      await persist();
      if (running && !working) schedule(0);
      return { queued: true };
    },
    start() {
      if (running) return;
      running = true;
      schedule(0);
    },
    /** 停止:不再派新活,正在传的那一片发完就停(这一素材留在队里);等队列文件写完 */
    async stop() {
      running = false;
      clearTimer();
      controller?.abort();
      await persist();
      for (const resolve of waiters.splice(0)) resolve();
    },
    /** 立即重排(测试拨时钟后用;也会跳过队头的退避) */
    poke({ skipBackoff = false } = {}) {
      if (skipBackoff) for (const item of items.values()) item.nextAt = 0;
      if (running && !working) schedule(0);
    },
    /** 等队列空;已停止的立即返回 */
    drain() {
      if (!items.size || !running) return Promise.resolve();
      return new Promise((resolve) => waiters.push(resolve));
    },
    stats() {
      return {
        running, working, current, ...counters, lastError,
        items: [...items.values()].sort((a, b) => a.seq - b.seq).map((i) => ({ id: i.id, name: i.name, tiers: i.tiers.map((t) => t.tier), attempts: i.attempts })),
      };
    },
    get file() { return file; },
  };
}
