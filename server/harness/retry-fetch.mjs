/**
 * 给 API 直连的请求加自动重试。
 *
 * # 起因
 *
 * 中转站在上游拥挤时会直接回:
 *
 *   openai HTTP 429: Current group upstream load is saturated, please try again later
 *
 * 这类错误是**临时的**,过几秒再发一次多半就成了。而现在一撞上就整条对话报错中断,
 * 用户看到的是一条红字,而不是稍等一下的结果。
 *
 * # 哪些码值得重试
 *
 * 照 openlux 文档的 HTTP Status Codes 那一页(doc.openlux.ai/en/tutorials/http-status-codes):
 *
 *   408 Timeout            "Shrink payload, retry, or use async APIs"
 *   429 Too Many Requests  "Back off; lower concurrency"
 *   500 Internal Error     "Retry later"
 *   502 / 503 / 504        "Exponential backoff; reduce concurrency at peak"
 *
 * 不重试的:400(参数错)、401(密钥错)、403(没权限 / 模型不在组里 / IP 不允许)、
 * 404(路径或任务 id 错)。这几个再发一百次也是同一个结果,重试只会拖慢报错、
 * 让用户更晚看到真正该改的东西。
 *
 * 网络层的异常(连接被重置、DNS 抽风、TLS 握手失败)也重试 —— 那和 502 是一回事。
 * 但 **AbortError 不重试**:那是用户点了停止、或者上层超时,重试等于不听话。
 *
 * # 为什么只包住「发请求」这一下,不包流
 *
 * 这些都是流式请求。重试**只在还没开始读流之前**是安全的:
 * 拿到错误状态码时一个字节的正文都还没交给上层,重发是干净的。
 * 而流读到一半断掉时再重发整个请求,模型会从头再说一遍,已经显示出去的那半段
 * 就重复了 —— 那种情况必须让它报错,由用户决定要不要重来。
 * 所以这个包装器只认「响应还没返回」和「响应返回了但状态码是可重试的」这两种。
 */

/** 文档里写明可以重试的状态码 */
export const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export const DEFAULT_RETRY = Object.freeze({
  /** 最多重试几次(不含第一次)。用户要求 10 */
  maxRetries: 10,
  /** 第一次退避多久 */
  baseDelayMs: 500,
  /** 单次退避的上限。指数涨上去之后就按这个走 */
  maxDelayMs: 8000,
  /**
   * 整个请求(含所有重试和等待)的总预算。
   *
   * 单看次数是不够的:每一次尝试自己还有 120 秒超时,10 次全用满就是二十几分钟,
   * 那时候用户早就以为卡死了。到点就不再重试,把最后一次的错误如实抛出去。
   */
  maxTotalMs: 5 * 60 * 1000,
});

/** 睡一会儿,期间可以被 abort 打断(用户点停止时不该还在傻等) */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    const t = setTimeout(() => { signal?.removeEventListener?.('abort', onAbort); resolve(); }, ms);
    function onAbort() { clearTimeout(t); reject(signal.reason ?? new Error('aborted')); }
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

/** 用户点了停止 / 上层超时 —— 这种不重试 */
function isAbort(e) {
  return e?.name === 'AbortError' || e?.name === 'TimeoutError' || /aborted|abort/i.test(String(e?.message || ''));
}

/**
 * 服务端说了「多久之后再来」就听它的。
 * `Retry-After` 可以是秒数,也可以是 HTTP 日期。给个上限,免得对方甩一个很大的值过来把我们挂死。
 */
function retryAfterMs(response, capMs) {
  const raw = response?.headers?.get?.('retry-after');
  if (!raw) return null;
  const secs = Number(raw);
  let ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(raw) - Date.now();
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.min(ms, capMs);
}

/** 第 n 次重试等多久:指数退避 + 抖动。抖动是为了别让并发的几条请求在同一刻一起回来再撞一次 */
export function backoffMs(attempt, { baseDelayMs, maxDelayMs }, rand = Math.random) {
  const raw = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
  return Math.round(raw * (0.5 + rand() * 0.5));
}

/**
 * 把一个 fetch 包成会自动重试的。
 *
 * @param fetchImpl 真正发请求的那个(每次尝试都会重新调它 —— 里面通常会新建
 *                  per-attempt 的超时 signal,不能复用上一次那个已经烧掉的)
 * @param opts.signal   用户的停止信号。退避等待期间也听它
 * @param opts.onRetry  每次决定重试时回调 `{ attempt, status, delayMs, reason }`,用来打日志
 */
export function createRetryingFetch(fetchImpl, opts = {}) {
  const cfg = { ...DEFAULT_RETRY, ...opts };
  const { signal, onRetry, rand } = opts;

  return async function retryingFetch(url, init) {
    const startedAt = cfg.now ? cfg.now() : Date.now();
    const now = () => (cfg.now ? cfg.now() : Date.now());
    let lastError = null;

    for (let attempt = 0; ; attempt++) {
      let response = null;
      try {
        response = await fetchImpl(url, init);
      } catch (e) {
        if (isAbort(e)) throw e;          // 用户喊停,不重试
        lastError = e;
      }

      if (response && !RETRYABLE_STATUS.has(response.status)) return response;

      const canRetry = attempt < cfg.maxRetries;
      const overBudget = now() - startedAt >= cfg.maxTotalMs;
      if (!canRetry || overBudget) {
        // 退不动了:有响应就把它原样交上去(让 assertOk 去解析出人话),否则抛最后那个网络异常
        if (response) return response;
        throw lastError;
      }

      const delay = (response && retryAfterMs(response, cfg.maxDelayMs))
        ?? backoffMs(attempt, cfg, rand);

      // 错误响应的正文要消费掉,不然连接可能一直挂着不还给连接池
      if (response) { try { await response.text(); } catch { /* 无所谓 */ } }

      onRetry?.({
        attempt: attempt + 1,
        of: cfg.maxRetries,
        status: response ? response.status : null,
        delayMs: delay,
        reason: response ? `HTTP ${response.status}` : String(lastError?.message || lastError),
      });

      await sleep(delay, signal);
    }
  };
}
