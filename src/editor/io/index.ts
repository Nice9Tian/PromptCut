import type { Project } from "../../kernel/project";
import { actions, getState } from "../../store/project";
import { createEmptyProject } from "../../kernel/project";
import { getCard } from "../../kernel/registry";

// 模块级变量存 File，供阶段 2 导出时使用
const mediaFiles = new Map<string, File>();

export function getMediaFile(id: string): File | undefined {
  return mediaFiles.get(id);
}

/** 选一个或多个视频文件,登记成 MediaAsset(blob URL + 探测时长/宽高),并放到视频轨播放头处。返回登记的素材 id。 */
export async function importVideoFiles(files: FileList | File[]): Promise<string[]> {
  const fileArray = Array.from(files);
  const mediaIds: string[] = [];
  let cursor = getState().t;

  for (const file of fileArray) {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.style.display = "none";
    document.body.appendChild(video);

    const { duration, videoWidth, videoHeight } = await new Promise<{ duration: number; videoWidth: number; videoHeight: number }>((resolve) => {
      video.onloadedmetadata = () => {
        resolve({ duration: video.duration, videoWidth: video.videoWidth, videoHeight: video.videoHeight });
      };
      video.onerror = () => {
        console.warn(`[io] 探测视频失败: ${file.name}`);
        resolve({ duration: 5, videoWidth: 1920, videoHeight: 1080 });
      };
      video.src = url;
    });

    document.body.removeChild(video);

    const media = actions.addMedia({
      kind: "video",
      name: file.name,
      url,
      duration,
      width: videoWidth,
      height: videoHeight,
    });

    mediaFiles.set(media.id, file);
    mediaIds.push(media.id);

    const clip = actions.addMediaClip(media.id, cursor);
    if (clip) {
      cursor = clip.end;
    } else {
      console.warn(`[io] addMediaClip 返回 null, mediaId: ${media.id}`);
    }
  }

  return mediaIds;
}

/** 读取 .promptcut.json(或兼容的 overlay 编排 JSON)并载入 store。返回 Project。 */
export async function importProjectFile(file: File): Promise<Project> {
  const text = await file.text();
  const json = JSON.parse(text);

  if (json.version === 1 && Array.isArray(json.tracks)) {
    const empty = createEmptyProject();
    const project: Project = {
      ...empty,
      ...json,
      media: json.media || empty.media,
      tracks: json.tracks || empty.tracks,
    };
    delete (project as unknown as Record<string, unknown>)._note;

    if (project.media) {
      for (const m of project.media) {
        if (m.url.startsWith("blob:") || m.url.startsWith("http:") || m.url.startsWith("https:") || m.url.startsWith("data:") || m.url.startsWith("/")) {
          // keep
        } else {
          console.warn(`[io] 缺失素材: ${m.name} (${m.url})`);
          m.url = "";
          m.name = `(缺失) ${m.name}`;
        }
      }
    }

    actions.loadProject(project, file.name);
    return project;
  } else if (json.cards && Array.isArray(json.cards)) {
    const p = createEmptyProject(file.name.replace(/\.[^/.]+$/, ""));
    actions.loadProject(p, file.name);
    
    let maxEnd = 0;
    for (const c of json.cards) {
      const cardId = c.cardId || c.id || c.card;
      if (!getCard(cardId)) {
        console.warn(`[io] 未知卡片 ${cardId}，已跳过`);
        continue;
      }
      const dur = c.end !== undefined ? c.end - c.start : c.duration;
      const clip = actions.addCardClip(cardId, c.start, { duration: dur, params: c.params });
      if (clip) {
        maxEnd = Math.max(maxEnd, clip.end);
      }
    }
    
    actions.setProjectMeta({ duration: Math.max(maxEnd, 10) });
    return getState().project;
  } else {
    throw new Error("无法识别的项目文件：期望 .promptcut.json 或 {cards:[...]} 编排");
  }
}

/** 把当前项目序列化成 JSON 字符串(blob URL 换成相对路径) */
export function exportProjectJson(): string {
  const p = JSON.parse(JSON.stringify(getState().project)) as Project & { _note?: string };
  p._note = "这个文件只记录编排；media[].url 是素材文件名，重新打开项目后需要用「导入视频」重新导入同名素材，clip 会保留但画面要重新关联。";

  for (const m of p.media) {
    if (m.url.startsWith("blob:")) {
      const file = mediaFiles.get(m.id);
      m.url = file ? file.name : m.name;
    }
  }

  return JSON.stringify(p, null, 2);
}

/**
 * 导出视频:把当前项目交给渲染内核(scripts/export-frames.mjs)逐帧渲染。
 * 浏览器里没法直接起 puppeteer,所以走 dev server 的 /api/export 接口(vite 插件,由本任务实现),
 * 返回一个进度回调可订阅的 job。
 */
export async function exportVideo(opts: { onProgress?: (done: number, total: number) => void } = {}): Promise<{ outDir: string }> {
  const p = JSON.parse(JSON.stringify(getState().project)) as Project;
  
  for (const m of p.media) {
    if (m.url.startsWith("blob:")) {
      const file = mediaFiles.get(m.id);
      if (file) {
        const res = await fetch(`/api/export/media/${encodeURIComponent(file.name)}`, { method: "POST", body: file });
        if (res.ok) {
          const data = await res.json();
          m.url = data.url;
        } else {
          console.warn(`[io] 上传素材失败: ${file.name}`);
          m.url = "";
        }
      } else {
        console.warn(`[io] 找不到 blob 对应的 File: ${m.name}`);
        m.url = "";
      }
    }
  }

  const frames = (opts as { frames?: string }).frames;
  const res = await fetch("/api/export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project: p, frames })
  });
  if (!res.ok) throw new Error(await res.text());
  
  const { id, outDir } = await res.json();

  return new Promise((resolve, reject) => {
    const es = new EventSource(`/api/export/${id}?sse=1`);
    let settled = false;
    es.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.status === "running") {
        opts.onProgress?.(data.done, data.total);
      } else if (data.status === "done") {
        if (!settled) {
          settled = true;
          opts.onProgress?.(data.total, data.total);
          es.close();
          resolve({ outDir });
        }
      } else if (data.status === "error") {
        if (!settled) {
          settled = true;
          es.close();
          reject(new Error(data.message || "导出错误"));
        }
      }
    };
    es.onerror = () => {
      if (!settled) {
        settled = true;
        es.close();
        reject(new Error("EventSource error"));
      }
    };
  });
}

declare global {
  interface Window {
    __pcIo?: Record<string, unknown>;
  }
}

if (typeof window !== "undefined") {
  // 临时验证出口：puppeteer 无头验证时直接调用这四个函数（不用模拟 <input type=file>）。
  window.__pcIo = { importVideoFiles, importProjectFile, exportProjectJson, exportVideo };
}
