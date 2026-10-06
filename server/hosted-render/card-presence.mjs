/**
 * 「这个项目带没带卡片代码」的判定（契约 `docs/plan/hosted-render-contract.md` 第 7.5 节，方案 A）。
 * 托管方渲染服务的**常驻工作进程**用：它不同步任何卡、不执行任何项目带来的代码，所以要知道哪些项目得交给隔离工作进程。
 *
 * 判据只有一条：项目的内容库里有没有 `card-source`（用户卡，或改过的内置卡、部件——都是项目带来的代码）。
 *   - 连上（或重建会话）后列一次，并订阅这一类的变化；之后每条 `content.changed` 重列；另每 `refreshMs` 兜底重列一次；
 *   - 状态 `unknown`（还没列出来、或列失败）/ `none` / `some`。**`unknown` 与 `some` 都搁着不认领**：
 *     宁可晚一拍，也不让常驻工作进程在不知道有没有卡的时候去切分、去渲；
 *   - 只读、只列键，不取正文：卡片源码一个字节都不进常驻工作进程。
 *
 * 不开计时器：由调用方按节拍调 `tick()`。连接归队列节点，这里不关。
 */

export const CARD_SOURCE_KIND = 'card-source';
export const CARD_PRESENCE_DEFAULTS = Object.freeze({ REFRESH_MS: 15_000, RETRY_MS: 2000 });

/**
 * @param {object} o
 * @param {{ send(m: object): unknown, onMessage(h: (m: any) => void): void, onOpen?(h: () => void): void, onClose?(h: (i: any) => void): void, connected?: boolean }} o.endpoint
 * @param {{ list(kind: string, prefix?: string): Promise<{ items: { key: string }[], truncated?: boolean }> }} o.content 内容库客户端
 * @param {() => number} [o.now]
 * @param {(event: string, fields?: object) => void} [o.log]
 */
export function createCardPresence({ endpoint, content, now = Date.now, log = () => {}, refreshMs = CARD_PRESENCE_DEFAULTS.REFRESH_MS, retryMs = CARD_PRESENCE_DEFAULTS.RETRY_MS }) {
  /** @type {'unknown' | 'none' | 'some'} */
  let state = 'unknown';
  let count = 0;
  let listedAt = null;
  let nextAt = 0;
  let busy = false;
  let dirty = false;
  let closed = false;
  let seq = 0;
  let lists = 0;

  const set = (next, n) => {
    if (next !== state) log('cards.presence', { from: state, to: next, count: n });
    state = next;
    count = n;
  };

  async function refresh() {
    if (closed) return;
    if (busy) { dirty = true; return; }
    busy = true;
    dirty = false;
    try {
      const listing = await content.list(CARD_SOURCE_KIND);
      if (closed) return;
      const n = Array.isArray(listing?.items) ? listing.items.length : 0;
      lists += 1;
      listedAt = now();
      nextAt = listedAt + refreshMs;
      // 列表被截断（键太多）也算有
      set(n > 0 || listing?.truncated === true ? 'some' : 'none', n);
    } catch (err) {
      // 列不出来：状态不往「没有」走（原来是 some 的保持 some，否则 unknown），过一会儿再试
      if (state === 'none') set('unknown', 0);
      nextAt = now() + retryMs;
      log('cards.presence-error', { message: String(err?.code ?? err?.message ?? err) });
    } finally {
      busy = false;
      if (dirty && !closed) void refresh();
    }
  }

  function subscribe() {
    try { endpoint.send({ type: 'content.watch', kinds: [CARD_SOURCE_KIND], reqId: `presence#watch-${++seq}` }); } catch { /* 没连上：下次连上再订 */ }
  }

  endpoint.onMessage((msg) => {
    if (closed || msg?.type !== 'content.changed' || msg.kind !== CARD_SOURCE_KIND) return;
    // 有人写了卡片源码：先按「有」算（搁着），再重列确认
    if (state !== 'some') set('some', Math.max(1, count));
    void refresh();
  });
  const onOpen = () => {
    if (closed) return;
    // 新会话：订阅没了，状态也不能沿用（断开期间可能有人写过）
    if (state === 'none') set('unknown', 0);
    subscribe();
    void refresh();
  };
  if (typeof endpoint.onOpen === 'function') {
    endpoint.onOpen(onOpen);
    if (endpoint.connected === true) queueMicrotask(onOpen);
  } else {
    queueMicrotask(onOpen);
  }
  endpoint.onClose?.(() => { if (!closed && state === 'none') set('unknown', 0); });

  return {
    /** 按节拍调：到点兜底重列 */
    tick() { if (!closed && !busy && now() >= nextAt) void refresh(); },
    /** 要不要搁着不认领：只有确知「没有卡片代码」才不搁 */
    hold: () => state !== 'none',
    state: () => state,
    status: () => ({ state, count, listedAt, lists }),
    refresh,
    close() { closed = true; },
  };
}
