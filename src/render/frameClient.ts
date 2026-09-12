import type { Project } from "../kernel/project";
import { invalidatePrerenderBase, prerenderUrl } from "../editor/prerender";

export type FrameTarget = "user" | "prerender";
export type FrameLane = "user" | "agent" | "background";
export interface FrameRequestOptions {
  /** 人类预览同源；长任务和后台预烘可显式走预渲染进程。 */
  target?: FrameTarget;
  lane?: FrameLane;
}

const signature = (project: Project) => JSON.stringify([project.width, project.height, project.fps, project.duration, project.themeId, project.camera3dFov, project.tracks, project.media, project.filters, project.pixelMaps, project.audioFx]);
let saved: { signature: string; snapshots: string } | null = null;
let restorePending: Promise<void> | null = null;
export function snapshotsFor(project: Project) { return saved?.signature === signature(project) ? saved.snapshots : undefined; }
export function restoreSnapshots(project: Project, snapshots?: string) {
  saved = typeof snapshots === "string" ? { signature: signature(project), snapshots } : null;
  restorePending = saved
    ? frameRequest("import", project, { snapshots: saved.snapshots }, undefined, { target: "user", lane: "user" }).then(() => undefined, () => undefined)
    : null;
}
function frameFetchError(error: any) {
  if (error?.name === "AbortError") return error;
  const detail = error?.cause?.code || error?.cause?.message || error?.message || String(error);
  return Object.assign(new Error(`帧服务连接中断（${detail}）。渲染 Chrome 或服务可能正在重启，请稍后重试。`, { cause: error }), {
    code: "FRAME_SERVICE_UNAVAILABLE",
    retryable: true,
  });
}
export async function frameRequest(operation: string, project: Project, extra: Record<string, unknown> = {}, signal?: AbortSignal, options: FrameRequestOptions = {}) {
  let url = options.target === "prerender" ? await prerenderUrl(`/api/frames/${operation}`) : `/api/frames/${operation}`;
  let res: Response;
  const request = () => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project, lane: options.lane, ...extra }), signal });
  try {
    res = await request();
  } catch (error) {
    // A prerender restart changes its port.  Retry one time against the new
    // health-checked address; never retry a caller cancellation.
    if (options.target === "prerender" && (error as any)?.name !== "AbortError") {
      invalidatePrerenderBase();
      try {
        url = await prerenderUrl(`/api/frames/${operation}`);
        res = await request();
      } catch (retryError) { throw frameFetchError(retryError); }
    } else throw frameFetchError(error);
  }
  let result: any;
  try { result = await res.json(); }
  catch (error) { throw frameFetchError(error); }
  if (!res.ok) throw Object.assign(new Error(result.error || "帧读取失败"), {
    code: result.code,
    status: res.status,
    retryable: result.retryable,
  });
  if (result.video) result.video = new URL(result.video, new URL(url, location.href)).href;
  if (result.frames) result.frames = result.frames.map((f: any) => ({ ...f, url: new URL(f.url, new URL(url, location.href)).href }));
  return result;
}
export async function collectSnapshots(project: Project) {
  const result = await frameRequest("archive", project, {}, undefined, { target: "user", lane: "user" });
  saved = { signature: signature(project), snapshots: result.snapshots };
  restorePending = null;
}
/** Timeline preview and Agent use this same server queue. */
export async function see_frames(project: Project, times: number[], signal?: AbortSignal, options: FrameRequestOptions = {}) {
  // Loading a .proc restores the compressed archive asynchronously.  Wait for
  // that import before the first foreground request so a freshly opened
  // project can actually hit its saved B/C cache instead of starting A again.
  await restorePending;
  return frameRequest("see", project, { times }, signal, { target: options.target ?? "user", lane: options.lane ?? "user" });
}
