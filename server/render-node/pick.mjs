/**
 * 候选挑选(设计 4.3 末段、第 7 节「公平性」,契约 B.3)。
 *
 * 排序:`priority` 降序 → `source.publishedAt` 升序 → `id` 升序(按码元比较,结果与区域设置无关)。
 * 然后在前 K 个里随机取一个去认领:所有节点都抢第一名的话会互相撞出一串 `taken`。
 * 给了 `lastProjectId` 时,同优先级里先换一个项目(多项目共用一台渲染主机时的轮转)。
 *
 * 纯函数;随机源由调用方注入,测试可以固定。
 */

const priorityOf = task => (Number.isFinite(task?.priority) ? task.priority : 0);
// 没有发布时刻的(还没进过队列的 TaskInput)排在同优先级的最后
const publishedAtOf = task => (Number.isFinite(task?.source?.publishedAt) ? task.source.publishedAt : Infinity);
const idOf = task => String(task?.id ?? '');

function compare(a, b) {
  const byPriority = priorityOf(b) - priorityOf(a);
  if (byPriority) return byPriority;
  const pa = publishedAtOf(a), pb = publishedAtOf(b);
  if (pa !== pb) return pa < pb ? -1 : 1;
  const ia = idOf(a), ib = idOf(b);
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}

/** 新数组,不改入参。 */
export function rankCandidates(tasks) {
  return [...(tasks ?? [])].sort(compare);
}

/** → 任务或 `null`。`random()` 取值 `[0, 1)`。 */
export function pickCandidate(tasks, { k = 4, random = Math.random, lastProjectId = null } = {}) {
  if (!tasks?.length) return null;
  const top = rankCandidates(tasks).slice(0, Math.max(1, Math.floor(Number(k) || 0)));
  let candidates = top;
  if (lastProjectId != null) {
    const head = priorityOf(top[0]);
    const rotated = top.filter(task => priorityOf(task) === head && task.source?.projectId !== lastProjectId);
    if (rotated.length) candidates = rotated;
  }
  const index = Math.floor(random() * candidates.length);
  return candidates[Math.min(candidates.length - 1, Math.max(0, index))] ?? null;
}
