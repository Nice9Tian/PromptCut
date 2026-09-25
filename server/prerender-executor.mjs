/**
 * 渲染任务队列的真实执行器(契约 `docs/plan/render-queue-contract.md` J.4,设计附件 `docs/plan/queue-executor-design.md`
 * 第 1～3 节)。实现 D.1 的 `executor` 接口,交给 `render-node/local-node.mjs` 的 `createLocalNode`。
 *
 * 这是一层很薄的适配:真正的活在 `FramePipeline` 的新方法里(`planForQueue`、`renderCardSnapshotRange`、
 * `renderSceneSnapshotRange`,都走 `'queue'` lane),没有调用它们时 preload 的路径不变。它不能放进
 * `server/render-node/`:那个目录受 D1 守门,只许 Node 内置模块,而这里要引管线。
 *
 *   plan(planTask)   按 `source.projectId@projectRev` 从文档服务取项目快照(`projects.get`,取不到抛
 *                    `no-snapshot`,可重试),`prepareProject` 之后交给 `pipeline.planForQueue`,回 PlanContext
 *                    (`streams`:本机能产轨道流时是这一版的全部流,否则为空 —— M6c X1)。结果按版本缓存
 *                    (LRU 约 4 条),`render` 复用。
 *   render(task)     快照任务:共享档 `renderCardSnapshotRange`,本地档 `renderSceneSnapshotRange`。
 *                    先把任务对回这一版的 control(附件第 3 节「把任务对回 control」),任何一项对不上抛
 *                    `plan-mismatch`(不可重试)。
 *                    流任务(M6c X1):对回这一版的流(内容键、结果键、分段范围),交给 `renderStreamRange` 按段产出;
 *                    对不上同样抛 `plan-mismatch`;本机不能产流(开关关着、没有编码器)抛 `no-streams`(不可重试)。
 *                    回 `null`:产物在帧库 / 流库里,sink 自己读(`collectSnapshotResult` / `collectStreamResult`)。
 *   isIdle()         流在忙、后台让路中(播放 / 拖动)、有活的 preload 代际没到 ready / error / cancelled,
 *                    任一成立就不闲(J.4)。
 */
import { resultKeyOf } from './render-node/fingerprint.mjs';
import { snapshotTier } from './snapshot-tier.mjs';

/** 按版本缓存的上下文条数(附件第 3 节:LRU 约 4 条) */
export const PLAN_CACHE_SIZE = 4;

const fail = (code, message, retryable) => Object.assign(new Error(message), { code, retryable });

/** preload 代际的这几种状态算「落定」,其余(queued / html / mov / video / partial)都算还在跑 */
const SETTLED = new Set(['ready', 'error', 'cancelled']);

/**
 * @param {object} options
 * @param {import('./frame-pipeline.mjs').FramePipeline} options.pipeline
 * @param {{ get(projectId: string, projectRev: number): Promise<object | null> }} options.projects  J.2 的项目客户端
 * @param {(project: any) => any} [options.prepareProject]  缺省原样;预渲染进程传 `renderProject`
 * @param {(event: string, fields?: object) => void} [options.log]
 */
