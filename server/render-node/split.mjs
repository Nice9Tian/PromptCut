import { QUEUE_DEFAULTS, taskIdOf, lockKeyOf, backfillPlanTaskOf, isBackfillPlan, clipsPlanTaskOf, isClipsPlan, isListPlan } from '../render-queue/index.mjs';
import { snapshotTier } from '../snapshot-tier.mjs';
import { resultKeyOf } from './fingerprint.mjs';

/**
 * `plan` 任务 → 细任务(设计第 2 节、Q1,契约 B.4)。
 *
 * 页面只发粗任务「给这一版项目做计划」;第一个认领它的节点在 Chrome 里算出 card plan、
 * 用 `card-cache.mjs` 算出结果键和预渲染集合,再用这里的 `splitPlan` 切成细任务发布回队列
 * (`source.derivedFrom` 指向那个 `plan` 任务)。
 *
 *   快照:每个 control 的本地帧 0 .. count-1 按 SNAPSHOT_SPAN 切段(缺省 60 帧);本地档缺 entryKey 的跳过
 *   轨道流:firstSegment .. lastSegment 按 STREAM_SEGMENTS 切(缺省 8 段,每段 15 帧);没有 streamKey 的跳过。
 *          流任务的 `requires.capabilities = { streams: true }`(M6c X1):只给报了能产流的节点
 *
 * 结果键 = 内容键 × 切分节点**自己的**环境指纹(设计 2.1;卡被别的环境锁定时见下文「卡片级指纹锁」):认领 `plan` 的节点定下这一版
 * 项目的指纹,写进每个细任务的 `requires.envFingerprint`,只有同指纹的节点能认领。
 * 含锚帧的快照段优先级 50,其余 10。快照任务的 `input.canvasHeavy` 取 `control.capabilities?.canvasHeavy === true`
 * (契约 J.3)。
 *
 * 内容键(契约 E.5):M4 起 card plan 的 `snapshotKey` 和流的 `streamKey` 本身已经乘过指纹,
 * 所以这里取它们带的**内容键**(`control.contentKey` / `stream.contentKey`)再乘一次指纹 ——
 * 指纹与 plan 相同时,共享档任务的 `resultKey` 正好等于 `control.snapshotKey`,流任务的正好等于
 * `spec.streamKey`,细任务的产物和本机预渲染进程写的是同一个目录。没有内容键字段的输入
 * (M2 夹具的旧形状)照旧把 `snapshotKey` / `streamKey` 当内容键。
 *
 * # 卡片级指纹锁(契约 F.2,设计 2.1「谁定指纹」)
 *
 * 锁的单位是「一张卡的一种结果」,锁键 `<kind>:<contentKey>`,`contentKey` 就是细任务的
 * `input.contentKey`(本地档带 `<entryKey>/` 前缀)。调用方可以传 `cardLocks`(锁键 → 锁指纹)
 * 和 `takeover`(要接手哪些锁),每张卡、每条流按下面三种之一出键:
 *
 *   没锁,或锁在本节点的指纹上   按本节点指纹出键,不加 takeover 字段(即上面的规则)
 *   锁在别的指纹 X 上,且接手     按本节点指纹出键,每个任务加 `takeover: true`,
 *                                 发布时锁转给本节点,X 的未完成任务作废(superseded)
 *   锁在别的指纹 X 上,不接手     `resultKey` 与 `requires.envFingerprint` 都用 X:
 *                                 剩余帧只给与锁定方同指纹的节点,这一层不混环境
 *
 * # 本地档能力闸(M6c X2,`docs/plan/m6c-contract.md`)
 *
 * 没有内容哈希的素材只在发布方本机(别的机器拿不到它的字节,素材回退只认哈希)。调用方给 `localMedia`
 * (发布方的 nodeId)和 `usesLocalMedia(control)`,判真的每个任务在 `requires` 里写 `localMedia`,
 * 只有那个节点能认领(节点侧过滤规则 1 与队列的前置过滤、认领检查一起守)。不给 `localMedia` 时任务形状不变。
 *
 * # 纯浏览器可做的卡出两份(M7 契约 D1,第 3.3 节)
 *
 * 调用方给 `browserFingerprints`(文档服务上本项目在线、与 plan 同一用户的纯浏览器节点的指纹,由队列在 plan 的
 * `task.claimed` 里给出,见 `render-queue/queue.mjs` 的 `browserFingerprintsFor`)时,**没被锁**的、纯浏览器做得了的卡
 * (共享档、独立卡、内置卡片、`cardSources` 为空、重度 light / medium、不用只在发布方本机的素材)
 * 除了照旧按自己的指纹出一份,再按每个浏览器指纹各出一份:
 *
 *   结果键 = 内容键 × 浏览器指纹,`requires.envFingerprint` = 浏览器指纹,其余 requires 相同;
 *   两份都带 `input.dual: true`,都不带 `takeover`;浏览器那份另带 `input.compositing` 与 `input.bake`
 *   (隔离单卡工程要的 `start`、`end`、`count`、`sampling`,页面不算 cardSampling)。
 *
 * 谁先认领这张卡的任一段谁得锁,队列在建锁时把另一份(`dual`、还 open 的异指纹任务)作废。
 * 已锁的卡照旧按锁出一份(锁在浏览器指纹上时那一份同样带 bake / compositing);浏览器指纹与自己相同、
 * 或没给浏览器指纹时,切分与原来完全相同。
 *
 * 纯函数:不读环境变量、不做 I/O。
 */

