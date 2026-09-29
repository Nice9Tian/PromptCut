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
 *                    共享档卡在本机快照库里记过超限帧(`index.json` 的 `oversize`,R6-14)的,交给切分的 control 标
 *                    `snapshotOversize: true`(见 `markSnapshotOversize`),切分据此不给纯浏览器另出一份(M7 契约第 13 节
 *                    「探针之后的更正」第 6 条;`claude/queue-maint` 任务 E)。
 *   afterSplit(planTask, { tasks })  (M7 契约 D12)local-node 切分完成、发布回包都回来之后调:按最终发布成功的细任务
 *                    记下每张卡实际出键的指纹(`pipeline.recordSplitCandidates`),带片段清单的 plan 再写一次这一版的层表 v 3
 *                    (候选按实际出键;独立渲染主机用 `publishLayerMap` 选项写,PC 用管线自己的推送队列写)。层表只在切分完成后写,
 *                    不再在切分之前按本机视图写(D12 的时机)。
 *
 * 诊断(`docs/archive/agent-reports/AGENT-stall-phases.md`):`render` 经 runner 给的 `phase(name, fields)` 报它此刻在哪一步 ——
 * `project`(取项目快照、算这一版的计划)、`lane`(交给管线了、这一段的第一批还没交;`ahead` 是当时这条管线上
 * 已经在跑的 `'queue'` lane 工作数,大于 0 就是在排队)、`frames`(在出批)、`finish`(帧都交了,在收尾:补小尺寸、换页)。
 *
 * M6c 起执行器不再有 `isIdle()`(J.4 原有):PC 节点的闲时门槛改为 `queue-idle.mjs`(X5),独立渲染主机本来就
 * 只看全局并发闸,这个判据已经没人用(集成裁定,`docs/plan/m6c-contract.md`「集成时的裁定」)。
 */
import { resultKeyOf } from './render-node/fingerprint.mjs';
import { snapshotTier } from './snapshot-tier.mjs';
import { isListPlan } from './render-queue/index.mjs';
import { splitCandidatesOf } from './artifact-transfer.mjs';

/** `cardLocks`(Map、普通对象或缺省)→ `(lockKey) => 锁指纹 | null`(同 `split.mjs` 的读法) */
function lockReader(cardLocks) {
  const fp = value => (typeof value === 'string' && value !== '' ? value : null);
  if (cardLocks == null) return () => null;
  if (typeof cardLocks.get === 'function') return key => fp(cardLocks.get(key));
  if (typeof cardLocks === 'object') return key => (Object.prototype.hasOwnProperty.call(cardLocks, key) ? fp(cardLocks[key]) : null);
  return () => null;
}

/**
 * 按本机快照库给共享档卡标 `snapshotOversize`(`claude/queue-maint` 任务 E):这张卡在本机快照库里有超限帧的记录
 * (`index.json` 的 `oversize` 非空;本机渲过它时 A3c 判超限记下的,或从素材服务拉回它的清单时同样判出来的)就标。
 * 看两个键:本机指纹的键(`control.snapshotKey`),以及这张卡锁在别的环境上时锁定方指纹的键(`cardLocks`)。
 * 标在整张卡上,不按段:一张卡的快照只出自一种环境(卡片级指纹锁),浏览器认领其中一段就锁住整张卡,
 * 超限的那几段它做了也是白做、别的环境又被锁挡住 —— 所以有一帧超限,整张卡都不给浏览器。
 * 本地档不看(纯浏览器只做共享档);画布卡不看(切分本来就不给浏览器)。回新的 cardPlan 数组(标了的 control 是新对象,
 * 缓存里的上下文不动),没有要标的回原数组。读不到快照库(测试替身、库坏了)一律当没有记录。
 */
export async function markSnapshotOversize(pipeline, context) {
  const cardPlan = Array.isArray(context?.cardPlan) ? context.cardPlan : [];
  let store = null;
  try { store = typeof pipeline?.snapshots === 'function' ? pipeline.snapshots() : null; } catch { store = null; }
  if (!store || typeof store.snapshotIndex !== 'function') return { cardPlan, marked: [] };
  const lockOf = lockReader(context?.cardLocks);
  const marked = [];
  const out = [];
  for (const control of cardPlan) {
    const tier = control?.tier || snapshotTier(control?.capabilities);
    if (!control || control.snapshotOversize === true || tier !== 'shared' || !control.contentKey || control.capabilities?.canvasHeavy === true) {
      out.push(control);
      continue;
    }
    const keys = new Set([control.snapshotKey]);
    const locked = lockOf(`snapshot:${control.contentKey}`);
    if (locked) keys.add(resultKeyOf(control.contentKey, locked));
    let over = false;
    for (const key of keys) {
      if (typeof key !== 'string' || !key) continue;
      try {
        const index = await store.snapshotIndex({ tier: 'shared', key });
        if (Array.isArray(index?.oversize) && index.oversize.length > 0) { over = true; break; }
      } catch { /* 读不到当没有记录 */ }
    }
    if (over) { marked.push(control.clipId); out.push({ ...control, snapshotOversize: true }); } else out.push(control);
  }
  return { cardPlan: marked.length ? out : cardPlan, marked };
}

