/**
 * 节点按能力过滤可认领的任务(设计 4.3,契约 B.2)。
 *
 * 文档服务把可见的 `open` 任务摘要推给节点,节点**自己**判断接不接:文档服务只记账,
 * 不测算算力、不分配。按规则号顺序检查,第一条不过就返回:
 *
 *   0  纯浏览器只接本人的任务(服务端已按凭证把关,这里再挡一次)
 *   1  环境指纹、代码版本、卡片源码版本对得上(`plan` 任务只查代码版本:谁认领谁的指纹就是这一版的指纹;
 *      带 `requires.preferNode` 的 `plan` 另查指纹,M6c X4);`requires.localMedia` 给了就要等于本节点的
 *      `nodeId`(M6c X2 本地档能力闸,`node.nodeId` 由会话补上)
 *   2  要求 `capabilities.streams` 的任务(M6c X1 起的流任务)需要节点报 `streams: true`(没报这一项的旧形状
 *      按 `transcode` 算);
 *      轨道流 / 要转码的任务需要转码能力
 *   3  用户卡、图卡需要对应能力
 *   4  重度策略(见 `DEFAULT_WEIGHT_POLICY`)
 *   5  内存要求不超过本机可用内存
 *   6  `plan` 任务要 Chrome 和服务端的 card-cache,纯浏览器不接;独立渲染主机(`host`)不接不带片段清单的 `plan` ——
 *      桌面 `plan` 留给发布方自己的节点(M6b,`docs/plan/render-host-contract.md` 第 3、4 节);带片段清单的 `plan`
 *      (在线页面的清单计划、低内存档的补渲计划)`host` 接,用自己的指纹切分(C10 契约第 18 节第 9 条,对 M6c X4 的修改)
 *   7  纯浏览器的快照任务只收共享档(`tier: 'shared'`)的独立卡(`input.compositing === 'independent'`,切分方在浏览器那一份
 *      里写):M7 契约第 3.2 节与 D4(桌面只把独立卡的页面测量帧当预渲染结果;本地档要整场景渲)。不只靠切分方把本地档记 heavy。
 *      画布卡(`input.canvasHeavy`)也不收:浏览器逐帧顺推生成快照,画布卡与桌面 4 帧一批的结果不等价(M7 探针 P2,主会话裁定)
 *   8  仅供测试(M7 契约 D15):节点描述带 `planOnly: true` 时只认领 `plan`、不认领细任务 —— 验收时切分方只切分,
 *      不和纯浏览器抢同一批卡。只在测试环境变量 `PROMPTCUT_TEST_PLAN_ONLY=1` 时由调用方设(`testPlanOnly`),生产不设
 *
 * 纯函数,不改入参。
 */
import { isListPlan } from '../render-queue/messages.mjs';

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

/** → `{ ok: true }` | `{ ok: false, rule: 0..8, reason }`。 */
export function checkClaimable(task, node) {
  const requires = task?.requires ?? {};
  const capabilities = node?.capabilities ?? {};
  const browser = node?.profile === 'browser';
  const host = node?.profile === 'host';
  const plan = task?.kind === 'plan';

  // 0
  if (browser && task?.source?.userId !== node.userId) return reject(0, 'other-user');

  // 1
  // 带 preferNode 的 plan(M6c X4)窗口过后给「指纹符合的 pc」,所以也查指纹;没带的旧形状照旧不查
  const checksFingerprint = !plan || requires.preferNode != null;
  if (checksFingerprint && requires.envFingerprint != null && requires.envFingerprint !== node?.envFingerprint) {
    return reject(1, 'env-fingerprint');
  }
  // 本地档能力闸(M6c X2):输入里有只在发布方本机的素材(没有内容哈希),只有那个节点接
  if (requires.localMedia != null && requires.localMedia !== node?.nodeId) return reject(1, 'local-media');
  if (requires.codeVersion != null && !(node?.codeVersions ?? []).includes(requires.codeVersion)) {
    return reject(1, 'code-version');
  }
  if (!plan && requires.cardSources && typeof requires.cardSources === 'object') {
    for (const [cardId, version] of Object.entries(requires.cardSources)) {
      if (!(node?.cardSourceVersions?.[cardId] ?? []).includes(version)) return reject(1, 'card-source');
    }
  }

  // 2(M6c X1:任务要求 `capabilities.streams` 时,节点要报 `streams: true`,即本机探到了编码器;
  //   没报 `streams` 这一项的节点(M6c 之前的形状)按它的转码能力算,报了 `false` 的一律不收)
  if (requires.capabilities?.streams === true && (capabilities.streams ?? capabilities.transcode) !== true) return reject(2, 'streams');
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
  if (plan && host && !isListPlan(task)) return reject(6, 'plan-on-host');

  // 7(M7 D4):纯浏览器只做共享档的独立卡;画布卡(canvasHeavy)逐帧顺推与桌面不等价(探针 P2),重度本来就挡,这里再挡一次
  if (browser && task?.kind === 'snapshot') {
    if (task.tier !== 'shared') return reject(7, 'tier');
    if (task.input?.compositing !== 'independent') return reject(7, 'not-independent');
    if (task.input?.canvasHeavy === true) return reject(7, 'canvas-heavy');
  }

  // 8(M7 D15,仅供测试):只切分、不认领细任务
  if (node?.planOnly === true && !plan) return reject(8, 'plan-only');

  return pass;
}

/**
 * 仅供测试(M7 契约 D15):测试环境变量 `PROMPTCUT_TEST_PLAN_ONLY` 为 `1` 时回 true,调用方据此给节点描述带 `planOnly: true`
 * (规则 8)。照 `PROMPTCUT_TEST_ENV_FINGERPRINT` 的写法:只在这个变量存在时生效,生产环境不设。纯函数,环境变量由调用方传。
 */
export function testPlanOnly(env) {
  return String(env?.PROMPTCUT_TEST_PLAN_ONLY ?? '') === '1';
}

/** 过滤出本节点能认领的任务,保持原顺序。 */
export function filterClaimable(tasks, node) {
  return (tasks ?? []).filter(task => checkClaimable(task, node).ok);
}