/** 轨道流每段的帧数(G2 的分段规则,和 `frame-stream.mjs` 的 SEGMENT_FRAMES 同值)。 */
const SEGMENT_FRAMES = 15;
const ANCHOR_PRIORITY = 50;
const NORMAL_PRIORITY = 10;

/**
 * 这一版项目的粗任务(发布方发布的那一个)。
 * `codeVersion` / `envFingerprint` 给了就写进 `requires`(契约 J.3),只有代码版本、指纹对得上的
 * 节点能认领这个 plan;没给的项不写,`requires` 与 B.4 相同。id 与 resultKey 不随它们变。
 */
export function planTaskOf({ projectId, projectRev, priority = 0, codeVersion, envFingerprint, preferNode }) {
  const resultKey = `${projectId}@${projectRev}`;
  const requires = {};
  if (codeVersion !== undefined) requires.codeVersion = codeVersion;
  if (envFingerprint !== undefined) requires.envFingerprint = envFingerprint;
  // M6c X4:发布方自己的节点优先认领(独占窗口 PLAN_PREFER_MS),窗口过后给任何指纹符合的 pc
  if (preferNode !== undefined) requires.preferNode = preferNode;
  return {
    id: taskIdOf({ kind: 'plan', resultKey, range: null }), kind: 'plan', resultKey, range: null,
    source: { projectId, projectRev }, input: {}, weight: { class: 'medium', estMs: null, frames: null },
    requires, priority,
  };
}

/**
 * 补渲计划任务(c10a 契约第 17 节,语义 `mechanism/rendering.md`「低内存档」):低内存档发现判重的层在素材服务里
 * 没有产物时发布,带片段清单(`input.clips`),标 `priority: 'backfill'`。认领它的节点把清单里的片段当重卡算键、
 * 切出细任务,细任务同样标 `backfill`(`splitPlan` 的 `lane`)。形状与校验在队列那边(`messages.mjs`)。
 */
export { backfillPlanTaskOf, isBackfillPlan, clipsPlanTaskOf, isClipsPlan, isListPlan };

/** `[from, to]` 闭区间序列:first .. last 每 span 一段,最后一段到 last。 */
function spans(first, last, span) {
  const out = [];
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) return out;
  for (let from = first; from <= last; from += span) out.push([from, Math.min(last, from + span - 1)]);
  return out;
}

