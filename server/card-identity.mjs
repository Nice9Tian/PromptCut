import { digest } from './frame-identity.mjs';
import { CARD_RUNTIME_ABI, selectedCardStyle, validateCardGraph } from '../src/kernel/cardGraph.mjs';
import { resolveFrameSize } from '../src/kernel/frameSize.mjs';

/** Per-node content identity intentionally excludes timeline placement and IDs.
 * All upstream versions and input time transforms are included transitively.
 */
export function cardNodeIdentities(graph, { style = {}, environment = {}, sourceVersions = {} } = {}) {
  const { nodes, levels } = validateCardGraph(graph);
  const byId = new Map(nodes.map(node => [node.id, node]));
  const definitions = new Map((graph.definitions ?? []).map(def => [def.id, def]));
  const keys = new Map();
  for (const level of levels) for (const id of level) {
    // `inputs` 是 validateCardGraph 丢边之后剩下的那些;丢掉的名字留在 node.missingInputs 里
    // 一并进 digest —— 输入片段删没删是不同的画面。
    const { id: _id, inputs, definitionId, ...node } = byId.get(id);
    const definition = definitions.get(definitionId);
    if (definitionId && !definition) throw new Error(`Missing card definition ${definitionId}`);
    const inputKeys = Object.fromEntries(Object.entries(inputs).map(([name, input]) => [name,
      { key: keys.get(input.nodeId), offset: input.offset, rate: input.rate }]));
    const usedStyle = definition ? selectedCardStyle(definition, style) : node.adapter === 'chrome' ? style : {};
    keys.set(id, digest({ abi: CARD_RUNTIME_ABI, environment, node, definition, style: usedStyle,
      sourceVersion: node.cardId ? sourceVersions[node.cardId] : undefined, inputs: inputKeys }));
  }
  return keys;
}

const gcd = (a, b) => { a = a < 0n ? -a : a; while (b) { const next = a % b; a = b; b = next; } return a || 1n; };
const reduce = (n, d) => { if (d < 0n) { n = -n; d = -d; } const g = gcd(n, d); return { n: n / g, d: d / g }; };
function decimal(value) {
  if (!Number.isFinite(value)) throw new Error('Non-finite card clock');
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(String(value));
  const power = Number(match[4] ?? 0) - (match[3]?.length ?? 0);
  let n = BigInt(match[2] + (match[3] ?? '')) * (match[1] ? -1n : 1n), d = 1n;
  if (power >= 0) n *= 10n ** BigInt(power); else d = 10n ** BigInt(-power);
  return reduce(n, d);
}
const ceil = (n, d) => n >= 0n ? (n + d - 1n) / d : n / d;
const pair = value => ({ numerator: String(value.n), denominator: String(value.d) });

/** Retain sub-frame placement exactly as decimal/rational input rather than
 * rounding clip.start to a frame. MOV frame 0 is the first timeline sample
 * inside the clip; phase identifies which local instant that sample represents.
 */
export function cardSampling(start, fps) {
  if (!(fps > 0)) throw new Error('Invalid card frame rate');
  const s = decimal(start), rate = decimal(fps);
  const first = ceil(s.n * rate.n, s.d * rate.d);
  if (first > BigInt(Number.MAX_SAFE_INTEGER) || first < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error('Card frame out of range');
  const phase = reduce(first * rate.d * s.d - s.n * rate.n, rate.n * s.d);
  return { firstFrame: Number(first), fps: pair(rate), phase: pair(phase) };
}

export function cardLocalTime(sampling, localFrame) {
  if (!Number.isSafeInteger(localFrame)) throw new Error('Invalid local frame');
  const phase = sampling.phase, fps = sampling.fps;
  const n = BigInt(localFrame) * BigInt(fps.denominator) * BigInt(phase.denominator) + BigInt(phase.numerator) * BigInt(fps.numerator);
  const d = BigInt(fps.numerator) * BigInt(phase.denominator);
  const result = reduce(n, d);
  return { ...pair(result), seconds: Number(result.n) / Number(result.d) };
}

export function cardCacheIdentity(nodeKey, sampling, duration, output = 'visual') {
  // Invalidate raster samples captured with disposable WebGL buffers, which
  // could have stored a transparent canvas as a successfully rendered card.
  return digest({ rasterVersion: 2, nodeKey, fps: sampling.fps, phase: sampling.phase, duration, output });
}

const ratio = value => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'object') return pair(reduce(BigInt(value.numerator), BigInt(value.denominator)));
  return pair(decimal(Number(value)));
};

