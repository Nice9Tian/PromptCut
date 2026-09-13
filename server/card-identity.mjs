import { digest } from './frame-identity.mjs';
import { CARD_RUNTIME_ABI, selectedCardStyle, validateCardGraph } from '../src/kernel/cardGraph.mjs';

/** Per-node content identity intentionally excludes timeline placement and IDs.
 * All upstream versions and input time transforms are included transitively.
 */
export function cardNodeIdentities(graph, { style = {}, environment = {}, sourceVersions = {} } = {}) {
  const { nodes, levels } = validateCardGraph(graph);
  const byId = new Map(nodes.map(node => [node.id, node]));
  const definitions = new Map((graph.definitions ?? []).map(def => [def.id, def]));
  const keys = new Map();
  for (const level of levels) for (const id of level) {
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
