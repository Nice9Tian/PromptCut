import type { Project, TranscriptSegment } from "../../kernel/project";
import { actions, getState } from "../../store/project";
import { createEmptyProject } from "../../kernel/project";
import { resetProjectAi } from "../../ai/projectAi";
import { getCard } from "../../kernel/registry";
import { mediaUrlFromPath, restoreMediaUrls } from "./mediaUrls";

// 模块级变量存 File，供阶段 2 导出时使用
const mediaFiles = new Map<string, File>();

export function getMediaFile(id: string): File | undefined {
  const own = mediaFiles.get(id);
  if (own) return own;
  // 「创建为声音」派生出来的那份没有自己的 File(它和源视频是同一个文件),借源素材的。
  // 转写、导出都走这里,漏了这一步派生的声音就成了「文件不在内存里」
  const src = getState().project.media.find((m) => m.id === id)?.soundOf;
  return src ? mediaFiles.get(src) : undefined;
}

/**
 * 在 io 之外登记的素材，把原始 File 交回这张表。
 *
 * 这张表是 getMediaFile 的唯一来源，而 getMediaFile 撑着两件事：语音转写要拿原文件
 * 上传（stt.ts），导出时 blob: 的素材要重新传一份给渲染进程。绕过它登记的素材
 * 两样都会悄悄失灵 —— 转写报「素材文件不在内存里」，导出则把那条素材的 url 清空，
 * 而这两处都不会说是「导入时漏登记」造成的。
 */
export function registerMediaFile(id: string, file: File): void {
  mediaFiles.set(id, file);
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

    try {
      const res = await fetch(`/api/media/upload/${encodeURIComponent(file.name)}`, {
        method: "POST",
        body: file,
      });
      if (res.ok) {
        const data = await res.json();
        if (data.ok && data.path) {
          actions.setMediaPath(media.id, data.path);
        }
      } else {
        console.warn(`[io] 上传素材失败: ${file.name}`);
      }
    } catch (err) {
      console.warn(`[io] 上传素材异常: ${file.name}`, err);
    }
  }

  return mediaIds;
}

/**
 * 登记一个**已经在服务端素材目录里**的文件(素材收集下载好的那种)。
 *
 * 和 importVideoFiles 走同一条登记路:探时长宽高、addMedia、登记 File、放到视频轨。
 * 唯一的差别是不再 POST 上传一遍 —— 文件本来就在 out/media 里,path 直接给,
 * 几十上百 MB 的视频再往服务端传一次纯属浪费。
 */
export async function importVideoFromServer(opts: { url: string; path: string; name?: string }): Promise<string> {
  const res = await fetch(opts.url);
  if (!res.ok) throw new Error(`取文件失败(HTTP ${res.status}):${opts.url}`);
  const blob = await res.blob();
  const name = opts.name || decodeURIComponent(opts.url.split("/").pop() || "video.mp4");
  const file = new File([blob], name, { type: blob.type || "video/mp4" });
  const url = URL.createObjectURL(file);

  const video = document.createElement("video");
  video.preload = "metadata";
  video.muted = true;
  video.style.display = "none";
  document.body.appendChild(video);
  const meta = await new Promise<{ duration: number; videoWidth: number; videoHeight: number }>((resolve) => {
    video.onloadedmetadata = () => resolve({ duration: video.duration, videoWidth: video.videoWidth, videoHeight: video.videoHeight });
    video.onerror = () => {
      console.warn(`[io] 探测视频失败: ${name}`);
      resolve({ duration: 5, videoWidth: 1920, videoHeight: 1080 });
    };
    video.src = url;
  });
  document.body.removeChild(video);

  const media = actions.addMedia({
    kind: "video",
    name,
    url,
    duration: meta.duration,
    width: meta.videoWidth,
    height: meta.videoHeight,
  });
  mediaFiles.set(media.id, file);
  actions.setMediaPath(media.id, opts.path);
  const clip = actions.addMediaClip(media.id, getState().t);
  if (!clip) console.warn(`[io] addMediaClip 返回 null, mediaId: ${media.id}`);
  return media.id;
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

    // 和打开 .proc 同一套换算(parseProc 也调它),规则只有一份
    const restored = restoreMediaUrls(project.media || []);
    for (const m of restored.missing) console.warn(`[io] 缺失素材: ${m.name} (${m.url})`);
    project.media = restored.media;

    actions.loadProject(project, file.name);
    // 换项目就要清掉 AI 状态。打开 .proc 走 applyProjectAi、新建走 resetProjectAi,
    // 而「导入旧格式」这条路以前两个都没走 —— 后端那把会话 id 留着,重现 81f255b。
    // 区别是它连可见对话也没清,所以症状是看得见的,危害低一档,但一样得清。
    resetProjectAi();
    return project;
  } else if (json.cards && Array.isArray(json.cards)) {
    const p = createEmptyProject(file.name.replace(/\.[^/.]+$/, ""));
    actions.loadProject(p, file.name);
    resetProjectAi();
    
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

/** 时间码转秒:00:01:02,500 / 00:01:02.500 / 01:02,500(小时可省) */
function parseTimecode(raw: string): number | null {
  const m = raw.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})$/);
  if (!m) return null;
  const [, h, mm, ss, ms] = m;
  return (h ? Number(h) * 3600 : 0) + Number(mm) * 60 + Number(ss) + Number(ms.padEnd(3, "0")) / 1000;
}

