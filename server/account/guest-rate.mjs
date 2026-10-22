/**
 * 领游客令牌那一条路由的限流（2026-10-23 用户定「先用 IP 拦」）。
 *
 * 这条路由不要登录 —— 他还没有身份，要的就是这一张。于是谁都可以反复领新身份、每个身份建一个项目。
 * 真正挡得住的是验证码或账号，这一版不做；先按来访 IP 拦住随手刷的那一类。
 * **这不是严防**：换 IP 就绕过去了。报告与语义里都这么写，不要当成做完了。
 *
 * 取 IP 的办法（经 nginx 的部署里尤其要小心，否则一限就把所有人限成一个）：
 *   - 套接字对端**不是**回环：直连这台服务，用对端地址，转发头一概不看 —— 客户端自己写的转发头不可信。
 *   - 套接字对端**是**回环：这台机器上的 nginx 转进来的（部署配置里 `proxy_set_header X-Forwarded-For
 *     $proxy_add_x_forwarded_for`，它把 `$remote_addr` 追加在客户端那串**后面**）。所以取
 *     `X-Forwarded-For` 的**最后一跳**，那一跳是 nginx 亲眼看到的对端；客户端伪造的只会排在前面。
 *     不看 `X-Real-IP`、不看 `Forwarded`：nginx 不设它们，而客户端可以随便写，看了反而能被伪造。
 *     没有 `X-Forwarded-For` 就是真的本机请求，用对端地址。
 */
import { isLoopbackAddress, hopAddress } from '../auth/origin.mjs';

/** 限流的数（三级机制）：同一个 IP 任意连续 `windowMs` 里最多领 `max` 张 */
export const GUEST_RATE = Object.freeze({ max: 20, windowMs: 60 * 60 * 1000 });
/** 同时盯着多少个 IP。满了先丢最久没动过的那一批；盯不过来时宁可放过，也不把内存吃光 */
const MAX_TRACKED = 10_000;

const headerText = value => (Array.isArray(value) ? value.join(',') : typeof value === 'string' ? value : '');

/**
 * 这次请求该算在谁头上。说明见文件头。
 * @returns {string | null} 认不出来就 null（调用方按「不限」放过，别把认不出的全算成同一个人）
 */
export function clientKeyOf(req) {
  const peer = req?.socket?.remoteAddress ?? null;
  if (peer === null) return null;
  if (!isLoopbackAddress(peer)) return peer;
  const parts = headerText(req?.headers?.['x-forwarded-for']).split(',').map(hopAddress).filter(a => a !== null);
  return parts.length ? parts[parts.length - 1] : peer;
}

/**
 * 滑动窗口的小限流器。只在内存里：文档服务重启就清零 —— 这一条本来就只拦随手刷的，
 * 不值得为它落盘，也不该让它在重启之后把人挡在外面。
 *
 * @param {object} [options]
 * @param {number} [options.max] 窗口内最多几次
 * @param {number} [options.windowMs] 窗口多长（毫秒）
 * @param {() => number} [options.now]
 */
export function createGuestRateLimit({ max = GUEST_RATE.max, windowMs = GUEST_RATE.windowMs, now = Date.now } = {}) {
  /** @type {Map<string, number[]>} IP → 窗口里那几次的时刻（从早到晚） */
  const hits = new Map();
  const prune = (key, at) => {
    const kept = (hits.get(key) ?? []).filter(t => t > at - windowMs);
    if (kept.length) hits.set(key, kept); else hits.delete(key);
    return kept;
  };
  return {
    /**
     * 记一次并问收不收。
     * @returns {{ ok: true } | { ok: false, retryAfterSec: number }}
     */
    take(key, at = now()) {
      // 认不出是谁就不限:认不出的全算成同一个人的话,一个认不出的请求就能把所有认不出的挡住
      if (typeof key !== 'string' || !key) return { ok: true };
      const recent = prune(key, at);
      if (recent.length >= max) {
        // 最早那一次滚出窗口的时刻,就是最早能再来的时刻
        const retryAt = recent[recent.length - max] + windowMs;
        return { ok: false, retryAfterSec: Math.max(1, Math.ceil((retryAt - at) / 1000)) };
      }
      // 盯不过来了:先把已经空掉的清一遍,还满就丢最久没动过的一个(Map 按插入序,最前面的就是)
      if (!hits.has(key) && hits.size >= MAX_TRACKED) {
        for (const [k] of hits) { prune(k, at); if (hits.size < MAX_TRACKED) break; }
        if (hits.size >= MAX_TRACKED) hits.delete(hits.keys().next().value);
      }
      hits.set(key, [...recent, at]);
      return { ok: true };
    },
    /** 排查用：现在盯着几个 IP */
    size() { return hits.size; },
  };
}
