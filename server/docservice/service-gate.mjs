/**
 * 托管方服务身份的权限：白名单（契约 `docs/plan/hosted-render-contract.md` 第 1.3、1.5 节）。
 *
 * 带 `service` 字段的连接按「缺省拒绝」接入：不在表里的消息类型一律 `forbidden`，表里没有这个服务就全拒。按 `service` 字段判、
 * 不按 `scope`：代成员进项目的服务（云端 Agent，`scope: 'member'` 加 `service: 'agent'`）同样走白名单。现有模块里按 `scope === 'member'` 拒绝的判断
 * （如服务地址登记）对新 scope 会变成放行，所以不靠逐个模块补判断，统一在组装层的 `gate(principal, type, msg)` 这一处把关。
 *
 * - **控制连接**（`scope: 'service'`、没有 `tenantId`，握手凭服务私钥得到）：只能发目录模块的 `hosted.watch`、`hosted.ticket`、
 *   `hosted.demand`、`hosted.delegate.verify`（最后一个由第四段实现，目录模块现在回 `unsupported`）；
 * - **数据连接**（凭目录模块签的票据进某个项目）：按服务名查 `SERVICE_ALLOW`。本段只有渲染服务一行；第四段加 `agent` 一行。
 *   三种消息另看内容：`content.put` 只许写预渲染清单，`auth.ticket` 只许要素材票据（要连接票据等于给自己换角色），
 *   `task.publish` 不许发布计划任务（渲染服务只发布自己切分出来的细任务）；
 * - 不是服务身份的连接发 `hosted.*` 一律 `forbidden`。
 *
 * 纯函数，不引任何模块。
 */

/** 控制连接能发的消息 */
export const SERVICE_CONTROL_TYPES = Object.freeze(['hosted.watch', 'hosted.ticket', 'hosted.demand', 'hosted.delegate.verify']);

/** 渲染服务能往内容库写的类别（预渲染清单） */
export const RENDER_CONTENT_KINDS = Object.freeze(['snapshot-manifest', 'render-manifest']);

/** 服务名 → 数据连接能发的消息类型 */
export const SERVICE_ALLOW = Object.freeze({
  render: Object.freeze([
    // 报到、认领、交付
    'node.hello', 'node.active', 'queue.watch', 'publisher.hello', 'task.publish',
    'task.claim', 'task.progress', 'task.complete', 'task.fail', 'task.release',
    // 读项目
    'project.open', 'project.close', 'project.snapshot.get',
    // 读内容库；写只许预渲染清单（下面按 kind 再判）
    'content.get', 'content.list', 'content.watch', 'content.put',
    // 素材服务的地址与票据（票据只许 asset，下面再判）
    'service.watch', 'auth.ticket',
  ]),
});

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * @param {object} principal
 * @param {string} type
 * @param {object} [msg] 整条消息（三种消息要看内容）
 * @returns {string | null} 不放行的原因；放行回 null
 */
export function serviceGate(principal, type, msg) {
  const isService = typeof principal?.service === 'string' || principal?.scope === 'service';
  if (!isService) return type.startsWith('hosted.') ? 'forbidden' : null;
  const inSpace = typeof principal.tenantId === 'string' && principal.tenantId !== '';
  if (!inSpace) return principal.scope === 'service' && SERVICE_CONTROL_TYPES.includes(type) ? null : 'forbidden';
  const allow = Object.hasOwn(SERVICE_ALLOW, principal.service) ? SERVICE_ALLOW[principal.service] : null;
  if (!allow || !allow.includes(type)) return 'forbidden';
  if (principal.service === 'render') {
    if (type === 'content.put' && !RENDER_CONTENT_KINDS.includes(msg?.kind)) return 'forbidden';
    if (type === 'auth.ticket' && msg?.kind !== 'asset') return 'forbidden';
    if (type === 'task.publish') {
      // 形状不对的交给队列回 bad-message；这里只挡计划任务
      const tasks = Array.isArray(msg?.tasks) ? msg.tasks : [];
      if (tasks.some((t) => isObj(t) && t.kind === 'plan')) return 'forbidden';
    }
  }
  return null;
}