/** 按版本缓存的上下文条数(附件第 3 节:LRU 约 4 条) */
export const PLAN_CACHE_SIZE = 4;

const fail = (code, message, retryable) => Object.assign(new Error(message), { code, retryable });

/**
 * 每条管线上经执行器交给 `'queue'` lane 的工作(快照的一段、plan 的取计划):管线 → 在跑的个数。
 * lane 是串行的(`FramePipeline.runQueueTask`),同一条管线由主机的几个项目节点的执行器共用,所以记在模块里、按管线分。
 * 只计数,不排队、不改管线的行为。
 */
const laneWork = new WeakMap();
async function onLane(pipeline, work) {
  laneWork.set(pipeline, (laneWork.get(pipeline) ?? 0) + 1);
  try { return await work(); }
  finally { laneWork.set(pipeline, Math.max(0, (laneWork.get(pipeline) ?? 1) - 1)); }
}
/** 这条管线上此刻经执行器交给 `'queue'` lane、还没落定的工作数 */
export function laneBusy(pipeline) {
  return laneWork.get(pipeline) ?? 0;
}

/**
 * @param {object} options
 * @param {import('./frame-pipeline.mjs').FramePipeline} options.pipeline
 * @param {{ get(projectId: string, projectRev: number): Promise<object | null> }} options.projects  J.2 的项目客户端
 * @param {(project: any) => any} [options.prepareProject]  缺省原样;预渲染进程传 `renderProject`
 * @param {(event: string, fields?: object) => void} [options.log]
 * @param {(entry: object) => void} [options.publishLayerMap]  认下带片段清单的 plan 之后写层表(C10 契约第 18 节第 9 条):
 *   独立渲染主机没有推送队列,管线自己的 `publishLayerMap` 写不出去,由主机按这条连接的内容库写;PC 节点不给(照旧由推送队列写)
 * @param {() => unknown} [options.codeStamp]  卡片代码的版次(c66-host-cards:`card-code.mjs` 的 `epoch`)。缓存按
 *   「项目版本 + 版次」存:卡片代码变了(同步装上了新卡),同一版项目的上下文要按新代码重算,不然任务对回的还是旧的 control
 */
