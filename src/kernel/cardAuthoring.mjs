import { normalizeCardInput, projectCardGraph } from './cardGraph.mjs';

/** 图卡 = 注册表里写了 `card` 或 `audio` 的普通 CardDef。定义永远从注册表取,
 * 不存进项目 JSON —— 它和 TSX 用户卡一样是 `src/cards/user/<id>.tsx` 文件。 */
const isGraphCard = def => !!def && (typeof def.card === 'function' || typeof def.audio === 'function');

/** 纯 DOM 卡(有组件、没有 card / audio)。第一版图卡不接它的输出。 */
const isDomCard = def => !!def && !isGraphCard(def);

/**
 * 把一张图卡挂到片段上(新建片段或套在已有片段上),一步撤销由调用方合并。
 *
 * `getCard` 是注册表的取卡函数(浏览器侧 `src/kernel/registry`)。定义不在项目里,
 * 所以这个参数不是可选的锦上添花 —— 不传就一张卡也找不到。
 */
export function applyCardDefinition(project, args, getCard = () => undefined) {
  const definition = getCard(args.cardId);
  if (!definition) throw new Error(`Unknown card: ${args.cardId}`);
  if (!isGraphCard(definition)) throw new Error('This definition uses the existing card adapter');
  const next = structuredClone(project);
  const clipById = id => next.tracks?.flatMap(track => track.clips ?? []).find(clip => clip.id === id);
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

  /*
   * ① 物化。面板拖入 / add_clip 建的图卡片段只有 cardId,渲染时靠 projectCardGraph
   * 就地合成的 `@clip/<id>/card` 出画 —— 那个 id 只在渲染路径上存在,不能被 inputs 引用。
   * 所以目标片段和被引用的片段里,凡是「图卡片段但没有 nodeId」的,先建出正式节点。
   */
  const materialize = target => {
    if (!target || target.nodeId || !target.cardId) return;
    const def = getCard(target.cardId);
    if (!isGraphCard(def)) return;
    const id = crypto.randomUUID();
    next.cardNodes = [...(next.cardNodes || []), { id, adapter: 'card', cardId: target.cardId,
      kind: def.kind ?? 'animation', inputs: {}, params: { ...def.defaults, ...target.params } }];
    target.nodeId = id;
  };
  const referencedClips = Object.values(args.inputs || {})
    .map(input => (typeof input === 'string' ? undefined : input?.clipId)).filter(Boolean);
  materialize(clip);
  for (const id of referencedClips) materialize(clipById(id));

  // 第一版不接 DOM 卡:既不套在 DOM 卡段上,也不引用 DOM 卡的输出。
  if (isDomCard(getCard(clip.cardId))) throw new Error('图卡第一版不接 DOM 卡输入');
  for (const id of referencedClips) if (isDomCard(getCard(clipById(id)?.cardId))) throw new Error('图卡第一版不接 DOM 卡输入');

  /*
   * 同一片段不能同时挂音频图卡和视觉图卡:音频图卡不写 clip.cardId,所以判据只能看
   * clip.nodeId 指向的那个节点的 kind(而且下面 `clip.nodeId = nodeId` 会把它覆盖掉)。
   */
  const priorNodeId = clip.nodeId;
  const prior = priorNodeId ? next.cardNodes?.find(node => node.id === priorNodeId) : undefined;
  if (prior?.adapter === 'card' && (prior.kind === 'audio') !== (definition.kind === 'audio'))
    throw new Error('同一片段不能同时挂音频图卡和视觉图卡，先复制片段');

  const nodeId = args.nodeId || crypto.randomUUID();
  const previous = next.cardNodes?.find(node => node.id === nodeId);
  if (previous && clip.nodeId !== nodeId) throw new Error('Node ID is already used by another card instance');
  /** 传当前 clip.nodeId = 原地改这个实例的参数和输入(不接链,接了就是自指、必抛 cycle) */
  const inPlace = !!args.nodeId && args.nodeId === priorNodeId;

  // ② 显式 inputs。`clipId` 对素材段映射成它的 `@clip/<id>/source`,
  // 对图卡片段映射成它自己的输出节点(转场卡的一路输入是另一张图卡就靠这条)。
  const sourceOf = clipId => {
    const target = clipById(clipId);
    return target?.nodeId && isGraphCard(getCard(target.cardId)) ? target.nodeId : `@clip/${clipId}/source`;
  };
  const explicit = !!Object.keys(args.inputs || {}).length;
  const inputs = {};
  for (const [name, input] of Object.entries(args.inputs || {})) {
    const ref = typeof input === 'string' ? { nodeId: input } : input;
    inputs[name] = normalizeCardInput({ ...ref, nodeId: ref.clipId ? sourceOf(ref.clipId) : ref.nodeId });
  }
  for (const ref of Object.values(inputs)) {
    const synthetic = /^@clip\/(.+)\/source$/.exec(ref.nodeId);
    const owner = synthetic ? clipById(synthetic[1]) : undefined;
    const node = next.cardNodes?.find(node => node.id === ref.nodeId);
    if (node?.adapter === 'chrome' || (owner && !owner.mediaId && isDomCard(getCard(owner.cardId))))
      throw new Error('图卡第一版不接 DOM 卡输入');
  }

  /*
   * ③ 继承 / 自动接链,二选一。顺序只有这一种排法成立:继承排在兜底之后的话,
   * 「素材段上原地改一张旧 inputs 为空的图卡」会先被兜底塞进 @clip/<id>/source
   * 再被空 inputs 抹掉。
   */
  if (inPlace) {
    // 原地改卡没传 inputs 就沿用旧节点的上游边,不然每次改参数都会把链剪断
    if (!explicit && previous?.inputs) for (const [name, ref] of Object.entries(previous.inputs)) inputs[name] = normalizeCardInput(ref);
  } else if (!explicit && priorNodeId) {
    // 「先套反色再套模糊」:第二张的输入自动接第一张的输出,
    // 而不是接那个以本卡为 cardId 的 chrome 合成节点。
    inputs.source = normalizeCardInput({ nodeId: priorNodeId });
  }

  // ④ 兜底。第二次 apply_card 打同一片段时 clip.cardId 已经是本卡 id,
  // 不排除它就会塞一条指向自己的 source 输入、digest 跟着变。
  if (!Object.keys(inputs).length && (clip.mediaId || (clip.cardId && clip.cardId !== definition.id)))
    inputs.source = normalizeCardInput(`@clip/${clip.id}/source`);

  // ⑤ 建节点。kind 从定义抄进节点:Node 侧脚本读不到 TSX 定义,只能看节点。
  const node = { id: nodeId, adapter: 'card', cardId: definition.id, kind: definition.kind ?? 'animation',
    params: { ...definition.defaults, ...args.params }, inputs };
  next.cardNodes = [...(next.cardNodes || []).filter(node => node.id !== nodeId), node];

  /*
   * ⑥ 写片段字段。**赋值必须排在兜底之后**:写早了,无输入的图卡会被 ④ 塞一条指向自己的 source。
   * 音频图卡例外,只写 nodeId ——它没有 card 也没有 Component,进了 Stage 就是 <undefined />;
   * 它的消费方只看节点,片段照旧被素材层跳过、画面上不多一层。
   */
  clip.nodeId = nodeId;
  if (definition.kind !== 'audio') clip.cardId = definition.id;
  // 实例参数节点存一份、片段也存一份:右栏和 setClipParams 写的是 clip.params,
  // Stage 读的也是它,不照抄就是 apply_card 的 params 在画面上静默丢掉。
  clip.params = { ...definition.defaults, ...args.params };
  projectCardGraph(next, getCard);
  return { project: next, clipId: clip.id, nodeId };
}

/** Clone a clip-owned 图卡 instance while deliberately sharing definitions.
 * Inputs that address the old clip's synthetic source follow the new clip;
 * other inputs remain external graph references. */
export function cloneCardClipInstance(project, oldClipId, newClipId, nodeId, timeOffset = 0) {
  if (!nodeId) return { project, nodeId };
  const source = project.cardNodes?.find(node => node.id === nodeId);
  if (!source || source.adapter !== 'card') return { project, nodeId };
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
