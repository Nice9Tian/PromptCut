import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { cardJson } from "../../kernel/cardGraph.mjs";
import type { CardNode } from "../../kernel/cardGraph.mjs";
import { beginFrameWork } from "../../kernel/frameReady";
import { getCard } from "../../kernel/registry";
import type { CardDef, Clip, GraphCardSource, Timeline } from "../../kernel/types";
import { CARD_AUDIO_SAMPLE_RATE } from "../../audio/cardAudio";
import { blockOf, resolveAudioRef, type AudioSourceContext } from "./audioSources";
import { CardSurface } from "./CardSurface";
import { CardGpuExecutor, type CardGpuError, type CardGpuValue, type PixelsValue, type SourceValue, type ValueResolver } from "./gpuExecutor";
import { CardMediaSource } from "./mediaSource";

type Graph = Timeline["graph"];

/** 只看节点:图里有这个节点、是图卡节点、不是音频卡 —— 那这个片段的画面由 GraphCard 出,
 * 原始素材层不再画(否则滤镜卡会叠成「原片 + 滤镜」两层)。 */
export function graphVisualNode(graph: Graph, nodeId?: string) {
  if (!nodeId) return false;
  const node = graph?.nodes.find((node) => node.id === nodeId);
  return !!node && node.adapter === "card" && node.kind !== "audio";
}

/** 上游递归的深度上限。环由 validateCardGraph 的层级校验挡掉,这里只防深度。 */
const MAX_DEPTH = 8;

/**
 * 图卡的宿主组件:`card()` 在页面里跑(没有任何服务端往返),
 * 算出的 `CardGpuValue` 交 `CardSurface` 在 WebGL 上执行。
 *
 * 输入自己解:素材节点走浏览器的 `CardMediaSource`,上游图卡节点在一块离屏画布上
 * 递归执行成位图。整条路上一个请求都不发(素材经 `/@media` 的那条照常)。
 */
