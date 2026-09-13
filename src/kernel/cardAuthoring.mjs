import { normalizeCardDefinition, normalizeCardInput, projectCardGraph } from './cardGraph.mjs';

/** Pure project edits, committed in one editor undo step by the caller. */
export function saveCardDefinition(project, raw, { overwrite = false } = {}) {
  const definition = normalizeCardDefinition(raw);
  const existing = project.cardDefinitions?.find(def => def.id === definition.id);
  if (existing && !overwrite) throw new Error(`Card ${definition.id} already exists; use edit_card`);
  const next = { ...project, cardDefinitions: [...(project.cardDefinitions || []).filter(def => def.id !== definition.id), definition] };
  projectCardGraph(next);
  return next;
}

export function patchCardDefinition(definition, { find, replace, replaceAll = false, metadata = {} }) {
  if (typeof find !== 'string' || !find || typeof replace !== 'string') throw new Error('find and replace must be strings; find cannot be empty');
  const occurrences = definition.source.split(find).length - 1;
  if (!occurrences || (!replaceAll && occurrences !== 1)) throw new Error(`find matched ${occurrences} times; read the current source and select a unique passage`);
  const allowed = ['entry','kind','defaults','need_prerendering','compositing','styleKeys'];
  if (Object.keys(metadata).some(key => !allowed.includes(key))) throw new Error('Unsupported card metadata field');
  return normalizeCardDefinition({ ...definition, ...metadata, source: replaceAll ? definition.source.split(find).join(replace) : definition.source.replace(find, () => replace) });
}

export function applyCardDefinition(project, args) {
  const definition = project.cardDefinitions?.find(def => def.id === args.cardId);
  if (!definition) throw new Error(`Unknown project card definition: ${args.cardId}`);
  if (definition.language !== 'python') throw new Error('This definition uses the existing card adapter');
  const next = structuredClone(project);
  let track, clip;
  if (args.clipId) {
    track = next.tracks.find(track => track.clips.some(clip => clip.id === args.clipId));
    clip = track?.clips.find(clip => clip.id === args.clipId);
    if (!clip) throw new Error(`Unknown clip: ${args.clipId}`);
  } else {
    track = next.tracks.find(track => track.id === args.trackId);
    if (!track || !Number.isFinite(args.start) || !Number.isFinite(args.end) || args.end <= args.start) throw new Error('A new card clip requires trackId and start < end');
    clip = { id: args.newClipId || crypto.randomUUID(), start: args.start, end: args.end, params: {}, ...(args.frame ? { frame: args.frame } : {}) };
    track.clips.push(clip);
    next.duration = Math.max(next.duration, args.end);
  }
  const nodeId = args.nodeId || crypto.randomUUID();
  const previous = next.cardNodes?.find(node => node.id === nodeId);
  if (previous && clip.nodeId !== nodeId) throw new Error('Node ID is already used by another card instance');
  const inputs = {};
  for (const [name, input] of Object.entries(args.inputs || {})) {
    const ref = typeof input === 'string' ? { nodeId: input } : input;
    inputs[name] = normalizeCardInput({ ...ref, nodeId: ref.clipId ? `@clip/${ref.clipId}/source` : ref.nodeId });
  }
  if (!Object.keys(inputs).length && (clip.mediaId || clip.cardId)) inputs.source = normalizeCardInput(`@clip/${clip.id}/source`);
  const node = { id: nodeId, adapter: 'python', definitionId: definition.id, params: { ...definition.defaults, ...args.params }, inputs };
  next.cardNodes = [...(next.cardNodes || []).filter(node => node.id !== nodeId), node];
  clip.nodeId = nodeId;
  projectCardGraph(next);
  return { project: next, clipId: clip.id, nodeId };
}

/** Clone a clip-owned Python instance while deliberately sharing definitions.
 * Inputs that address the old clip's synthetic source follow the new clip;
 * other inputs remain external graph references. */
export function cloneCardClipInstance(project, oldClipId, newClipId, nodeId, timeOffset = 0) {
  if (!nodeId) return { project, nodeId };
  const source = project.cardNodes?.find(node => node.id === nodeId);
  if (!source || source.adapter !== 'python') return { project, nodeId };
  const nextId = crypto.randomUUID();
  const oldSource = `@clip/${oldClipId}/source`, newSource = `@clip/${newClipId}/source`;
  const inputs = Object.fromEntries(Object.entries(source.inputs || {}).map(([name, ref]) => {
    const value = typeof ref === 'string' ? { nodeId: ref } : structuredClone(ref);
    // The cloned card clock advances by timeOffset. Its own media source
    // already advances via right.mediaOffset, so subtract the same amount on
    // this edge to avoid applying the split delta twice.
    if (value.nodeId === oldSource) { value.nodeId = newSource; value.offset = (value.offset ?? 0) - timeOffset; }
    return [name, value];
  }));
  return { project: { ...project, cardNodes: [...(project.cardNodes || []), { ...structuredClone(source), id: nextId, inputs, ...(timeOffset ? { timeOffset: (source.timeOffset ?? 0) + timeOffset } : {}) }] }, nodeId: nextId };
}