const stepOf = value => Math.max(1, Math.floor(Number(value) || 0));

/** 任务的锁键(契约 F.1):只有一份实现,在队列那边;这里转出,节点侧照旧从切分模块取 */
export { lockKeyOf };

/** 锁指纹只认非空字符串;别的值(`null`、空串、非字符串)一律当没锁。 */
const fingerprintOr = value => (typeof value === 'string' && value !== '' ? value : null);

/** `cardLocks`(Map 或普通对象)→ `(lockKey) => 锁指纹 | null`。普通对象只看自有属性。 */
function lockLookup(cardLocks) {
  if (cardLocks == null) return () => null;
  if (typeof cardLocks.get === 'function') return key => fingerprintOr(cardLocks.get(key));
  if (typeof cardLocks === 'object') {
    return key => (Object.prototype.hasOwnProperty.call(cardLocks, key) ? fingerprintOr(cardLocks[key]) : null);
  }
  return () => null;
}

/** `takeover`(布尔 / Set / 函数)→ `(lockKey) => boolean`。其余值当不接手。 */
function takeoverTest(takeover) {
  if (takeover === true) return () => true;
  if (typeof takeover === 'function') return key => takeover(key) === true;
  if (takeover != null && typeof takeover.has === 'function') return key => takeover.has(key) === true;
  return () => false;
}

/** 纯浏览器能认领的重度(filter.mjs 的 `DEFAULT_WEIGHT_POLICY.browser`) */
const BROWSER_WEIGHTS = new Set(['light', 'medium']);

/**
 * 这张卡纯浏览器做不做得了(M7 契约 D1、D4):共享档、独立卡、不是用户卡图卡、没改过源码(`cardSources` 为空)、
 * light / medium、不用只在发布方本机的素材。`requires` 是这张卡自己那一份的 requires(已含 localMedia)。
 */
function browserEligible({ tier, compositing, requires, weight }) {
  return tier === 'shared' && compositing === 'independent'
    && requires.userCards === false && requires.graphCards === false
    && Object.keys(requires.cardSources ?? {}).length === 0
    && !('localMedia' in requires)
    && BROWSER_WEIGHTS.has(weight?.class);
}

/** 浏览器那一份要的隔离单卡工程参数(M7 契约第 4.3 节):页面照桌面 `isolatedCardProject` 的变换载入,不算 cardSampling */
function bakeInputOf(control) {
  const out = { start: control.start, end: control.end, count: control.count };
  if (control.sampling != null) out.sampling = structuredClone(control.sampling);
  return out;
}

