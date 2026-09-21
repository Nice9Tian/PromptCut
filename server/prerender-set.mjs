/**
 * 预渲染集合 `plan.prerenderSet`(pinned 渲染 9)的窄接口。
 *
 * 真正的实现是 R4a 的 `src/render/pipelinePlan.mjs` 的 `planPipelines`:按 K1 的
 * 实测成本贪心分派,**任一位置判重的卡的并集**就是预渲染集合。它还没合进来,所以
 * 这里先留一个同形状的口子,预渲染进程需要「产哪些卡」的地方一律问它,合并 R4a
 * 之后只要把函数体换成 `planPipelines(...).prerenderSet` 即可,调用点不用动。
 *
 * TODO(R4a):接上 `src/render/pipelinePlan.mjs` 的 `planPipelines(project, costs, fps)`。
 *
 * 临时兜底按**声明**算(任务书「约束 / 不做」末条:声明只在探针结果到达前兜底):
 * `direct` 卡不产快照(它按 `t` 直接算得出来),其余(stateful、含 `unknown`)都产。
 * 这和今天的行为一致 —— 今天 `fillCardControls` / `snapshotTier` 就是按
 * `frameMode === 'stateful'` 挑的,所以接上 R4a 之前不会多产也不会少产。
 */

/** 一张卡(control / 审阅表 capabilities)在兜底口径下要不要进预渲染集合 */
export function declaredHeavy(capabilities) {
  const caps = capabilities ?? {};
  if (caps.frameMode === 'direct') return false;
  return caps.frameMode === 'stateful' || caps.need_prerendering === true || caps.needPrerendering === true;
}

/**
 * `prerenderSetOf(project, costs, fps) -> Set<clipId>`。
 *
 * 形参照 R4a 的 `planPipelines` 对齐(`costs` 现在还没人读,留着占位)。`project`
 * 只用得到 `tracks[].clips[]`,每个 clip 的能力从 `capabilitiesOf` 取 —— 调用方
 * 手里有 card plan 时直接传 plan 更准(见 `prerenderSetOfPlan`)。
 */
// eslint-disable-next-line no-unused-vars
export function prerenderSetOf(project, costs = null, fps = Number(project?.fps) || 30, capabilitiesOf = () => undefined) {
  const set = new Set();
  for (const track of project?.tracks ?? []) {
    for (const clip of track?.clips ?? []) {
      if (!clip?.id || !(clip.cardId || clip.nodeId)) continue;
      if (declaredHeavy(capabilitiesOf(clip) ?? { frameMode: clip.mode })) set.add(clip.id);
    }
  }
  return set;
}

/** card plan(`card-cache.mjs` 的 `plan()`)在手时的同一件事 —— 预渲染进程走这条。 */
export function prerenderSetOfPlan(plan) {
  const set = new Set();
  for (const control of plan ?? []) {
    if (!control?.clipId) continue;
    if (declaredHeavy(control.capabilities)) set.add(control.clipId);
  }
  return set;
}
