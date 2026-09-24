/**
 * 节点按能力过滤可认领的任务(设计 4.3,契约 B.2)。
 *
 * 文档服务把可见的 `open` 任务摘要推给节点,节点**自己**判断接不接:文档服务只记账,
 * 不测算算力、不分配。按规则号顺序检查,第一条不过就返回:
 *
 *   0  纯浏览器只接本人的任务(服务端已按凭证把关,这里再挡一次)
 *   1  环境指纹、代码版本、卡片源码版本对得上(`plan` 任务只查代码版本:谁认领谁的指纹就是这一版的指纹)
 *   2  轨道流 / 要转码的任务需要转码能力
 *   3  用户卡、图卡需要对应能力
 *   4  重度策略(见 `DEFAULT_WEIGHT_POLICY`)
 *   5  内存要求不超过本机可用内存
 *   6  `plan` 任务要 Chrome 和服务端的 card-cache,纯浏览器不接
 *
 * 纯函数,不改入参。
 */

/**
 * 各类节点的重度策略表。每一项的取值:
 *
 *   'all'                        全收
 *   ['light', 'medium', …]       只收列出的重度
 *   'own-or-light'               自己的项目(`ownProjectIds`)全收,别人的只收 `light`
 *   { editing, idle }            按 `node.editing === true` 取其一,再按上面三种解释
 *
 * 节点给了 `weightPolicy` 时,缺的那一类按本表补。
 */
export const DEFAULT_WEIGHT_POLICY = Object.freeze({
  browser: Object.freeze(['light', 'medium']),
  pc: Object.freeze({ editing: 'own-or-light', idle: 'all' }),
  host: 'all',
});

const pass = Object.freeze({ ok: true });
const reject = (rule, reason) => ({ ok: false, rule, reason });

function weightAllowed(rule, weightClass, task, node) {
  if (rule === 'all') return true;
  if (Array.isArray(rule)) return rule.includes(weightClass);
  if (rule === 'own-or-light') {
    return weightClass === 'light' || (node.ownProjectIds ?? []).includes(task.source?.projectId);
  }
  if (rule && typeof rule === 'object') {
    return weightAllowed(node.editing === true ? rule.editing : rule.idle, weightClass, task, node);
  }
  // 认不出的策略:保守,不收
  return false;
}

/** → `{ ok: true }` | `{ ok: false, rule: 0..6, reason }`。 */
export function checkClaimable(task, node) {
  const requires = task?.requires ?? {};
  const capabilities = node?.capabilities ?? {};
  const browser = node?.profile === 'browser';
  const plan = task?.kind === 'plan';

  // 0
  if (browser && task?.source?.userId !== node.userId) return reject(0, 'other-user');

  // 1
  if (!plan && requires.envFingerprint != null && requires.envFingerprint !== node?.envFingerprint) {
    return reject(1, 'env-fingerprint');
  }
  if (requires.codeVersion != null && !(node?.codeVersions ?? []).includes(requires.codeVersion)) {
    return reject(1, 'code-version');
  }
  if (!plan && requires.cardSources && typeof requires.cardSources === 'object') {
    for (const [cardId, version] of Object.entries(requires.cardSources)) {
      if (!(node?.cardSourceVersions?.[cardId] ?? []).includes(version)) return reject(1, 'card-source');
    }
  }

  // 2
  if ((task?.kind === 'stream' || requires.transcode === true) && !capabilities.transcode) return reject(2, 'transcode');

  // 3
  if (requires.userCards === true && !capabilities.userCards) return reject(3, 'user-cards');
  if (requires.graphCards === true && !capabilities.graphCards) return reject(3, 'graph-cards');

  // 4
  const policy = node?.weightPolicy ?? DEFAULT_WEIGHT_POLICY;
  const rule = policy[node?.profile] ?? DEFAULT_WEIGHT_POLICY[node?.profile];
  const weightClass = task?.weight?.class ?? 'medium';
  if (!weightAllowed(rule, weightClass, task ?? {}, node ?? {})) return reject(4, 'weight');

  // 5
  if (Number.isFinite(requires.memoryMB) && Number.isFinite(capabilities.memoryMB) && requires.memoryMB > capabilities.memoryMB) {
    return reject(5, 'memory');
  }

  // 6
  if (plan && browser) return reject(6, 'plan-on-browser');

  return pass;
}

/** 过滤出本节点能认领的任务,保持原顺序。 */
export function filterClaimable(tasks, node) {
  return (tasks ?? []).filter(task => checkClaimable(task, node).ok);
}