/** → TaskInput[]:先快照(按 cardPlan 顺序、段升序),后轨道流(按 streams 顺序、段升序);同一 id 只留第一个。 */
export function splitPlan({
  planTask,
  entryKey,
  cardPlan,
  prerenderSet,
  streams = [],
  envFingerprint,
  codeVersion,
  cardSourceVersions = {},
  anchorFrames = [],
  weightOf = () => ({ class: 'heavy', estMs: null }),
  isUserCard = () => false,
  isGraphCard = () => false,
  constants = {},
  cardLocks = {},           // Map | Record<lockKey, envFingerprint>(契约 F.2)
  takeover = false,         // boolean | Set<lockKey> | (lockKey) => boolean
  localMedia = null,        // 发布方的 nodeId(M6c X2):给了,且 usesLocalMedia 判真的任务写进 requires.localMedia
  usesLocalMedia = () => true,   // (control) => boolean;流任务传 { clipId: topClipId, kind: 'stream' }
  lane = 'normal',          // 'backfill':补渲计划任务切出的细任务,priority 一律标 'backfill'(c10a 契约第 17 节)
  browserFingerprints = [], // 本项目在线、同一用户的纯浏览器节点的指纹(M7 契约 D1):浏览器可做、没锁的卡另出这些指纹的一份
}) {
  /** 细任务的 priority:补渲档一律 'backfill';normal 档照旧按锚帧给整数名次 */
  const priorityOf = anchored => (lane === 'backfill' ? 'backfill' : anchored ? ANCHOR_PRIORITY : NORMAL_PRIORITY);
  const snapshotSpan = stepOf(constants.SNAPSHOT_SPAN ?? QUEUE_DEFAULTS.SNAPSHOT_SPAN);
  const streamSegments = stepOf(constants.STREAM_SEGMENTS ?? QUEUE_DEFAULTS.STREAM_SEGMENTS);
  const { projectId, projectRev } = planTask?.source ?? {};
  const derivedFrom = planTask?.id ?? null;
  const anchors = [...(anchorFrames ?? [])];
  const lockOf = lockLookup(cardLocks);
  const takesOver = takeoverTest(takeover);
  /** 浏览器指纹:非空字符串、去重、不等于自己的指纹(相同就不必另出一份) */
  const browserFps = [...new Set((Array.isArray(browserFingerprints) ? browserFingerprints : [])
    .filter(fp => typeof fp === 'string' && fp !== '' && fp !== envFingerprint))];
  const browserSet = new Set(browserFps);
  const mediaOwner = typeof localMedia === 'string' && localMedia !== '' ? localMedia : null;
  /** 本地档能力闸(M6c X2):这一项的输入用到只在发布方本机的素材时,requires 加 `localMedia` */
  const gateLocalMedia = (requires, control) => {
    if (mediaOwner !== null && usesLocalMedia(control) === true) requires.localMedia = mediaOwner;
    return requires;
  };
  /**
   * 这一层按哪个指纹出键:`{ fingerprint, takeover }`。`takeover` 只在真的接手别的指纹时为真;
   * 没锁或同指纹时任务不加这个字段(契约 F.2)。
   */
  const keyingOf = lockKey => {
    const locked = lockOf(lockKey);
    if (locked == null || locked === envFingerprint) return { fingerprint: envFingerprint, takeover: false };
    if (takesOver(lockKey)) return { fingerprint: envFingerprint, takeover: true };
    return { fingerprint: locked, takeover: false };
  };
  /**
   * 卡片代码要求(c66-host-cards,契约 B.4〔c66-host-cards 改〕):`cardSourceVersions` 是这一版用到的定制卡
   * (用户卡、改动层里改过的卡)的代码身份。共享档只画这一张卡,只要它自己的;本地档与流画的是整个场景
   * (本地档的内容键里有 entry.key,整场景键带着全部定制卡的身份),要全部。
   */
  const allCardSources = () => {
    const out = {};
    for (const [cardId, version] of Object.entries(cardSourceVersions ?? {})) if (typeof version === 'string' && version) out[cardId] = version;
    return out;
  };
  const out = [];
  const seen = new Set();
  const emit = task => {
    if (seen.has(task.id)) return;
    seen.add(task.id);
    out.push(task);
  };

  for (const control of cardPlan ?? []) {
    const { snapshotKey, clipId } = control ?? {};
    if (!snapshotKey || !clipId) continue;
    if (prerenderSet && !prerenderSet.has(clipId)) continue;
    const tier = control.tier ?? snapshotTier(control.capabilities);
    if (tier !== 'shared' && tier !== 'local') continue;
    // 本地档的内容键要 entry.key;没给就跳过,不生成 `undefined/<共享键>` 这种键(契约 A.10a)
    if (tier === 'local' && (entryKey == null || entryKey === '')) continue;
    const baseKey = control.contentKey ?? snapshotKey;
    const contentKey = tier === 'shared' ? baseKey : `${entryKey}/${baseKey}`;
    const lockKey = `snapshot:${contentKey}`;
    const keying = keyingOf(lockKey);
    const cardId = control.cardId ?? null;
    // 决定清单的体积上限,推送与拉取两边要一致(C6.2 第 11 节第 2 条,J.3)
    const canvasHeavy = control.capabilities?.canvasHeavy === true;
    const cardVersion = control.cardId ? cardSourceVersions?.[control.cardId] : undefined;
    const compositing = control.compositing ?? control.capabilities?.compositing;
    // 锚帧是全局帧号,换成这张卡的本地帧再比;没有 firstFrame 就判不了,一律按普通段
    const firstFrame = Number(control.sampling?.firstFrame);
    const requires = {
      envFingerprint: keying.fingerprint, codeVersion,
      cardSources: tier === 'local' ? allCardSources() : cardVersion ? { [control.cardId]: cardVersion } : {},
      transcode: false,
      userCards: !!isUserCard(control),
      graphCards: !!isGraphCard(control),
      belowDependent: compositing === 'belowDependent',
    };
    gateLocalMedia(requires, control);
    const weight = weightOf(control);
    // M7 D1:这张卡出哪几份。没锁(或锁在自己的指纹上)、浏览器做得了时另出浏览器指纹的;锁在别处的照锁只出一份
    const eligible = browserSet.size > 0 && browserEligible({ tier, compositing, requires, weight });
    const fingerprints = eligible && lockOf(lockKey) == null ? [keying.fingerprint, ...browserFps] : [keying.fingerprint];
    const dual = fingerprints.length > 1;
    for (const fingerprint of fingerprints) {
      const resultKey = resultKeyOf(contentKey, fingerprint);
      // 浏览器那一份(或锁在浏览器指纹上、照锁出的那一份)带页面生成快照要的两项
      const forBrowser = eligible && browserSet.has(fingerprint);
      const inputOf = () => {
        const input = { clipId, cardId, entryKey: tier === 'local' ? entryKey : null, contentKey, canvasHeavy };
        if (dual) input.dual = true;
        if (forBrowser) Object.assign(input, { compositing, bake: bakeInputOf(control) });
        return input;
      };
      for (const [from, to] of spans(0, Number(control.count) - 1, snapshotSpan)) {
        const range = { unit: 'localFrame', from, to };
        const anchored = anchors.some(a => from <= a - firstFrame && a - firstFrame <= to);
        const task = {
          id: taskIdOf({ kind: 'snapshot', resultKey, range }), kind: 'snapshot', tier, resultKey, range,
          source: { projectId, projectRev, derivedFrom },
          input: inputOf(),
          weight: { ...weight, frames: to - from + 1 },
          requires: { ...requires, envFingerprint: fingerprint, cardSources: { ...requires.cardSources } },
          priority: priorityOf(anchored),
        };
        if (keying.takeover) task.takeover = true;
        emit(task);
      }
    }
  }

  for (const stream of streams ?? []) {
    const { streamKey, topClipId, firstSegment, lastSegment } = stream ?? {};
    if (!streamKey) continue;
    const contentKey = stream.contentKey ?? streamKey;
    const keying = keyingOf(`stream:${contentKey}`);
    const resultKey = resultKeyOf(contentKey, keying.fingerprint);
    const weight = weightOf({ clipId: topClipId });
    for (const [from, to] of spans(firstSegment, lastSegment, streamSegments)) {
      const range = { unit: 'segment', from, to };
      const task = {
        id: taskIdOf({ kind: 'stream', resultKey, range }), kind: 'stream', resultKey, range,
        source: { projectId, projectRev, derivedFrom },
        input: { clipId: topClipId, cardId: null, entryKey: null, contentKey },
        weight: { ...weight, frames: (to - from + 1) * SEGMENT_FRAMES },
        requires: gateLocalMedia({
          envFingerprint: keying.fingerprint, codeVersion, cardSources: allCardSources(),
          transcode: true, userCards: false, graphCards: false, belowDependent: false,
          // M6c X1:只有报了 `capabilities.streams: true`(探到编码器)的节点能认领(filter.mjs 规则 2)
          capabilities: { streams: true },
        }, { clipId: topClipId, kind: 'stream' }),
        priority: priorityOf(false),
      };
      if (keying.takeover) task.takeover = true;
      emit(task);
    }
  }
  return out;
}
