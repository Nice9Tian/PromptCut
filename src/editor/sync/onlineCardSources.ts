/**
 * 在线页面读内容库里的卡片源码,认出「已知但本机不能运行」的用户卡(C10 契约第 9 节「识别」,2026-09-29 用户改语义)。
 *
 * 在线包的卡片表是构建时从 `src/cards/user` 生成的,桌面版卡片库里的卡、经内容库同步的卡都不在表里;在线构建又关掉了
 * 页面侧的卡片同步(`cardSync.ts`)。于是这里经页面已有的文档服务连接(在线来源用的同一条 `docRequest`,不走 `/api`):
 *
 *   `content.list({ kind: 'card-source', prefix: 'src/cards/user/' })` → 入口文件(`src/cards/user/<名>.tsx`)里
 *   哈希变了的逐条 `content.get` → 正文就是源码字符串(`server/card-sync.mjs`)→ `parseCardSource` 取卡片的 id 与名字
 *   → `registry.setSyncedUserCards`(不执行源码,也不进主注册表)。
 *
 * 跟变化的办法选**定时重取**(每 `CARD_SOURCE_POLL_MS` 列一次,哈希没变的不再取正文),不订阅 `content.watch`:
 * 内容库的订阅按连接只认最后一次 `watch` 的那一组,与同一条连接上别的订阅方会互相顶掉;会话接续、重连时也不必补订阅。
 * 连接换了(重连、换项目、离开共享项目)清表重取。取不到(没连上、被拒、超时)时手里的表不动,下一轮再试。
 */
import { isUserCardEntryKey, parseCardSource } from "../../kernel/cardSourceParse.mjs";
import { setSyncedUserCards, type SyncedUserCard } from "../../kernel/registry";

/** 多久重列一次内容库的卡片源码 */
export const CARD_SOURCE_POLL_MS = 5_000;
/** 内容库里用户卡源码的键前缀 */
export const CARD_SOURCE_PREFIX = "src/cards/user/";
export const CARD_SOURCE_KIND = "card-source";

type Request = (msg: Record<string, unknown>, timeoutMs?: number) => Promise<Record<string, unknown>>;

export interface OnlineCardSourcesDeps {
  request: Request;
  /** 此刻的连接(共享项目的链接对象;变了就清表重取,null = 没连上共享项目) */
  linkKey: () => unknown;
  /** 表变了(写进注册表之后) */
  onChange?: (entries: SyncedUserCard[]) => void;
  /** 写进哪里;缺省注册表 */
  apply?: (entries: SyncedUserCard[]) => boolean;
  requestTimeoutMs?: number;
  now?: () => number;
}

/** 一份列表 + 已取到的正文 → 同步用户卡的条目(按键、按源码里的先后;同一 id 取第一条) */
export function entriesOf(keys: readonly string[], parsed: ReadonlyMap<string, { id: string; name: string }[]>): SyncedUserCard[] {
  const out: SyncedUserCard[] = [];
  const seen = new Set<string>();
  for (const key of [...keys].sort()) {
    for (const c of parsed.get(key) ?? []) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push({ id: c.id, name: c.name, source: key });
    }
  }
  return out;
}

export class OnlineCardSources {
  private readonly deps: OnlineCardSourcesDeps;
  private link: unknown = null;
  /** 键 → 这份正文的哈希与解析结果 */
  private readonly cache = new Map<string, { hash: string; cards: { id: string; name: string }[] }>();
  private busy: Promise<void> | null = null;
  private entries: SyncedUserCard[] = [];
  private stopped = false;
  readonly stats = { lists: 0, gets: 0, errors: 0, lastSyncAt: 0, lastError: "" as string, truncated: false };

  constructor(deps: OnlineCardSourcesDeps) {
    this.deps = deps;
  }

  private apply(entries: SyncedUserCard[]): void {
    this.entries = entries;
    const changed = (this.deps.apply ?? setSyncedUserCards)(entries);
    if (changed) this.deps.onChange?.(entries);
  }

  private request(msg: Record<string, unknown>): Promise<Record<string, unknown>> {
    const ms = this.deps.requestTimeoutMs ?? 10_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      this.deps.request(msg, ms),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("内容库请求超时")), ms); }),
    ]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
  }

  /** 跑一轮;正在跑就等那一轮 */
  sync(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.busy) return this.busy;
    this.busy = this.syncOnce().finally(() => { this.busy = null; });
    return this.busy;
  }

  private async syncOnce(): Promise<void> {
    const link = this.deps.linkKey();
    if (link !== this.link) {
      // 连接换了:换项目时别的项目的卡不能留着
      this.link = link;
      this.cache.clear();
      this.apply([]);
    }
    if (!link) return;
    let listing: Record<string, unknown>;
    try {
      listing = await this.request({ type: "content.list", kind: CARD_SOURCE_KIND, prefix: CARD_SOURCE_PREFIX });
      this.stats.lists++;
    } catch (err) {
      this.stats.errors++;
      this.stats.lastError = String((err as Error)?.message ?? err).slice(0, 160);
      return;
    }
    if (this.stopped || this.deps.linkKey() !== link) return;
    if (listing?.type !== "content.listing" || !Array.isArray(listing.items)) {
      this.stats.errors++;
      this.stats.lastError = `回包不对:${String(listing?.type ?? "")}`.slice(0, 160);
      return;
    }
    this.stats.truncated = listing.truncated === true;
    const items = (listing.items as { key?: unknown; hash?: unknown }[])
      .filter((it) => isUserCardEntryKey(it?.key))
      .map((it) => ({ key: String(it.key), hash: typeof it.hash === "string" ? it.hash : "" }));
    const keys = items.map((it) => it.key);
    for (const k of [...this.cache.keys()]) if (!keys.includes(k)) this.cache.delete(k);
    for (const it of items) {
      const hit = this.cache.get(it.key);
      if (hit && it.hash && hit.hash === it.hash) continue;
      try {
        const got = await this.request({ type: "content.get", kind: CARD_SOURCE_KIND, key: it.key });
        this.stats.gets++;
        if (this.stopped || this.deps.linkKey() !== link) return;
        if (got?.type !== "content.item" || got.missing) { this.cache.delete(it.key); continue; }
        const body = typeof got.body === "string" ? got.body : "";
        this.cache.set(it.key, { hash: typeof got.hash === "string" ? got.hash : it.hash, cards: parseCardSource(body) });
      } catch (err) {
        // 这一条这轮取不到:留着旧的解析结果(有的话),下一轮再取
        this.stats.errors++;
        this.stats.lastError = String((err as Error)?.message ?? err).slice(0, 160);
      }
    }
    const parsed = new Map([...this.cache].map(([k, v]) => [k, v.cards] as const));
    this.apply(entriesOf([...this.cache.keys()], parsed));
    this.stats.lastSyncAt = (this.deps.now ?? Date.now)();
  }

  /** 此刻认出的卡(诊断、探针用) */
  debug() {
    return {
      link: !!this.link,
      keys: [...this.cache.keys()].sort(),
      cards: this.entries.map((e) => ({ ...e })),
      ...this.stats,
    };
  }

  /** 停下并清表(离开在线页面、换档重建时) */
  stop(): void {
    this.stopped = true;
    this.cache.clear();
    this.link = null;
    this.apply([]);
  }
}
