/**
 * 本机渲染节点的编排(分布式预渲染 M3,契约 `docs/plan/render-queue-contract.md` D 节)。
 *
 * 生产编排模块:只认注入进来的接口(到队列的端点、执行器、产物库)。
 * 环回传输、假执行器、假产物库只在 `server/test/`,这里不引用。
 *
 * 骨架,实现随后补上。
 */

export function createLocalNode() {
  throw new Error('createLocalNode: 尚未实现');
}
