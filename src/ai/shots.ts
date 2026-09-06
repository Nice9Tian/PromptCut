/**
 * 镜头切换识别的前端胶水：起作业、轮询、把结果写进 store。
 *
 * 检测跑在服务端（TransNetV2 或 scdet 兜底），这边只负责等和存。
 */
import type { Shots } from "../kernel/project";

export interface ShotsJobState {
  status: "running" | "done" | "error";
  engine: "transnetv2" | "scdet";
  percent: number;
  message?: string;
  transitions?: Shots["transitions"];
  shots?: Shots["shots"];
}

/** 拓展装没装。没装也能用，只是退回 scdet、认不出溶解。 */
export async function shotsStatus(): Promise<{ ready: boolean; engine: string; detail?: unknown }> {
  const r = await fetch("/api/shots/status");
  if (!r.ok) throw new Error("查不到镜头识别拓展的状态");
  return r.json();
}

export async function startShotDetection(mediaPath: string, mediaId: string): Promise<string> {
  const r = await fetch("/api/shots/detect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: mediaPath, mediaId }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) throw new Error(data.error || "镜头识别没能启动");
  return data.jobId as string;
}

export async function pollShotJob(jobId: string): Promise<ShotsJobState> {
  const r = await fetch(`/api/shots/job/${jobId}`);
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) throw new Error(data.error || "查不到这个检测作业");
  return data.job as ShotsJobState;
}

/** 等一个作业跑完。检测 5 分钟素材约 36 秒，所以轮询间隔给 1 秒。 */
export async function waitForShots(jobId: string, onProgress?: (pct: number, engine: string) => void): Promise<Shots> {
  for (;;) {
    const job = await pollShotJob(jobId);
    onProgress?.(job.percent, job.engine);
    if (job.status === "error") throw new Error(job.message || "镜头识别失败");
    if (job.status === "done") {
      return {
        engine: job.engine,
        createdAt: new Date().toISOString(),
        transitions: job.transitions ?? [],
        shots: job.shots ?? [],
      };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}