/**
 * 共享快照键(A3a)。和 `cardNodeIdentities` 用同一个 `digest`、同一份输入结构,
 * 但输入节点先剥掉片段身份:在 `:13` 已剥的 `id` / `inputs` / `definitionId`
 * 之外**再剥 `clipId`**(`cardGraph.mjs:121-127` 合成 `@clip/<id>/source` 节点时
 * 写进去的)。同一张卡放在两个片段里、同参数同框宽高,内容完全一样,快照应当共享。
 * `cardNodeIdentities` 本身不改 —— 它的 `clipId` 是刻意的,给 `CardFrameCache`
 * 的缓存校验用。
 *
 * `inputs`:**不能**拿 `cardNodeIdentities` 现成的上游键,那些键里带上游片段的
 * clipId,同一条转场换个片段就不共享了。普通卡没有上游,传 `{}` 即可;
 * `sourceDependent` 链路上每个控件各自递归用本函数算、各自剥掉 clipId,按链路
 * 顺序拼 —— 那部分在第 4 步接上,所以这里把 `inputKeys` 做成显式参数。
 *
 * 片段框宽高:用 `src/kernel/frameSize.mjs` 的 `resolveFrameSize` 解析,和舞台
 * `layout.ts` 的 `resolveFrame` 同一份实现(选它而不是在浏览器侧算好传进来:
 * Node 端也要能独立复算键,`__pcCardPlan` 只负责给 `environment`)。调用方若已
 * 经算好,也可以直接传 `frameWidth` / `frameHeight` 覆盖。
 *
 * 不进键:x / y / anchor / scale / rotate、不透明度、淡入淡出、motion、强调 ——
 * A2(5) 之后这些不在快照里,同一份共享快照挂到两个位置,各自画在自己的框里。
 * 进键:参数、源码版本、片段时长、采样相位、fps、框宽高、画幅、`camera3dFov`、
 * parts、主题 id、`fontFingerprint`、`snapshotCode`、`capabilities`(审阅表内容,
 * 已经在节点里)。
 */
export function cardSnapshotIdentity(node, {
  definition, style = {}, environment = {}, sourceVersions = {}, sourceVersion,
  inputKeys = {}, fps, sampling, phase = sampling?.phase, duration,
  stage = {}, frame, frameWidth, frameHeight,
  themeId, fontFingerprint = '', snapshotCode = '',
} = {}) {
  const { id: _id, inputs: _inputs, definitionId: _definitionId, clipId: _clipId, ...stripped } = node ?? {};
  const usedStyle = definition ? selectedCardStyle(definition, style) : stripped.adapter === 'chrome' ? style : {};
  const parent = { width: stage.width, height: stage.height };
  const size = resolveFrameSize(frame, parent);
  return digest({
    abi: CARD_RUNTIME_ABI, environment, node: stripped, definition, style: usedStyle,
    sourceVersion: sourceVersion ?? (stripped.cardId ? sourceVersions[stripped.cardId] : undefined),
    inputs: inputKeys,
    // 快照特有的一段单独放,免得和节点自身的字段重名;`cardNodeIdentities` 的
    // 输入结构原样保留在上面,两个函数的键永远不会相等(这一段一定在)。
    snapshot: {
      fps: ratio(fps), phase: ratio(phase), duration,
      stage: { width: parent.width, height: parent.height, camera3dFov: stage.camera3dFov },
      frame: { width: frameWidth ?? size.w, height: frameHeight ?? size.h },
      themeId, fontFingerprint, snapshotCode,
    },
  });
}

/**
 * 轨道流的流键(R8;任务书说 `streamKey` 的命名在本任务定、A3b 回头对齐 —— 这里先用 `streamKey`)。
 *
 * 两种流,键的口径不同:
 *
 *   - **单卡流**(`kind: 'card'`):画面在**包裹层自己的坐标系**里(和快照一样,A2(5) 之后
 *     x / y / 缩放 / 旋转 / 不透明度 / 淡入淡出 / motion / 强调都不在里面,由包裹层照常加上),
 *     所以内容身份用共享快照键 `snapshotKey`(同参数同框宽高就共享);再加上**时间上的摆放**
 *     (`sampling`:第一帧、相位、fps)—— 流按**全局帧号**分段(G4:时间不平移),入点挪了一帧
 *     分段里的内容就整体错一帧,不能复用;
 *   - **组流**(`kind: 'group'`):画面在舞台坐标里,包裹层的 `frameCss` / `opacity` / `filter` /
 *     `motion` 全部已经画进流里(G1),所以每张卡用带外观的缓存键 `control.key`,按画家顺序排。
 *
 * 两种都带上画幅、fps 和 `codeVersion`(生产这条流的代码指纹:截图 / 编码那几份文件一改,
 * 旧流全部作废)。**矩形和编码器不进流键**:它们只决定分段的「变体」(`init` 不同),
 * 页面按分段各自找自己的 `init`,见 `server/frame-stream.mjs`。
 *
 * 第三种,**依赖下层的流**(`kind: 'below'`,`docs/plan/prerender-products-contract.md` 第 5.2 节):目标卡连同它下面的层一起渲,
 * 按舞台坐标产。成员只有目标卡一张,键见 `belowStreamIdentity`;上面两种的摘要一个字不变。
 */
