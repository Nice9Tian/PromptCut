/**
 * 渲染任务队列（M1）的出口。队列本体是纯内存状态机，这一阶段不被任何插件引用；
 * M5 挂上文档服务时由适配层按 SWEEP_INTERVAL_MS 驱动 tick、把 WebSocket 消息交给 handle。
 */
export { createRenderQueue } from './queue.mjs';
export { QUEUE_DEFAULTS, QUEUE_ENV } from './constants.mjs';
export { taskIdOf, lockKeyOf } from './messages.mjs';
