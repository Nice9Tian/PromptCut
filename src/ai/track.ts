/**
 * 运动追踪的前端胶水：起作业、轮询、拿轨迹。
 *
 * 追踪跑在服务端（BootsTAPIR，未装拓展时前端退回模板匹配），这边只负责等和存。
 * 和镜头识别不同，轨迹**不写进项目文档**：查询点是用户每次现指的，同一段素材
 * 可以追很多组点，塞进 project 只会让工程文件无限膨胀。所以结果留在内存里，
 * 由 right/index.tsx 的 Map 持有，够 get_track 取一次就行。
 */

export interface TrackPoint {
  /** 用户指定的查询点 [帧号, x, y]，原始像素 */
  query: [number, number, number];
  /** 逐帧坐标，原始像素 */
  xy: [number, number][];
  /** 逐帧是否可见。被遮挡或移出画面为 false，此时 xy 是模型的猜测 */
  visible: boolean[];
}

export interface TrackJobState {
  status: "running" | "done" | "error";
  engine: "bootstapir";
  percent: number;
  message?: string;
  width?: number;
  height?: number;
  frames?: number;
  points?: TrackPoint[];
}

export interface TrackResult {
  engine: string;
  createdAt: string;
  width: number;
  height: number;
  frames: number;
  points: TrackPoint[];
}

/** 拓展装没装。没装时 engine 是 template，精度差很多。 */
export async function trackStatus(): Promise<{ ready: boolean; engine: string; detail?: unknown }> {
  const r = await fetch("/api/track/status");
  if (!r.ok) throw new Error("查不到运动追踪拓展的状态");
  return r.json();
}

export async function startTracking(
  mediaPath: string,
  mediaId: string,
  points: number[][],
): Promise<string> {
  const r = await fetch("/api/track/track", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: mediaPath, mediaId, points }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) throw new Error(data.error || "运动追踪没能启动");
  return data.jobId as string;
}

export async function pollTrackJob(jobId: string): Promise<TrackJobState> {
  const r = await fetch(`/api/track/job/${jobId}`);
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) throw new Error(data.error || "查不到这个追踪作业");
  return data.job as TrackJobState;
}

/** 等一个作业跑完。250 帧约 26 秒，所以轮询间隔给 1 秒。 */
export async function waitForTrack(
  jobId: string,
  onProgress?: (pct: number, engine: string) => void,
): Promise<TrackResult> {
  for (;;) {
    const job = await pollTrackJob(jobId);
    onProgress?.(job.percent, job.engine);
    if (job.status === "error") throw new Error(job.message || "运动追踪失败");
    if (job.status === "done") {
      return {
        engine: job.engine,
        createdAt: new Date().toISOString(),
        width: job.width ?? 0,
        height: job.height ?? 0,
        frames: job.frames ?? 0,
        points: job.points ?? [],
      };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}