export function createPrerenderExecutor({ pipeline, projects, prepareProject = project => project, log = () => {} }) {
  if (!pipeline) throw new Error('createPrerenderExecutor needs a pipeline');
  if (!projects || typeof projects.get !== 'function') throw new Error('createPrerenderExecutor needs a project client');
  /** `projectId@projectRev` → Promise<{ entry, context }>;Map 的插入顺序就是 LRU 顺序 */
  const cache = new Map();
  const say = (event, fields = {}) => { try { log(event, fields); } catch { /* 日志出错不影响执行 */ } };

  const versionOf = task => {
    const projectId = task?.source?.projectId;
    const projectRev = task?.source?.projectRev;
    if (typeof projectId !== 'string' || !projectId || !Number.isSafeInteger(projectRev)) {
      throw fail('bad-task', `任务的 source 不对:${JSON.stringify(task?.source ?? null)}`, false);
    }
    return { projectId, projectRev, id: `${projectId}@${projectRev}` };
  };

  /** 取(或算)这一版的上下文。失败的不留在缓存里,下次重算 */
  function contextFor(task, signal) {
    const { projectId, projectRev, id } = versionOf(task);
    const hit = cache.get(id);
    if (hit) {
      cache.delete(id);
      cache.set(id, hit);
      return hit;
    }
    const work = (async () => {
      let json;
      try { json = await projects.get(projectId, projectRev); }
      catch (error) { throw fail(error?.code === 'digest-mismatch' ? 'bad-snapshot' : 'no-snapshot', `取不到项目快照 ${id}:${error?.message || error}`, true); }
      if (!json) throw fail('no-snapshot', `文档服务上没有项目快照 ${id}`, true);
      const project = prepareProject(json);
      if (!Array.isArray(project?.tracks) || !Number.isFinite(project?.duration) || project.duration <= 0) {
        throw fail('bad-snapshot', `项目快照 ${id} 不是能渲的项目`, false);
      }
      return pipeline.planForQueue(project, { signal });
    })();
    cache.set(id, work);
    while (cache.size > PLAN_CACHE_SIZE) cache.delete(cache.keys().next().value);
    work.catch(() => { if (cache.get(id) === work) cache.delete(id); });
    return work;
  }

  async function plan(planTask, { signal } = {}) {
    const { id } = versionOf(planTask);
    const { entry, context } = await contextFor(planTask, signal);
    say('executor.plan', { version: id, entryKey: entry.key, controls: context.cardPlan.length, locks: context.cardLocks?.size ?? 0 });
    return context;
  }

  /** 附件第 3 节「把任务对回 control」:对不上的每一项都记进 `why`,有就抛 `plan-mismatch` */
  function matchControl(task, entry) {
    const input = task.input ?? {};
    const control = (entry.cardPlan ?? []).find(item => item?.clipId === input.clipId);
    const why = [];
    if (!control) why.push(`这一版没有片段 ${input.clipId}`);
    else {
      const tier = control.tier || snapshotTier(control.capabilities);
      const from = task.range?.from, to = task.range?.to;
      if (tier !== task.tier) why.push(`档位 ${task.tier} ≠ ${tier}`);
      if (!pipeline.queueHandles(control)) why.push('这张卡不由队列产');
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > control.count - 1) why.push(`帧范围 ${JSON.stringify(task.range)} 超出 0..${control.count - 1}`);
      const own = pipeline.envFingerprint;
      if (!own) why.push('本机还没有环境指纹');
      if (tier === 'shared') {
        if (input.contentKey !== control.contentKey) why.push('内容键不同');
        else if (own && task.resultKey !== resultKeyOf(control.contentKey, own)) why.push('结果键不是本机指纹的键');
      } else if (tier === 'local') {
        if (input.entryKey !== entry.key) why.push(`entry.key 不同(本机 ${entry.key})`);
        if (input.contentKey !== `${entry.key}/${control.contentKey}`) why.push('内容键不同');
        else if (own && task.resultKey !== resultKeyOf(input.contentKey, own)) why.push('结果键不是本机指纹的键');
      }
    }
    if (why.length) throw fail('plan-mismatch', `任务 ${task.id} 对不上这一版的计划:${why.join(';')}`, false);
    return control;
  }

  /**
   * M6c X1:把流任务对回这一版的流。流按内容键认(`input.contentKey`,即 `planStreams` 的 `contentKey`);
   * 结果键必须是本机指纹乘出来的(节点侧过滤已经按指纹挡过,这里再核一次);分段范围在这条流之内。
   */
  function matchStream(task, specs) {
    const input = task.input ?? {};
    const spec = (specs ?? []).find(item => item?.contentKey === input.contentKey) ?? null;
    const why = [];
    if (!spec) why.push(`这一版没有内容键为 ${String(input.contentKey).slice(0, 16)}… 的流`);
    else {
      const own = pipeline.envFingerprint;
      const from = task.range?.from, to = task.range?.to;
      if (!own) why.push('本机还没有环境指纹');
      else if (task.resultKey !== resultKeyOf(spec.contentKey, own)) why.push('结果键不是本机指纹的键');
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < spec.firstSegment || to < from || to > spec.lastSegment) {
        why.push(`分段范围 ${JSON.stringify(task.range)} 超出 ${spec.firstSegment}..${spec.lastSegment}`);
      }
    }
    if (why.length) throw fail('plan-mismatch', `任务 ${task.id} 对不上这一版的流:${why.join(';')}`, false);
    return spec;
  }

  async function renderStream(task, { signal, progress }) {
    if (typeof pipeline.streamCapable === 'function' && !(await pipeline.streamCapable())) {
      throw fail('no-streams', '本机不能产轨道流(PROMPTCUT_STREAMS=0 或没有能用的 H.264 编码器)', false);
    }
    const { entry, streamSpecs } = await contextFor(task, signal);
    const spec = matchStream(task, streamSpecs);
    const range = { from: task.range.from, to: task.range.to };
    const started = Date.now();
    await pipeline.renderStreamRange(entry, spec, range, { signal, progress });
    say('executor.render', { id: task.id, kind: 'stream', streamKey: spec.streamKey.slice(0, 12), ms: Date.now() - started });
    return null;
  }

  async function render(task, { signal, progress } = {}) {
    if (task?.kind === 'stream') return renderStream(task, { signal, progress });
    if (task?.kind !== 'snapshot') throw fail('bad-task', `不认识的任务 kind:${task?.kind}`, false);
    const { entry } = await contextFor(task, signal);
    const control = matchControl(task, entry);
    const range = { from: task.range.from, to: task.range.to };
    const started = Date.now();
    if (task.tier === 'shared') await pipeline.renderCardSnapshotRange(entry, control, range, { signal, progress });
    else await pipeline.renderSceneSnapshotRange(entry, control, range, { signal, progress });
    say('executor.render', { id: task.id, tier: task.tier, clipId: control.clipId, ms: Date.now() - started });
    return null;
  }

  function isIdle(now = Date.now()) {
    if (pipeline.closed) return false;
    const streams = pipeline._streams;
    if (streams && ((streams.workers?.size ?? 0) > 0 || (streams.encoding?.size ?? 0) > 0)) return false;
    // 让路:后台让路租约在期 / 正在让路 / 在播,以及页面报的播放头在播或刚拖过(`streamBusy`,轨道流用的同一个判据)
    if (pipeline.backgroundYielding || pipeline.backgroundLeaseUntil > now || pipeline.playback?.playing) return false;
    if (typeof pipeline.streamBusy === 'function' && pipeline.streamBusy(now)) return false;
    for (const generation of pipeline.generations?.values?.() ?? []) {
      if (generation?.controller?.signal?.aborted) continue;
      const status = pipeline.entries.get(generation.key)?.status;
      if (!SETTLED.has(status)) return false;
    }
    return true;
  }

  return { plan, render, isIdle, forget: () => cache.clear() };
}
