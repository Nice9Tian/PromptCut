/**
 * K2 分派算法：「活渲的卡尽可能多」的优化问题。**纯函数，浏览器和 Node 同一份代码。**
 *
 * 两端不交换分派表，只同步 `costs`（和 `tuning`）：页面按它决定每拍怎么渲，预渲染进程按它
 * 决定预渲染哪些卡。所以同一份输入必须在两端算出**逐字段相同**的表 ——
 * 这里不读文件、不看环境变量、不用 `Date` / `Math.random`、不依赖任何 `Map` / `Set` 的
 * 插入顺序（凡是要遍历的容器都先按 clipId 排好序再建）。
 *
 * # 两件事，别混（任务书「组件与术语」）
 *
 * - **实时判定**是轻 / 重，只对「（位置, 卡）」说、逐位置动态算：`segments[i].heavy` / `.light`，
 *   查询用 `pipelineAt`。热舞台按它决定活渲还是贴死素材。
 * - **预渲染集合** `prerenderSet` 是「哪些卡要进预渲染管线」的静态集合 = 任一位置判重的卡的并集。
 *   集合里的卡**整段**预渲染，不按位置裁。一张卡可以在集合里、同时在某些位置判轻活渲。
 *
 * # 分段
 *
 * 边界 = 所有卡片段入点和出点的并集（pinned 渲染 8），去重升序；相邻两个边界之间是一个位置。
 * 素材段（只有 `mediaId`、没有 `cardId` / `nodeId`）不是卡，不参与分段、也不参与分派。
 *
 * # 每个位置怎么算
 *
 * 预算 `B = 1000 / fps × 0.7`（pinned 渲染 3：留 30% 给素材层、平面换帧和 React 本身）。
 * 先给每张活跃卡定一个每拍权重 `w`（见 `clipWeight`），再按 `w` **升序贪心**逐个加入轻管线，
 * 停止条件 `Σ w + 重卡数 × DEAD_MS > B`。升序贪心对「数量最多」是最优解，所以小卡、中卡
 * 先进、重卡被挤出去；全是重卡时轻管线可能一张都没有。
 *
 * Σ 里装的是 `w` 不是裸的 `stepMs` —— 否则几张 (b) 档卡会同时判轻，这一拍的真实成本是预算的
 * 几倍、必掉帧，两端也算不出同一张表。
 */
import { cardCostKey } from './cardCostKey.mjs';
import { resolveTuning } from './pipelineTuning.mjs';

/**
 * 一个重卡每拍贴一帧死素材的固定成本（ms）。`unknown` 卡按 `belowDependent` 处理、
 * 判重时贴本地档快照，同样计这一份。只有 L4（在线浏览器模式，没有预渲染进程、不存在两端对表）
 * 用 `opts.deadMs` 换成实测换帧成本。
 */
export const DEAD_MS = 0.3;

/** 追帧上界（K2）：每拍除本拍那一帧外最多再多推 4 步本地时间，最多追 `2 × fps` 拍。 */
export const CATCHUP_STEPS_PER_BEAT = 4;
export const maxCatchUpBeats = (fps) => 2 * fps;

/** pinned 渲染 3 的预算公式。`COST_SCALE` 不动它（K2「可调系数」）。 */
export const budgetOf = (fps) => (1000 / fps) * 0.7;

/** 这一段是不是卡片段（素材段没有卡，不参与分派） */
const isCardClip = (clip) => !!clip && typeof clip.id === 'string' && (typeof clip.cardId === 'string' || typeof clip.nodeId === 'string');

