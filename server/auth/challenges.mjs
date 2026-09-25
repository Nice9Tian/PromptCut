/**
 * 挑战用的一次性随机数（契约 `docs/plan/auth-contract.md` 第 4、7 节）。
 *
 * `nonce` 是 32 字节随机数（base64url），只能用一次，60 s 过期，绑定一组字段（进入：`projectId`、`username`、
 * `deviceId`、`as`；创建者操作：连接与项目）。核对时不论成败，`nonce` 立即作废。
 * 只在内存里：文档服务重启后，没用掉的全部失效，客户端重新取即可。
 */
import { randomBytes } from 'node:crypto';

export const CHALLENGE_DEFAULTS = Object.freeze({ TTL_MS: 60_000, MAX: 20_000 });

/** 绑定的字段拼成一个键：各字段 JSON 化后按顺序拼，字段里有什么字符都不会串 */
const bindingKey = (binding) => JSON.stringify(binding);

/**
 * @param {object} [options]
 * @param {() => number} [options.now]
 * @param {number} [options.ttlMs]
 * @param {number} [options.max] 同时在册的上限；超出时丢最早发的
 */
export function createChallenges({ now = Date.now, ttlMs = CHALLENGE_DEFAULTS.TTL_MS, max = CHALLENGE_DEFAULTS.MAX } = {}) {
  /** nonce → { key, expires }；Map 按插入顺序，最早发的在前 */
  const live = new Map();

  function prune(at) {
    for (const [nonce, entry] of live) {
      if (entry.expires > at) break;
      live.delete(nonce);
    }
    while (live.size >= max) live.delete(live.keys().next().value);
  }

  return {
    /** 发一个 nonce，绑定 `binding`（数组，字段按固定顺序） */
    issue(binding) {
      const at = now();
      prune(at);
      const nonce = randomBytes(32).toString('base64url');
      live.set(nonce, { key: bindingKey(binding), expires: at + ttlMs });
      return nonce;
    },

    /** 核对并作废：存在、没过期、绑定一致才回 true；不论成败都删掉 */
    consume(nonce, binding) {
      if (typeof nonce !== 'string') return false;
      const entry = live.get(nonce);
      if (!entry) return false;
      live.delete(nonce);
      return entry.expires > now() && entry.key === bindingKey(binding);
    },

    /** 作废某个绑定前缀的全部 nonce（连接断开时清它的创建者挑战） */
    dropWhere(predicate) {
      for (const [nonce, entry] of live) if (predicate(JSON.parse(entry.key))) live.delete(nonce);
    },

    size: () => live.size,
  };
}
