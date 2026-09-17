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
 * parts、主题 id、`fontFingerprint`、`freezeCode`、`capabilities`(审阅表内容,
 * 已经在节点里)。
 */
export function cardSnapshotIdentity(node, {
  definition, style = {}, environment = {}, sourceVersions = {}, sourceVersion,
  inputKeys = {}, fps, sampling, phase = sampling?.phase, duration,
  stage = {}, frame, frameWidth, frameHeight,
  themeId, fontFingerprint = '', freezeCode = '',
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
      themeId, fontFingerprint, freezeCode,
    },
  });
}