const byId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** 项目里全部卡片段，按 clipId 排好序（遍历顺序两端必须一致） */
function cardClipsOf(project) {
  const clips = [];
  for (const track of project?.tracks ?? []) {
    for (const clip of track?.clips ?? []) {
      if (!isCardClip(clip)) continue;
      const start = Number(clip.start), end = Number(clip.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
      clips.push({ id: clip.id, start, end });
    }
  }
  return clips.sort((a, b) => byId(a.id, b.id));
}

/** `identityKeys` / `frameModes` 既收 Map 也收普通对象 */
const lookup = (table, key) => {
  if (!table) return undefined;
  if (typeof table.get === 'function') return table.get(key);
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
};

/**
 * 一张卡在任一位置的每拍权重，以及「是不是每个位置都判重」。
 *
 * 权重在各位置**相同**（推帧卡按整段最差代价判，pinned 渲染 3 末句），只有贪心的同伴
 * （该位置的其它活跃卡）不同，所以同一张卡仍可能在拥挤的位置被挤出轻管线
 * （pinned 渲染 8 的按位置动态算就是这一层）。
 *
 * `COST_SCALE` 乘在每一项**实测**成本上（`stepMs` / `catchUpMs` / `seekMs`）：判重比较式
 * 和权重都乘。追帧上界那一步是 `catchUpMs / (4 × stepMs)` 的比值，分子分母同乘、天然不受影响。
 *
 * 导出出来只为诊断和单测（「这张卡走的是哪一档、权重多少」），`planPipelines` 自己用同一份。
 */
export function clipWeight(record, frameMode, fps, tuningOrOverrides) {
  const B = budgetOf(fps);
  const tuning = resolveTuning(tuningOrOverrides);
  const scale = tuning.COST_SCALE;

  /*
   * 没有成本记录的卡按声明兜底（K1 末段）：`direct` 视为轻，其余视为重，探针结果到了再改。
   * `direct` 的权重记 0 —— 还不知道它多贵，但按声明它是随机访问的便宜卡，让它排在贪心最前面、
   * 不占预算；这只是「新卡还没测完」那几秒的兜底，探针一回来就换成真实 `stepMs`。
   */
  if (!record) {
    return frameMode === 'direct'
      ? { pinned: false, w: 0, tier: 'declared-light' }
      : { pinned: true, w: Infinity, tier: 'declared-heavy' };
  }

  const stepMs = (Number(record.stepMs) || 0) * scale;
  /*
   * `capped`（含 `demoted` / `pinnedHeavy`）每个位置都判重（判定仍逐位置做，结果恒为重）。
   * 既认记录里探针写的那一位，也当场按现在的 fps 和 `COST_SCALE` 重算一遍 ——
   * 「改了 `COST_SCALE`、不重启不改代码，下次打开项目就改判」靠的就是重算这一条。
   */
  if (record.capped === true || record.demoted === true || record.pinnedHeavy === true) return { pinned: true, w: Infinity, tier: 'capped' };
  if (stepMs > B) return { pinned: true, w: Infinity, tier: 'capped' };

  // 随机访问卡：权重恒为 stepMs
  if (record.kind === 'random') return { pinned: false, w: stepMs, tier: 'direct' };

  /*
   * (a′) 可以直接定位、而且最差那一次定位（从第 0 帧直接钉到最后一帧）在一拍预算内：
   * 权重 `stepMs`，整段再长也不用追帧、也不需要死素材。
   * `seekMs: null` = 量那一趟超了 200 ms 上限、代价未知：不按线性估（那会得到一个乐观的下界），
   * 一律按推帧卡规则走，和 `catchUpMs` 截断时外推的口径一样是保守的。
   * 没有 `seekOk` 记录的按 `false`。
   */
  const rawSeek = record.seekMs;
  const seekMs = rawSeek === null || rawSeek === undefined ? null : Number(rawSeek) * scale;
  if (record.seekOk === true && seekMs !== null && Number.isFinite(seekMs) && seekMs <= B) return { pinned: false, w: stepMs, tier: 'seek' };

  // 推帧卡：按整段最差代价判，各位置统一
  const catchUpMs = (Number(record.catchUpMs) || 0) * scale;
  if (catchUpMs <= B) return { pinned: false, w: stepMs, tier: 'catchup-a' };          // (a) 进入片段时一拍内补齐
  const beats = stepMs > 0 ? catchUpMs / (CATCHUP_STEPS_PER_BEAT * stepMs) : Infinity;
  if (beats <= maxCatchUpBeats(fps)) return { pinned: false, w: (1 + CATCHUP_STEPS_PER_BEAT) * stepMs, tier: 'catchup-b' };
  // 超出追帧上界：不参加贪心、每个位置都判重、整段进预渲染集合
  return { pinned: true, w: Infinity, tier: 'over-catchup' };
}

/**
 * K2 的分派表。
 *
 * @param {any} project 项目（只读 `tracks[].clips[]` 的 `id` / `cardId` / `nodeId` / `start` / `end`）
 * @param {any[]} costs K1 的成本记录（`GET /api/data/costs` 回的那一份，已按当前 device / mode 过滤）
 * @param {number} fps 项目帧率
 * @param {object} [opts] `deadMs`（只有 L4 换成实测换帧成本）、`tuning`（覆盖值或已解析的一份）、
 *   `identityKeys` / `frameModes`（片段 → 成本记录的索引，见 `clipCostIndex`）
 */
export function planPipelines(project, costs, fps, opts = {}) {
  const rate = Math.max(1, Number(fps) || 30);
  // resolveTuning 是幂等的（范围内的值原样留着），所以已经解析过的一份再进来一次也不变
  const tuning = resolveTuning(opts.tuning);
  const deadMs = Number.isFinite(Number(opts.deadMs)) ? Number(opts.deadMs) : DEAD_MS;
  const B = budgetOf(rate);

  const clips = cardClipsOf(project);

  // 成本记录按 identityKey 索引。同键多条（不该发生，PUT 按 (identityKey, device) 去重）取最后一条，
  // 和 upsert 的语义一致。
  const byKey = new Map();
  for (const record of costs ?? []) {
    if (record && typeof record.identityKey === 'string') byKey.set(record.identityKey, record);
  }

  // 每张卡的权重算一次（各位置相同）
  const weights = new Map();
  for (const clip of clips) {
    const key = lookup(opts.identityKeys, clip.id);
    const record = typeof key === 'string' ? byKey.get(key) : undefined;
    weights.set(clip.id, clipWeight(record, lookup(opts.frameModes, clip.id), rate, tuning));
  }

  // 分段边界 = 所有卡片入点出点的并集，去重升序
  const bounds = [...new Set(clips.flatMap((clip) => [clip.start, clip.end]))].sort((a, b) => a - b);

  const segments = [];
  const prerender = new Set();
  for (let i = 0; i + 1 < bounds.length; i++) {
    const fromSec = bounds[i], toSec = bounds[i + 1];
    // 边界就是入点出点的并集，所以每张卡要么整段盖住这个位置、要么和它不相交，中点判一次就够
    const mid = (fromSec + toSec) / 2;
    const active = clips.filter((clip) => clip.start <= mid && mid < clip.end);

    const pinnedCount = active.filter((clip) => weights.get(clip.id).pinned).length;
    const candidates = active.filter((clip) => !weights.get(clip.id).pinned)
      // 升序贪心；同权重按 clipId 定序，两端才逐字段相同
      .sort((a, b) => weights.get(a.id).w - weights.get(b.id).w || byId(a.id, b.id));

    const light = new Set();
    let sum = 0;
    for (const clip of candidates) {
      const next = sum + weights.get(clip.id).w;
      // 装进去之后还剩几张重卡：钉死的那些 + 还没装进轻管线的候选
      const heavyCount = pinnedCount + (candidates.length - light.size - 1);
      if (next + heavyCount * deadMs > B) break;   // 装不下就停：后面的只会更贵
      sum = next;
      light.add(clip.id);
    }

    const heavy = active.map((clip) => clip.id).filter((id) => !light.has(id));
    for (const id of heavy) prerender.add(id);
    // 集合按 clipId 排好序再建，序列化出来两端逐字节相同
    segments.push({ fromSec, toSec, heavy: new Set(heavy.sort(byId)), light: new Set([...light].sort(byId)) });
  }

  return { segments, prerenderSet: new Set([...prerender].sort(byId)) };
}

/**
 * 热舞台在某一刻对某张卡用哪条管线。位置外（这一刻这张卡不活跃）回 `'light'` ——
 * 不活跃的卡两条管线都不占，调用方本来就不会渲它。
 */
export function pipelineAt(plan, clipId, tSec) {
  const t = Number(tSec);
  for (const segment of plan?.segments ?? []) {
    if (!(t >= segment.fromSec) || !(t < segment.toSec)) continue;
    return segment.heavy.has(clipId) ? 'heavy' : 'light';
  }
  return 'light';
}

/**
 * 片段 → 成本记录的索引（片段 → 节点 → `cardCostKey`，口径同 `scripts/probe-card-costs.mjs`）。
 *
 * `planPipelines` 本身是纯函数、够不到卡片注册表，所以「这一段是哪张卡、它的源码版本是多少」
 * 由调用方先算一次、把结果喂进 `opts.identityKeys` / `opts.frameModes`。页面侧在 `ProbeGate`
 * 里本来就要算同一份（探针的「已测过就跳过」用它），预渲染进程侧在 4 帧批边界算一次。
 *
 * @param {any} project 项目（要 `fps` 和每段的入出点算 `durationFrames`）
 * @param {any} graph `projectCardGraph(project, getCard)` 的结果
 * @param {(node: any) => string | null} [sourceVersionOf] 那张卡的源码版本（照 `ExportView.tsx` 的算法）
 */
export function clipCostIndex(project, graph, sourceVersionOf = () => null) {
  const fps = Math.max(1, Number(project?.fps) || 30);
  const nodeByClip = new Map();
  for (const node of graph?.nodes ?? []) {
    if (typeof node?.clipId === 'string' && !nodeByClip.has(node.clipId)) nodeByClip.set(node.clipId, node);
  }
  const identityKeys = {}, frameModes = {};
  for (const track of project?.tracks ?? []) {
    for (const clip of track?.clips ?? []) {
      if (!isCardClip(clip)) continue;
      const node = nodeByClip.get(clip.id);
      if (!node) continue;
      const mode = node.capabilities?.frameMode;
      if (typeof mode === 'string') frameModes[clip.id] = mode;
      const durationFrames = Math.max(1, Math.round((Number(clip.end) - Number(clip.start)) * fps));
      identityKeys[clip.id] = cardCostKey(node, sourceVersionOf(node), fps, durationFrames);
    }
  }
  return { identityKeys, frameModes };
}