export function cardStreamIdentity({ kind = 'card', members = [], fps, stage = {}, codeVersion = '', below = null } = {}) {
  if (kind === 'below') return belowStreamIdentity({ members, fps, stage, codeVersion, below });
  if (kind !== 'card' && kind !== 'group') throw new Error(`未知的流种类 ${kind}`);
  if (!members.length) throw new Error('流里至少要有一张卡');
  return digest({
    stream: 1, kind, fps: ratio(fps), codeVersion,
    stage: { width: stage.width, height: stage.height, camera3dFov: stage.camera3dFov },
    members: members.map(m => ({
      key: m.key,
      firstFrame: m.sampling?.firstFrame,
      phase: m.sampling?.phase ? ratio(m.sampling.phase) : undefined,
      count: m.count,
      frame: m.frame,
    })),
  });
}

/**
 * 依赖下层的流里**放的是什么**的版本。现在是 0:这种流的身份(本文件)和计划(`frame-stream.mjs` 的 `planStreams`)定了,
 * 流里的像素怎么取(差分取层还是原样盖,契约第 5.3 节)还没做。定下来的那一次把它加到 1,之后每改一次流里放的东西再加一 ——
 * 开关打开时(`belowStreamsEnabled`)用旧办法产出来的分段就不会被新的读法拿去贴。不动 `STREAM_CODE_VERSION`:那一个管所有的流。
 */
export const BELOW_STREAM_VERSION = 0;

/**
 * 依赖下层的流(`kind: 'below'`)的内容键。摘要里是(契约第 5.2 节):
 *
 *   - **目标卡**(`members` 恰好一项):带外观的缓存内容键(`control.cacheContentKey`:位置、缩放、旋转、不透明度、淡入淡出、
 *     轨迹都在里面 —— 这种流按舞台坐标产,外观画进流里),加采样的第一帧、相位、帧数;
 *   - **下层**(`below.layers`):画家顺序排在目标卡下面、活跃时间和它有重叠的每一个画面层,各自的缓存内容键、第一帧、相位、帧数,
 *     **按画家顺序排成一列**(下面的在前)。每项可另带 `extra`:缓存内容键没管到、又会改这一层画面的项目数据
 *     (现在是素材段的像素映射,见 `frame-stream.mjs` 的 `belowLayerExtra`);
 *   - 画幅、帧率、`codeVersion`,同别的流;再加 `BELOW_STREAM_VERSION`。
 *
 * 所以下层任一层的参数、位置、时间、上下顺序变了,或者下层多了少了一层,键就变;排在上面的层怎么改都不变
 * (`mechanism/cards.md`「轴三」:下层依赖卡的预渲染结果,同一时刻下层任一控件的参数变了就失效)。
 *
 * 算不出某个下层的键时不许拿残缺的一列出键:调用方改传 `below.scene`(整个项目的键 `entry.key`),摘要里就只有目标卡加这一个键 ——
 * 更粗(项目里任何改动都作废),但不会错。`layers` 与 `scene` 都没有、或哪一项缺键就抛。
 */
function belowStreamIdentity({ members = [], fps, stage = {}, codeVersion = '', below = null } = {}) {
  if (members.length !== 1) throw new Error('依赖下层的流只有目标卡一个成员');
  const scene = below?.scene;
  const layers = below?.layers;
  if (scene !== undefined && scene !== null && (typeof scene !== 'string' || !scene)) throw new Error('依赖下层的流:整个项目的键不对');
  if (!scene && !Array.isArray(layers)) throw new Error('依赖下层的流:要给下层的键,或者整个项目的键');
  const item = m => {
    if (typeof m?.key !== 'string' || !m.key) throw new Error('依赖下层的流:有一层没有键');
    return {
      key: m.key,
      firstFrame: m.sampling?.firstFrame,
      phase: m.sampling?.phase ? ratio(m.sampling.phase) : undefined,
      count: m.count,
      extra: m.extra,
    };
  };
  return digest({
    stream: 1, kind: 'below', below: BELOW_STREAM_VERSION, fps: ratio(fps), codeVersion,
    stage: { width: stage.width, height: stage.height, camera3dFov: stage.camera3dFov },
    members: members.map(item),
    ...(scene ? { scene } : { layers: layers.map(item) }),
  });
}