export function createPrerenderExecutor({ pipeline, projects, prepareProject = project => project, log = () => {}, codeStamp = () => '', publishLayerMap = null }) {
  if (!pipeline) throw new Error('createPrerenderExecutor needs a pipeline');
  if (!projects || typeof projects.get !== 'function') throw new Error('createPrerenderExecutor needs a project client');
  /** `projectId@projectRev` → Promise<{ entry, context }>;Map 的插入顺序就是 LRU 顺序 */
  const cache = new Map();
  const say = (event, fields = {}) => { try { log(event, fields); } catch { /* 日志出错不影响执行 */ } };
  /** 同 `say`;`render` 里的 `say` 被阶段回调遮住了,那里用这个名字记日志 */
  const note = say;

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
    const { projectId, projectRev, id: version } = versionOf(task);
    let stamp = '';
    try { stamp = String(codeStamp() ?? ''); } catch { stamp = ''; }
    const id = stamp ? `${version}#${stamp}` : version;
    const hit = cache.get(id);
    if (hit) {
      cache.delete(id);
      cache.set(id, hit);
      return hit;
    }
    const work = (async () => {
      let json;
      try { json = await projects.get(projectId, projectRev); }
      catch (error) { throw fail(error?.code === 'digest-mismatch' ? 'bad-snapshot' : 'no-snapshot', `取不到项目快照 ${version}:${error?.message || error}`, true); }
      if (!json) throw fail('no-snapshot', `文档服务上没有项目快照 ${version}`, true);
      const project = prepareProject(json);
      if (!Array.isArray(project?.tracks) || !Number.isFinite(project?.duration) || project.duration <= 0) {
        throw fail('bad-snapshot', `项目快照 ${version} 不是能渲的项目`, false);
      }
      return onLane(pipeline, () => pipeline.planForQueue(project, { signal }));
    })();
    cache.set(id, work);
    while (cache.size > PLAN_CACHE_SIZE) cache.delete(cache.keys().next().value);
    work.catch(() => { if (cache.get(id) === work) cache.delete(id); });
    return work;
  }

  async function plan(planTask, { signal } = {}) {
    const { id } = versionOf(planTask);
    const { entry, context } = await contextFor(planTask, signal);
    // c10a 契约第 17 节:补渲计划任务的片段清单记进管线(进预渲染集合、写进层表);切分由 local-node 按清单做。
    // C10 契约第 18 节第 9 条:在线页面的清单计划同一条路(清单是页面自己判重的片段)
    if (isListPlan(planTask) && typeof pipeline.addBackfill === 'function') {
      const added = pipeline.addBackfill(entry, planTask.input?.clips ?? []);
      say('executor.backfill', { version: id, clips: planTask.input?.clips?.length ?? 0, added });
    }
    // 层表不在这里写:切分完成后按实际出键写(afterSplit,M7 D12)
    say('executor.plan', { version: id, entryKey: entry.key, controls: context.cardPlan.length, locks: context.cardLocks?.size ?? 0 });
    // 任务 E:本机快照库记过超限帧的卡标 snapshotOversize(每次切分现读:超限记录会随本机渲染、拉取变多,不进按版本的缓存)
    const { cardPlan, marked } = await markSnapshotOversize(pipeline, context);
    if (!marked.length) return context;
    say('executor.oversize', { version: id, clips: marked.length });
    return { ...context, cardPlan };
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

  async function render(task, { signal, progress, phase } = {}) {
    const say = (name, fields) => { try { phase?.(name, fields); } catch { /* 诊断回调出错不影响执行 */ } };
    if (task?.kind === 'stream') return renderStream(task, { signal, progress });
    if (task?.kind !== 'snapshot') throw fail('bad-task', `不认识的任务 kind:${task?.kind}`, false);
    say('project');
    const { entry } = await contextFor(task, signal);
    const control = matchControl(task, entry);
    // c10a 契约第 17 节:补渲细任务的片段在本机可能判轻(不在预渲染集合里,管线会跳过它);按任务把它记成补渲再渲。
    // 切分它的 plan 可能是别的进程、或本进程重启之前认领的,这里不能指望 plan() 已经记过
    if (task.priority === 'backfill' && typeof pipeline.addBackfill === 'function' && !pipeline.prerenderPicked(entry, control.clipId)) {
      pipeline.addBackfill(entry, [control.clipId]);
    }
    const range = { from: task.range.from, to: task.range.to };
    const started = Date.now();
    const total = range.to - range.from + 1;
    say('lane', { ahead: laneBusy(pipeline) });
    const tracked = done => {
      say(done >= total ? 'finish' : 'frames', { done, total });
      progress?.(done);
    };
    // 诊断(不改行为):共享档这一段各步的用时(排队、借预渲染间、换页、推帧、入库、画小尺寸),记进 executor.render
    const timing = {};
    await onLane(pipeline, () => (task.tier === 'shared'
      ? pipeline.renderCardSnapshotRange(entry, control, range, { signal, progress: tracked, timing })
      : pipeline.renderSceneSnapshotRange(entry, control, range, { signal, progress: tracked })));
    say('executor.render', { id: task.id, tier: task.tier, clipId: control.clipId, ms: Date.now() - started });
    // 上面那个 `say` 是阶段回调(这一行照旧);分段耗时另记一行日志(`log`),编辑器进程的转发器放行它
    note('executor.render-timing', { id: task.id, tier: task.tier, clipId: control.clipId, ms: Date.now() - started, ...timing });
    return null;
  }

  /**
   * M7 D12:切分完成后按实际出键写层表。`tasks` 是最终发布成功的细任务;记候选对所有 plan 都做(之后本机写的层表也按它列),
   * 写层表只对带片段清单的 plan(在线页面按层表找清单)。失败只记日志。
   */
  async function afterSplit(planTask, { tasks = [] } = {}) {
    const { id } = versionOf(planTask);
    const candidates = splitCandidatesOf(tasks);
    if (typeof pipeline.recordSplitCandidates === 'function') pipeline.recordSplitCandidates(candidates);
    if (!isListPlan(planTask)) return;
    try {
      const { entry } = await contextFor(planTask);
      if (typeof publishLayerMap === 'function') publishLayerMap(entry);
      else if (typeof pipeline.publishLayerMap === 'function') pipeline.publishLayerMap(entry);
      say('executor.layer-map', { version: id, cards: candidates.size, dual: [...candidates.values()].filter(fps => fps.length > 1).length });
    } catch (error) {
      say('executor.layer-map-failed', { version: id, message: String(error?.message ?? error) });
    }
  }

  /**
   * 独立渲染主机的闲时认领(契约 A.12〔裁〕,`render-node/host.mjs`):任务要用哪条串行 lane —— 快照与 plan 用 `'queue'`
   * (`runQueueTask`,一次只做一件),流用流预渲染间池,不算(回 null)。`laneBusy()` 是这条管线上此刻经执行器交给
   * `'queue'` lane、还没落定的工作数(包括已经被中止、管线还没收手的那一件)。
   */
  const laneOf = task => (task?.kind === 'snapshot' || task?.kind === 'plan' ? 'queue' : null);
  return { plan, render, afterSplit, forget: () => cache.clear(), laneOf, laneBusy: () => laneBusy(pipeline) };
}
