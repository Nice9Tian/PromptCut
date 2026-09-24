/**
 * 渲染节点侧的纯逻辑(分布式预渲染 M2,契约 `docs/plan/render-queue-contract.md` B 节)。
 *
 *   fingerprint.mjs  环境指纹与结果键
 *   filter.mjs       按能力过滤可认领的任务
 *   pick.mjs         候选排序与挑选
 *   split.mjs        `plan` 任务切分成细任务
 *   session.mjs      节点会话状态机(认领、续约、让路、放回)
 *
 * 只引 Node 内置模块、`../render-queue/index.mjs` 和 `../snapshot-store.mjs`;
 * 不读环境变量、不开计时器、不做 I/O。接本机预渲染进程是 M3 的事。
 */
export { normalizeOs, gpuClassOf, chromeMajorOf, envFingerprintOf, describeEnvironment, resultKeyOf } from './fingerprint.mjs';
export { DEFAULT_WEIGHT_POLICY, checkClaimable, filterClaimable } from './filter.mjs';
export { rankCandidates, pickCandidate } from './pick.mjs';
export { planTaskOf, splitPlan } from './split.mjs';
export { createNodeSession } from './session.mjs';
