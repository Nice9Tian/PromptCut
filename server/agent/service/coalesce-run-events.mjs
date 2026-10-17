/**
 * 把一轮回复里连续的文字 / 思考增量攒成一条再交给事件写入方。
 *
 * 模型按流式一小段一小段地吐字（实测平均每段 8 个字），原来每段都是一条事件：账号模式下每条事件都要走一次
 * 「任务进程 → 主服务 → 文档服务」的签名请求和账本事务。一条 4 万字的回复就是五千多条，文档服务一秒只吃得下一两条，
 * 页面要一个多小时才看完，文档服务主线程也一直满着（2026-10-17 实测）。攒到 250 毫秒或 4000 字发一次，几百条就够。
 *
 * 规矩：
 * - 只攒相邻的、类型相同（`text` 或 `thinking`）且除 `delta` 以外字段都相同的增量；来了别的事件，先把攒着的发出去，次序不变；
 * - `flush` / `beforeCall` / `receiptOf` 之前先把攒着的发出去（模型或工具调用之前、收尾之前，前面的字一定都已交出）；
 * - 攒着的那几段合成一条时返回值是 `undefined`（调用方只对终态事件用返回的事件号）。
 */
const MERGEABLE = new Set(['text', 'thinking']);

export const COALESCE_WINDOW_MS = 250;
export const COALESCE_MAX_CHARS = 4000;

const extraOf = event => JSON.stringify(Object.keys(event).filter(k => k !== 'delta').sort().map(k => [k, event[k]]));

export function coalesceRunEvents(writer, { windowMs = COALESCE_WINDOW_MS, maxChars = COALESCE_MAX_CHARS,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let pending = null, pendingExtra = null, timer = null;
  const drain = () => {
    if (timer !== null) { clearTimer(timer); timer = null; }
    if (!pending) return;
    const event = pending; pending = null; pendingExtra = null;
    writer.emit(event);
  };
  return {
    ...writer,
    emit(event) {
      const mergeable = event && MERGEABLE.has(event.type) && typeof event.delta === 'string';
      if (!mergeable) { drain(); return writer.emit(event); }
      const extra = extraOf(event);
      if (pending && pendingExtra === extra) pending = { ...pending, delta: pending.delta + event.delta };
      else { drain(); pending = { ...event }; pendingExtra = extra; }
      if (pending.delta.length >= maxChars) { drain(); return undefined; }
      if (timer === null) { timer = setTimer(drain, windowMs); timer?.unref?.(); }
      return undefined;
    },
    async flush() { drain(); return writer.flush(); },
    async beforeCall() { drain(); return writer.beforeCall(); },
    async receiptOf(eventId) { drain(); return writer.receiptOf(eventId); },
  };
}