export function GraphCard({ def, clip, graph, fps, t, params, stage }: {
  def: CardDef<any>;
  clip: Clip;
  graph: Graph;
  fps: number;
  t: number;
  params: Record<string, unknown>;
  stage?: { width: number; height: number; camera3dFov?: number };
}) {
  const [value, setValue] = useState<{ value: CardGpuValue; evaluatedTime: number; evaluatedGraph: Graph; evaluatedNodeId: string } | null>(null);
  const [failure, setFailure] = useState("");
  const ticket = useRef<ReturnType<typeof beginFrameWork> | null>(null);
  const bitmaps = useRef(new Map<string, Promise<ImageBitmap>>());
  const decoder = useRef(new CardMediaSource());
  /** 每个深度一块离屏画布 + 一个执行器,跟着这张卡活,不每帧新建 WebGL 上下文 */
  const upstream = useRef(new Map<number, { canvas: OffscreenCanvas; executor: CardGpuExecutor }>());

  const width = stage?.width ?? 1920;
  const height = stage?.height ?? 1080;
  // 面板拖入 / add_clip 建的图卡片段没有 nodeId,图里是就地合成的那个渲染节点
  const nodeId = clip.nodeId ?? `@clip/${clip.id}/card`;
  const duration = clip.end - clip.start;

  const nodeAt = useCallback((id: string) => graph?.nodes.find((node) => node.id === id), [graph]);

  /** 一个节点在 `time` 的画面,解成位图。素材节点走解码器,图卡节点递归执行。 */
  const renderNode = useCallback(async (id: string, time: number, depth: number, signal?: AbortSignal): Promise<ImageBitmap> => {
    if (depth > MAX_DEPTH) throw new Error("图卡输入嵌套过深");
    const node = nodeAt(id);
    if (!node) throw new Error(`图卡输入节点不存在：${id}`);
    const media = node.adapter === "media" ? (node.media as { url?: string } | undefined) : undefined;
    const key = media?.url
      ? `media:${media.url}:${time + (Number(node.offset) || 0)}`
      : `node:${id}:${time}:${depth}`;
    if (!bitmaps.current.has(key)) {
      const pending = media?.url
        ? decoder.current.frame(media as any, time + (Number(node.offset) || 0), signal)
        : renderUpstream(node, time, depth, signal);
      bitmaps.current.set(key, pending.catch((error) => { bitmaps.current.delete(key); throw error; }));
    }
    const bitmap = await bitmaps.current.get(key)!;
    // Keep a small seek window rather than every full-resolution input frame.
    if (bitmaps.current.size > 12) {
      const oldest = bitmaps.current.keys().next().value!;
      if (oldest !== key) { const prior = bitmaps.current.get(oldest); bitmaps.current.delete(oldest); void prior?.then((b) => b.close(), () => {}); }
    }
    return bitmap;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeAt, width, height]);

  const renderUpstream = useCallback(async (node: CardNode, time: number, depth: number, signal?: AbortSignal): Promise<ImageBitmap> => {
    if (node.adapter !== "card") throw new Error(`图卡输入节点不是图卡：${node.id}`);
    const upstreamDef = getCard(node.cardId as string);
    if (typeof upstreamDef?.card !== "function") throw new Error(`上游图卡的定义找不到：${node.cardId}`);
    const upstreamParams = { ...upstreamDef.defaults, ...(node.params as Record<string, unknown>) };
    const upstreamValue = await upstreamDef.card(sourcesOf(node, time, depth), time, upstreamParams,
      { fps, width, height, duration, stage });
    let slot = upstream.current.get(depth);
    if (!slot) {
      const canvas = new OffscreenCanvas(Math.max(1, width), Math.max(1, height));
      const executor = new CardGpuExecutor(canvas, (source, requestedTime, innerSignal) =>
        resolveValue(source, requestedTime, depth + 1, innerSignal));
      slot = { canvas, executor };
      upstream.current.set(depth, slot);
    }
    if (slot.canvas.width !== Math.max(1, width) || slot.canvas.height !== Math.max(1, height)) {
      slot.canvas.width = Math.max(1, width); slot.canvas.height = Math.max(1, height);
    }
    await slot.executor.execute(upstreamValue, time, signal);
    return createImageBitmap(slot.canvas);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fps, width, height, duration, stage]);

  const resolveValue = useCallback(async (source: SourceValue | PixelsValue, requestedTime: number, depth: number, signal?: AbortSignal) => {
    if (source.type !== "source") throw new Error("图卡不产生需要宿主下载的像素结果");
    return renderNode(source.nodeId, requestedTime, depth, signal);
  }, [renderNode]);

  /** 一个节点的 `sources`:`at()` 只给引用,`pixels()` 才落像素,`block()` 取采样。 */
  const sourcesOf = useCallback((node: CardNode, time: number, depth: number): Record<string, GraphCardSource> => {
    const audioContext: AudioSourceContext = { graph, project: { tracks: [], media: [] }, getCard, sampleRate: CARD_AUDIO_SAMPLE_RATE };
    const sources: Record<string, GraphCardSource> = {};
    for (const [name, input] of Object.entries(node.inputs ?? {})) {
      const ref = typeof input === "string" ? { nodeId: input, offset: 0, rate: 1 } : { offset: 0, rate: 1, ...input };
      sources[name] = {
        nodeId: ref.nodeId,
        at: (at?: number) => ({ type: "source", nodeId: ref.nodeId, offset: ref.offset, rate: ref.rate,
          ...(at === undefined ? null : { time: at }) }) as SourceValue,
        pixels: (at?: number, signal?: AbortSignal) =>
          renderNode(ref.nodeId, (at ?? time) * (ref.rate ?? 1) + (ref.offset ?? 0), depth + 1, signal),
        block: (start: number, count: number) => blockOf(audioContext, resolveAudioRef(audioContext, input), start, count),
      };
    }
    /*
     * 输入片段被删掉时 validateCardGraph 把那条边丢了、名字留在 missingInputs 里。
     * 这里挂一个一读就抛的取值器:`card()` 碰它才抛,被下面 evaluate 的 .catch 接住
     * 变成错误态 —— 一张坏卡不该让整份图或者整个舞台陪葬。
     */
    for (const name of (node.missingInputs as string[] | undefined) ?? []) {
      Object.defineProperty(sources, name, { enumerable: true, configurable: true,
        get() { throw new Error("输入片段已删除：" + name); } });
    }
    return sources;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, renderNode]);

  useLayoutEffect(() => {
    if (!graph) return;
    const controller = new AbortController();
    ticket.current?.dispose();
    const work = beginFrameWork(`图卡 ${nodeId} @ ${t}`); ticket.current = work;
    setFailure("");
    const evaluate = (async () => {
      const node = nodeAt(nodeId);
      if (!node) throw new Error(`图卡节点不存在：${nodeId}`);
      if (typeof def.card !== "function") throw new Error(`${def.id} 不是视觉图卡`);
      return def.card(sourcesOf(node, t, 0), t, params, { fps, width, height, duration, stage });
    })();
    void evaluate
      .then((result) => { if (!controller.signal.aborted) setValue({ value: result, evaluatedTime: t, evaluatedGraph: graph, evaluatedNodeId: nodeId }); })
      .catch((error) => { if (!controller.signal.aborted) { work.fail(error); setFailure(error instanceof Error ? error.message : String(error)); } });
    return () => { controller.abort(); work.dispose(); };
    // `params` 每次 render 都是新对象,直接进依赖就是 effect → setValue → 重渲染 → 自激死循环
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [def, clip.nodeId, graph, t, cardJson(params)]);

  const resolveSource: ValueResolver = useCallback((source, requestedTime, signal) =>
    resolveValue(source, requestedTime, 1, signal), [resolveValue]);

  useLayoutEffect(() => {
    decoder.current = new CardMediaSource();
    const cache = bitmaps.current, executors = upstream.current;
    return () => {
      decoder.current.dispose();
      for (const bitmap of cache.values()) void bitmap.then((b) => b.close(), () => {});
      cache.clear();
      for (const slot of executors.values()) slot.executor.dispose();
      executors.clear();
    };
  }, [graph]);

  const ready = useCallback(() => { ticket.current?.ready(); }, []);
  const failed = useCallback((error: CardGpuError) => { ticket.current?.fail(error); setFailure(error.message); }, []);

  if (!graph) return null;
  return <div data-pc-graph-node={nodeId} data-pc-card-error={failure || undefined} style={{ width: "100%", height: "100%" }}>
    {value && <CardSurface value={value.value} width={width} height={height}
      time={t} enabled={value.evaluatedTime === t && value.evaluatedGraph === graph && value.evaluatedNodeId === nodeId}
      resolveSource={resolveSource} onReady={ready} onError={failed} />}
    {failure && <span role="status">{failure}</span>}
  </div>;
}