/**
 * 解析 SRT(顺带兼容 WebVTT)。宽松处理:BOM、CRLF、可省的序号行、WEBVTT 头、
 * 结束时间后面的 cue 设置、<i> 和 {\an8} 这类标记都能吃掉。解析不出来的块跳过,不抛错。
 */
export function parseSrt(text: string): TranscriptSegment[] {
  const clean = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const segments: TranscriptSegment[] = [];

  for (const block of clean.split(/\n{2,}/)) {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) continue;
    if (/^WEBVTT/i.test(lines[0])) lines.shift();

    // 序号行可有可无
    let i = 0;
    if (/^\d+$/.test(lines[i] ?? "") && (lines[i + 1] ?? "").includes("-->")) i += 1;

    const timeLine = lines[i];
    if (!timeLine || !timeLine.includes("-->")) continue;
    const [rawStart, rawEnd] = timeLine.split("-->");
    const start = parseTimecode(rawStart ?? "");
    // WebVTT 的结束时间后面可能跟 align / position 之类的设置,只取第一段
    const end = parseTimecode((rawEnd ?? "").trim().split(/\s+/)[0] ?? "");
    if (start === null || end === null || end <= start) continue;

    const body = lines
      .slice(i + 1)
      .join("\n")
      .replace(/<[^>]+>/g, "")
      .replace(/\{[^}]*\}/g, "")
      .trim();
    if (!body) continue;

    segments.push({ start, end, text: body });
  }

  return segments.sort((a, b) => a.start - b.start);
}

/**
 * 导入 .srt / .vtt,挂到某条素材上当它的字幕稿(结构和语音转文字的结果一样,
 * 所以「素材 → 字幕」分页和 autoWorkflow 的字幕卡都能直接用)。
 * 不给 mediaId 就挂到第一条素材;一条素材都没有时报错——字幕的时间轴是相对素材的。
 */
export async function importSrtFile(
  file: File,
  opts: { mediaId?: string } = {},
): Promise<{ mediaId: string; count: number }> {
  const segments = parseSrt(await file.text());
  if (segments.length === 0) {
    throw new Error(`${file.name} 里没解析出字幕段,检查是不是 SRT / VTT 格式`);
  }
  const p = getState().project;
  const mediaId = opts.mediaId && p.media.some((m) => m.id === opts.mediaId) ? opts.mediaId : p.media[0]?.id;
  if (!mediaId) {
    throw new Error("还没有素材:先在「视频」分页导入视频,再导入它的字幕");
  }
  actions.setMediaTranscript(mediaId, {
    engine: "srt",
    model: file.name,
    createdAt: new Date().toISOString(),
    segments,
  });
  return { mediaId, count: segments.length };
}

