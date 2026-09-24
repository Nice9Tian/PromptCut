import { useEffect, useRef } from "react";
import type { Project } from "../../kernel/project";
import { frameRequest } from "../../render/frameClient";
import { createPreloadScheduler, type PreloadScheduler, type PreloadStatus } from "./prerenderPreload";
import { onReadyLost } from "../snapshotFeed";

/**
 * 页面触发预渲染的公共 hook(调度见 `prerenderPreload.ts`):编辑推送成功、空闲时防抖发 `preload`,没就绪就接着问。
 *
 * - 双舞台预览(`Preview.tsx`):`idle` = 不在播放、不在拖动;
 * - legacy 预览(`UnifiedPreview`):沿用以前的行为,`idle` 恒为 true,`onStatus` 归档采样帧。
 */
export function usePrerenderPreload(project: Project, opts: { enabled: boolean; idle: boolean; onStatus?: (status: PreloadStatus, project: Project) => void }): void {
  const projectRef = useRef(project);
  projectRef.current = project;
  const onStatusRef = useRef(opts.onStatus);
  onStatusRef.current = opts.onStatus;
  const schedulerRef = useRef<PreloadScheduler | null>(null);

  useEffect(() => {
    if (!opts.enabled) return;
    const scheduler = createPreloadScheduler({
      request: () => frameRequest("preload", projectRef.current, {}, undefined, { target: "prerender", lane: "background" }),
      onStatus: (status) => onStatusRef.current?.(status, projectRef.current),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    });
    schedulerRef.current = scheduler;
    // 预渲染进程丢了这个会话的版本(重启 / 回收):马上补发一次,播放中也发(Item 4)
    const offLost = onReadyLost(() => scheduler.resync());
    return () => {
      offLost();
      scheduler.dispose();
      if (schedulerRef.current === scheduler) schedulerRef.current = null;
    };
  }, [opts.enabled]);

  // 空闲状态先于编辑通知送进去:同一次渲染里两样都变时,编辑那一下才按新的空闲状态排
  useEffect(() => { schedulerRef.current?.setIdle(opts.idle); }, [opts.enabled, opts.idle]);
  useEffect(() => { schedulerRef.current?.edited(); }, [opts.enabled, project]);
}
