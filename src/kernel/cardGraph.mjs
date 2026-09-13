import { cardCapabilities } from '../render/frameMode.mjs';

export const CARD_RUNTIME_ABI = 1;
export const CARD_KINDS = ['animation', 'filter', 'transition', 'emphasis', 'audio'];
export const CARD_ADAPTERS = ['python', 'chrome', 'media', 'filter', 'audio', 'emphasis', 'transition'];
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const fail = message => { throw new Error(`Card graph: ${message}`); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const identifier = (id, label) => {
  if (typeof id !== 'string' || !id || id.length > 256 || /[\x00-\x1f]/.test(id)) fail(`invalid ${label}`);
  return id;
};

/** Canonical JSON is shared by the browser planner and server cache identity. */
export function cardJson(value) {
  if (Array.isArray(value)) return '[' + value.map(cardJson).join(',') + ']';
  if (object(value)) return '{' + Object.keys(value).sort().filter(k => value[k] !== undefined)
    .map(k => JSON.stringify(k) + ':' + cardJson(value[k])).join(',') + '}';
  if (typeof value === 'number' && !Number.isFinite(value)) fail('non-finite number');
  const text = JSON.stringify(value);
  if (text === undefined) fail('values must be JSON serializable');
  return text;
}

export function normalizeCardDefinition(raw) {
  if (!object(raw)) fail('definition must be an object');
  const id = identifier(raw.id, 'definition id');
  if (!['python', 'tsx', 'builtin'].includes(raw.language)) fail(`${id}: invalid language`);
  if (!CARD_KINDS.includes(raw.kind)) fail(`${id}: invalid kind`);
  if (raw.language === 'python') {
    if (typeof raw.source !== 'string' || !raw.source.trim() || raw.source.length > 512 * 1024) fail(`${id}: invalid Python source`);
    if (typeof raw.entry !== 'string' || !/^[A-Za-z_]\w*$/.test(raw.entry)) fail(`${id}: invalid class name`);
  }
  if (raw.need_prerendering !== undefined && typeof raw.need_prerendering !== 'boolean') fail(`${id}: need_prerendering must be boolean`);
  if (raw.compositing !== undefined && !['independent', 'context', 'unknown'].includes(raw.compositing)) fail(`${id}: invalid compositing`);
  const styleKeys = raw.styleKeys ?? null;
  if (styleKeys !== null && (!Array.isArray(styleKeys) || styleKeys.some(k => typeof k !== 'string' || !k))) fail(`${id}: invalid styleKeys`);
  const definition = { ...raw, id, defaults: raw.defaults ?? {}, styleKeys,
    need_prerendering: raw.need_prerendering ?? true, compositing: raw.compositing ?? 'unknown' };
  cardJson(definition);
  return structuredClone(definition);
}

export function selectedCardStyle(definition, style = {}) {
  const keys = definition?.styleKeys;
  return keys == null ? structuredClone(style) : Object.fromEntries(keys.filter(k => own(style, k)).map(k => [k, structuredClone(style[k])]));
}

/** An edge is a query transform, never a mutation of a decoder/playback cursor. */
export function normalizeCardInput(input) {
  if (typeof input === 'string') input = { nodeId: input };
  if (!object(input)) fail('input must reference a node');
  const nodeId = identifier(input.nodeId, 'input node id');
  const offset = input.offset ?? 0, rate = input.rate ?? 1;
  if (!Number.isFinite(offset) || !Number.isFinite(rate)) fail('invalid input time mapping');
  return { nodeId, offset, rate };
}

/** Returns topological batches; nodes within a batch have no mutual dependencies. */
export function validateCardGraph(raw) {
  if (!object(raw) || !Array.isArray(raw.nodes) || !Array.isArray(raw.outputs)) fail('nodes and outputs are required');
  if (raw.nodes.length > 10000) fail('too many nodes');
  const nodes = new Map();
  for (const value of raw.nodes) {
    const id = identifier(value?.id, 'node id');
    if (nodes.has(id)) fail(`duplicate node ${id}`);
    if (!CARD_ADAPTERS.includes(value.adapter)) fail(`${id}: invalid adapter`);
    const inputs = Object.fromEntries(Object.entries(value.inputs ?? {}).map(([name, ref]) => [name, normalizeCardInput(ref)]));
    nodes.set(id, { ...structuredClone(value), inputs });
  }
  const dependants = new Map(), remaining = new Map();
  for (const [id, node] of nodes) {
    const dependencies = new Set(Object.values(node.inputs).map(ref => ref.nodeId));
    remaining.set(id, dependencies.size);
    for (const dependency of dependencies) {
      if (!nodes.has(dependency)) fail(`${id}: missing input ${dependency}`);
      if (!dependants.has(dependency)) dependants.set(dependency, []);
      dependants.get(dependency).push(id);
    }
  }
  const outputs = raw.outputs.map(out => {
    const nodeId = typeof out === 'string' ? out : out?.nodeId;
    if (!nodes.has(nodeId)) fail(`missing output ${nodeId}`);
    return typeof out === 'string' ? { nodeId } : structuredClone(out);
  });
  const levels = [];
  let level = [...nodes.keys()].filter(id => remaining.get(id) === 0), visited = 0;
  while (level.length) {
    levels.push(level); visited += level.length;
    const next = [];
    for (const id of level) for (const dependent of dependants.get(id) ?? []) {
      remaining.set(dependent, remaining.get(dependent) - 1);
      if (!remaining.get(dependent)) next.push(dependent);
    }
    level = next;
  }
  if (visited !== nodes.size) fail('dependency cycle');
  return { nodes: [...nodes.values()], outputs, levels };
}

/** Adapt the existing project into the same graph used by Python cards.
 * Existing fields stay readable; native effects are adapter nodes, not a
 * separate public effect-definition or scheduling API.
 */
export function projectCardGraph(project, getLegacyCard = () => undefined) {
  const definitions = (project.cardDefinitions ?? []).map(normalizeCardDefinition);
  const byDefinition = new Map(definitions.map(def => [def.id, def]));
  if (byDefinition.size !== definitions.length) fail('duplicate definition');
  const nodes = structuredClone(project.cardNodes ?? []), outputs = [];
  const nodeIds = new Set(nodes.map(node => node.id));
  const media = new Map((project.media ?? []).map(value => [value.id, value]));
  const add = node => {
    if (nodeIds.has(node.id)) fail(`reserved node collision ${node.id}`);
    nodeIds.add(node.id); nodes.push(node); return node.id;
  };
  for (const track of [...(project.tracks ?? [])].reverse()) {
    for (const clip of track.clips ?? []) {
      let baseId;
      if (clip.mediaId) {
        const source = media.get(clip.mediaId);
        baseId = add({ id: `@clip/${clip.id}/source`, adapter: 'media', media: source, clipId: clip.id,
          offset: clip.mediaOffset ?? 0, inputs: {}, capabilities: { need_prerendering: false, compositing: 'independent' } });
      } else if (clip.cardId) {
        const def = getLegacyCard(clip.cardId);
        baseId = add({ id: `@clip/${clip.id}/source`, adapter: 'chrome', cardId: clip.cardId, clipId: clip.id,
          params: { ...def?.defaults, ...clip.params }, parts: clip.parts, inputs: {}, capabilities: cardCapabilities(def, { ...def?.defaults, ...clip.params }) });
      }
      let nodeId = clip.nodeId || baseId;
      if (!nodeId) continue;
      for (const [field, library, adapter] of [['filter', 'filters', 'filter'], ['audioFx', 'audioFx', 'audio']]) {
        if (!clip[field]) continue;
        const def = project[library]?.find(value => value.id === clip[field].id);
        if (!def) continue; // Existing projects already treat a deleted preset as bypass.
        nodeId = add({ id: `@clip/${clip.id}/${field}`, adapter, definition: def, params: clip[field].params ?? {},
          inputs: { source: { nodeId } } });
      }
      if (clip.emphasis) nodeId = add({ id: `@clip/${clip.id}/emphasis`, adapter: 'emphasis', params: clip.emphasis, inputs: { source: { nodeId } } });
      if (!track.hidden) outputs.push({ nodeId, clipId: clip.id, trackId: track.id, start: clip.start, end: clip.end,
        frame: clip.frame, opacity: clip.opacity, fadeIn: clip.fadeIn, fadeOut: clip.fadeOut, motion: clip.motion });
    }
  }
  for (const node of nodes) if (node.adapter === 'python' && !byDefinition.has(node.definitionId)) fail(`${node.id}: missing definition ${node.definitionId}`);
  const graph = validateCardGraph({ nodes, outputs });
  const normalized = new Map(graph.nodes.map(node => [node.id, node]));
  for (const level of graph.levels) for (const id of level) {
    const node = normalized.get(id);
    if (node.adapter === 'python') {
      const definition = byDefinition.get(node.definitionId);
      node.capabilities = { need_prerendering: definition.need_prerendering, compositing: definition.compositing };
    } else if (!node.capabilities) {
      const upstream = Object.values(node.inputs).map(input => normalized.get(input.nodeId).capabilities);
      node.capabilities = { need_prerendering: upstream.some(c => c?.need_prerendering),
        compositing: upstream.length && upstream.every(c => c?.compositing === 'independent') ? 'independent' : 'unknown' };
    }
  }
  for (const output of graph.outputs) output.capabilities = normalized.get(output.nodeId).capabilities;
  return { abi: CARD_RUNTIME_ABI, definitions, ...graph };
}