/** 把当前项目序列化成 JSON 字符串(blob URL 换成相对路径) */
export function exportProjectJson(): string {
  const p = JSON.parse(JSON.stringify(getState().project)) as Project & { _note?: string };
  p._note = "这个文件只记录编排；素材按 media[].path 在服务端素材目录里找回（/@media/<文件名>）。没有 path 的素材只记了文件名，重新打开后要用「导入视频」重新导入同名素材。";

  for (const m of p.media) {
    if (m.url.startsWith("blob:")) {
      // blob: 只在这个页面活着。有 path 就写成服务端地址,重新打开、导出、截图都能直接取到
      const served = mediaUrlFromPath(m.path);
      if (served) {
        m.url = served;
        continue;
      }
      // 派生出来的「声音」素材和源视频指着同一个文件,但它自己没登记过 File —— 回头找源素材的
      const file = mediaFiles.get(m.id) ?? (m.soundOf ? mediaFiles.get(m.soundOf) : undefined);
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
export async function exportVideo(
  opts: {
    onProgress?: (done: number, total: number) => void;
    /** 拿到任务 id 就能取消了,所以在开跑那一刻先回给调用方 */
    onStart?: (id: string) => void;
  } = {},
): Promise<{ outDir: string; id: string }> {
  const p = JSON.parse(JSON.stringify(getState().project)) as Project;
  
  for (const m of p.media) {
    if (m.url.startsWith("blob:")) {
      // 同上:派生的「声音」素材没有自己的 File,借源视频那份(两者本来就是同一个文件)
      const file = mediaFiles.get(m.id) ?? (m.soundOf ? mediaFiles.get(m.soundOf) : undefined);
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
  opts.onStart?.(id);

  return new Promise((resolve, reject) => {
    const es = new EventSource(`/api/export/${id}?sse=1`);
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      es.close();
      fn();
    };
    es.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.status === "running") {
        opts.onProgress?.(data.done, data.total);
      } else if (data.status === "done") {
        finish(() => {
          opts.onProgress?.(data.total, data.total);
          resolve({ outDir, id });
        });
      } else if (data.status === "cancelled") {
        finish(() => reject(Object.assign(new Error("已取消导出"), { cancelled: true })));
      } else if (data.status === "error") {
        finish(() => reject(new Error(data.message || "导出错误")));
      }
    };
    es.onerror = () => {
      finish(() => reject(new Error("和导出进程的连接断了,导出可能仍在后台进行")));
    };
  });
}

/** 中止一次导出。渲染进程和它拉起的 Chrome / ffmpeg 都会被结束。 */
export async function cancelExport(id: string): Promise<void> {
  await fetch(`/api/export/${id}`, { method: "DELETE" }).catch(() => {});
}

/** 在文件管理器里打开这次导出的产物目录 */
export async function revealExport(id: string): Promise<void> {
  await fetch(`/api/export/${id}/reveal`, { method: "POST" });
}

/** 取回某个产物(preview.mp4 / overlay.mov),用来写进用户选的位置 */
export async function fetchExportFile(id: string, name: string): Promise<Blob> {
  const r = await fetch(`/api/export/${id}/file/${encodeURIComponent(name)}`);
  if (!r.ok) throw new Error(`取不到 ${name}:${await r.text()}`);
  return r.blob();
}

declare global {
  interface Window {
    __pcIo?: Record<string, unknown>;
  }
}

if (typeof window !== "undefined") {
  // 临时验证出口：puppeteer 无头验证时直接调用这四个函数（不用模拟 <input type=file>）。
  window.__pcIo = { importVideoFiles, importProjectFile, importSrtFile, parseSrt, exportProjectJson, exportVideo, setMediaTranscript: (mediaId: string, transcript: any) => actions.setMediaTranscript(mediaId, transcript) };
}
