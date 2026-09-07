import type { MediaAsset } from "../../kernel/project";
import { actions } from "../../store/project";
import { importVideoFiles, registerMediaFile } from "../io";

export type AssetKind = MediaAsset["kind"];

/**
 * 「导入素材」用的通用导入:用户选什么就收什么,按内容类型分别登记成 video / audio / image 素材,
 * 让它们各自落到素材库对应的分页里。
 *
 * 视频那一路直接复用 io 里的 importVideoFiles —— 它除了登记素材还会把 File 存进 io 的私有表
 * (导出和语音转写靠 getMediaFile 取原文件)、并把片段放到播放头处,自己另写一套只会和它走岔。
 * 音频和图片在 io 里没有对应入口(importVideoFiles 的 kind 是写死的 "video"),所以在这里登记,
 * 但**登记完必须调 registerMediaFile 把原始 File 交回 io** —— 语音转写和导出都靠
 * io.getMediaFile 取原文件,漏了这一步,导入的 mp3 转写时会报「素材文件不在内存里」,
 * 而上传失败退回 blob: 的素材导出时会被直接清空。两处都不会提示是导入漏登记造成的。
 */

/** 认不出 MIME 时按后缀兜底:系统对冷门容器(mkv / heic / opus 等)常常给空 type */
const EXT_KIND: Record<string, AssetKind> = {
  mp4: "video", m4v: "video", mov: "video", webm: "video", mkv: "video", avi: "video",
  wmv: "video", flv: "video", mpg: "video", mpeg: "video", ts: "video", m2ts: "video",
  "3gp": "video", ogv: "video",

  mp3: "audio", wav: "audio", aac: "audio", m4a: "audio", flac: "audio", ogg: "audio",
  oga: "audio", opus: "audio", wma: "audio", aiff: "audio", aif: "audio",

  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", bmp: "image",
  tif: "image", tiff: "image", avif: "image", heic: "image", heif: "image", svg: "image",
};

/** 文件选择器的 accept:MIME 通配打头,再补一串后缀,免得系统不认 MIME 时把文件灰掉 */
export const MEDIA_ACCEPT = [
  "video/*",
  "audio/*",
  "image/*",
  ...Object.keys(EXT_KIND).map((ext) => `.${ext}`),
].join(",");

export function classifyFile(file: File): AssetKind | null {
  const type = file.type.toLowerCase();
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  if (type.startsWith("image/")) return "image";
  const ext = file.name.toLowerCase().split(".").pop() ?? "";
  return EXT_KIND[ext] ?? null;
}

export const KIND_LABEL: Record<AssetKind, string> = { video: "视频", audio: "配乐", image: "图像" };

/** 探测元数据都给 5 秒上限:坏文件不该把整批导入卡死,拿不到就留空,后面按默认时长处理 */
function withTimeout<T>(run: (settle: (v: T) => void) => void, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    let done = false;
    const settle = (v: T) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => settle(fallback), 5000);
    run(settle);
  });
}

function probeAudio(url: string, name: string): Promise<{ duration?: number }> {
  return withTimeout<{ duration?: number }>((settle) => {
    const el = document.createElement("audio");
    el.preload = "metadata";
    el.onloadedmetadata = () => settle({ duration: Number.isFinite(el.duration) ? el.duration : undefined });
    el.onerror = () => {
      console.warn(`[left] 探测音频失败: ${name}`);
      settle({});
    };
    el.src = url;
  }, {});
}

function probeImage(url: string, name: string): Promise<{ width?: number; height?: number }> {
  return withTimeout<{ width?: number; height?: number }>((settle) => {
    const img = new Image();
    img.onload = () => settle({ width: img.naturalWidth || undefined, height: img.naturalHeight || undefined });
    img.onerror = () => {
      console.warn(`[left] 探测图片失败: ${name}`);
      settle({});
    };
    img.src = url;
  }, {});
}

/**
 * 登记一条音频 / 图片素材。
 *
 * 上传成功就直接拿 /@media/<文件名> 当素材地址,而不是留着 blob: ——
 * 渲染进程和导出进程都在浏览器之外,够不着 blob:,而 io 里那张「blob → File」的表是私有的,
 * 外面登记的素材进不去。走服务端地址就绕开了这条断路;上传失败(比如没起 dev server)再退回 blob:。
 */
async function registerAsset(file: File, kind: "audio" | "image"): Promise<string> {
  const blobUrl = URL.createObjectURL(file);
  const meta = kind === "audio" ? await probeAudio(blobUrl, file.name) : await probeImage(blobUrl, file.name);

  let url = blobUrl;
  let path: string | undefined;
  try {
    const res = await fetch(`/api/media/upload/${encodeURIComponent(file.name)}`, { method: "POST", body: file });
    if (res.ok) {
      const data = await res.json();
      if (data?.ok && data.url) {
        url = data.url as string;
        path = data.path as string | undefined;
      }
    } else {
      console.warn(`[left] 上传素材失败: ${file.name}`);
    }
  } catch (err) {
    console.warn(`[left] 上传素材异常: ${file.name}`, err);
  }
  if (url !== blobUrl) URL.revokeObjectURL(blobUrl);

  const media = actions.addMedia({
    kind,
    name: file.name,
    url,
    path,
    duration: (meta as { duration?: number }).duration,
    width: (meta as { width?: number }).width,
    height: (meta as { height?: number }).height,
  });
  registerMediaFile(media.id, file);
  return media.id;
}

export interface ImportResult {
  counts: Record<AssetKind, number>;
  /** 认不出类型、被跳过的文件名 */
  skipped: string[];
  /** 第一个收下的文件属于哪一类,用来把用户带到对应分页 */
  firstKind: AssetKind | null;
}

export async function importMediaFiles(files: FileList | File[]): Promise<ImportResult> {
  const counts: Record<AssetKind, number> = { video: 0, audio: 0, image: 0 };
  const skipped: string[] = [];
  let firstKind: AssetKind | null = null;

  const videos: File[] = [];
  const rest: { file: File; kind: "audio" | "image" }[] = [];
  for (const file of Array.from(files)) {
    const kind = classifyFile(file);
    if (!kind) {
      skipped.push(file.name);
      continue;
    }
    if (!firstKind) firstKind = kind;
    if (kind === "video") videos.push(file);
    else rest.push({ file, kind });
  }

  if (videos.length > 0) {
    counts.video = (await importVideoFiles(videos)).length;
  }
  for (const { file, kind } of rest) {
    await registerAsset(file, kind);
    counts[kind] += 1;
  }

  return { counts, skipped, firstKind };
}
