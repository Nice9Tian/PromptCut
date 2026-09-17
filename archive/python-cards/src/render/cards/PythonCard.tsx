import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { Project } from "../../kernel/project";
import { beginFrameWork } from "../../kernel/frameReady";
import { CardSurface } from "./CardSurface";
import type { CardGpuError, CardGpuValue, ValueResolver } from "./gpuExecutor";
import { CardMediaSource } from "./mediaSource";
import { projectCardGraph } from "../../kernel/cardGraph.mjs";

type Value = { value: CardGpuValue; revision: string; registered?: boolean };
const registrations = new WeakMap<Project, Map<string, Value>>();

/** The same asynchronous canvas is used by preview, Agent capture and export.
 * The frame-work ticket prevents a pending/failed GPU canvas from becoming a
 * completed screenshot. Interactive placeholders are a separate host policy. */
export function PythonCard({ project, nodeId, time }: { project: Project; nodeId: string; time: number }) {
  const [value, setValue] = useState<(Value & { evaluatedTime: number; evaluatedProject: Project; evaluatedNodeId: string }) | null>(null);
  const [failure, setFailure] = useState("");
  const ticket = useRef<ReturnType<typeof beginFrameWork> | null>(null);
  const bitmaps = useRef(new Map<string, Promise<ImageBitmap>>());
  const decoder = useRef(new CardMediaSource());
  useLayoutEffect(() => {
    const controller = new AbortController();
    ticket.current?.dispose();
    const work = beginFrameWork(`Python ${nodeId} @ ${time}`); ticket.current = work;
    setFailure("");
    const registered = registrations.get(project)?.get(nodeId);
    const evaluate = registered ? Promise.resolve(registered) : fetch('/api/card-runtime/visual', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
      body: JSON.stringify({ project, nodeId, time }),
    }).then(async response => {
      const result = await response.json();
      if (!response.ok || !result.value) throw new Error(result.error || 'Python card returned no picture');
      if (result.registered) {
        if (!registrations.has(project)) registrations.set(project, new Map());
        registrations.get(project)!.set(nodeId, result);
      }
      return result as Value;
    });
    void evaluate.then(result => { if (!controller.signal.aborted) setValue({ ...result, evaluatedTime: time, evaluatedProject: project, evaluatedNodeId: nodeId }); })
      .catch(error => { if (!controller.signal.aborted) { work.fail(error); setFailure(error.message); } });
    return () => { controller.abort(); work.dispose(); };
  }, [project, nodeId, time]);
  const resolveSource: ValueResolver = useCallback(async (source, requestedTime, signal) => {
    let media: any;
    let mediaTime = requestedTime;
    if (source.type === 'source') {
      const node = projectCardGraph(project).nodes.find(node => node.id === source.nodeId) as any;
      if (node?.adapter === 'media' && node.media?.url) { media = node.media; mediaTime += node.offset || 0; }
    }
    const url = media ? `media:${media.url}:${mediaTime}` : source.type === 'pixels' ? source.url : '/api/card-runtime/source?scope=' + value?.revision
      + '&nodeId=' + encodeURIComponent(source.nodeId) + '&time=' + requestedTime;
    if (!url) throw new Error('Pixel result has no host URL');
    if (!bitmaps.current.has(url)) {
      const pending = media ? decoder.current.frame(media, mediaTime, signal) : fetch(url, { signal }).then(async response => {
        if (!response.ok) throw new Error(await response.text());
        return createImageBitmap(await response.blob(), { premultiplyAlpha: 'none' });
      });
      bitmaps.current.set(url, pending.catch(error => { bitmaps.current.delete(url); throw error; }));
    }
    const bitmap = await bitmaps.current.get(url)!;
    // Keep a small seek window rather than every full-resolution input frame.
    if (bitmaps.current.size > 12) {
      const oldest = bitmaps.current.keys().next().value!;
      if (oldest !== url) { const prior = bitmaps.current.get(oldest); bitmaps.current.delete(oldest); void prior?.then(b => b.close(), () => {}); }
    }
    return bitmap;
  }, [value?.revision, project]);
  useLayoutEffect(() => { decoder.current = new CardMediaSource(); return () => {
    decoder.current.dispose(); for (const bitmap of bitmaps.current.values()) void bitmap.then(b => b.close(), () => {}); bitmaps.current.clear();
  }; }, [project]);
  const ready = useCallback(() => { const work = ticket.current; work?.ready(); }, []);
  const failed = useCallback((error: CardGpuError) => { const work = ticket.current; work?.fail(error); setFailure(error.message); }, []);
  return <div data-pc-python-node={nodeId} data-pc-card-error={failure || undefined} style={{ width: '100%', height: '100%' }}>
    {value && <CardSurface value={value.value} width={project.width} height={project.height}
      time={time} enabled={value.evaluatedTime === time && value.evaluatedProject === project && value.evaluatedNodeId === nodeId}
      resolveSource={resolveSource} onReady={ready} onError={failed} />}
    {failure && <span role="status">{failure}</span>}
  </div>;
}
