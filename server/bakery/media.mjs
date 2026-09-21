/**
 * 素材来源解析:页面按地址 fetch 的那些素材,ffmpeg 该去哪儿读,以及渲帧前的素材层规划。
 *
 * 从 scripts/export-frames.mjs 拆出来(纯重构,逐字搬运)。
 */

import path from 'path';
import fs from 'fs/promises';
import fsSync from 'node:fs';
import { execFileSync } from 'child_process';
import { clipFrameRange, composeLayers } from '../export-compose.mjs';
import { DEFAULT_URL } from './chrome.mjs';
import { ffprobeOf } from './ffmpeg.mjs';

const isInside = (file, dir) => {
  const rel = path.relative(dir, file);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};

/**
 * 素材在 ffmpeg 那边从哪儿读。页面是按 m.url 去 fetch 的,这里按同一个地址找:
 *   /@export/<id>/media/<文件> → <out>/media/<文件>(导出时浏览器上传的素材);
 *   /@media/<文件>、或 path 字段 → 素材目录里的文件(素材库);
 *   都不在本机就和页面一样走 HTTP 找 dev server 要(两处都支持 Range,ffmpeg 能 seek)。
 * 和 vite-plugin-vision 的 mediaFileOf 同一道边界:磁盘路径只认落在素材目录 / 产物目录里的,
 * HTTP 只认页面同源的 —— project.json 是浏览器发来的,不能让它指使 ffmpeg 读任意文件。
 */
export function mediaSourceOf(m, { outDir, pageUrl, mediaRoot }) {
  const url = String(m?.url || '');
  if (!url || /^(blob|data):/i.test(url)) return null;
  const exportMedia = path.resolve(outDir, 'media');
  const marker = url.lastIndexOf('/media/');
  if (url.startsWith('/@export/') && marker !== -1) {
    const f = path.join(exportMedia, decodeURIComponent(url.slice(marker + '/media/'.length).split('?')[0]));
    if (isInside(f, exportMedia) && fsSync.existsSync(f)) return f;
  }
  if (m.path) {
    const f = path.resolve(String(m.path));
    const roots = [mediaRoot, ...legacyMediaRoots()];
    if (roots.some((root) => isInside(f, root)) && fsSync.existsSync(f)) return f;
  }
  if (url.startsWith('/@media/')) {
    const f = path.join(mediaRoot, decodeURIComponent(url.slice('/@media/'.length).split('?')[0]));
    const roots = [mediaRoot, ...legacyMediaRoots()];
    if (roots.some((root) => isInside(f, root)) && fsSync.existsSync(f)) return f;
  }
  try {
    const u = new URL(url, pageUrl);
    if (u.origin === new URL(pageUrl).origin && /^https?:$/.test(u.protocol)) return u.href;
  } catch { /* 地址不合法 */ }
  return null;
}

/**
 * ffprobe 看一眼素材:有没有透明通道(决定强调算不算)、色彩空间(没标注的按 bt709 解,和 Chrome 一致)、
 * 要不要换解码器(带 alpha 的 VP8/VP9 用 ffmpeg 自带解码器会丢 alpha,得用 libvpx)。读不出来返回 null。
 */
function probeVisual(ffprobeCmd, src) {
  try {
    const out = execFileSync(ffprobeCmd, [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name,pix_fmt,color_space:stream_tags=alpha_mode', '-of', 'json', src,
    ], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    const s = JSON.parse(out).streams?.[0];
    if (!s) return null;
    const alphaTag = String(s.tags?.alpha_mode ?? s.tags?.ALPHA_MODE ?? '') === '1';
    const pix = String(s.pix_fmt || '');
    return {
      hasAlpha: alphaTag || /^(yuva|rgba|bgra|argb|abgr|gbrap|ya|pal8)/.test(pix),
      colorSpace: s.color_space || 'unknown',
      decoder: alphaTag ? ({ vp8: 'libvpx', vp9: 'libvpx-vp9' })[s.codec_name] : undefined,
    };
  } catch {
    return null;
  }
}

/** 素材库目录(/@media/<文件> 落在这里)。画面层和音轨都按它找素材 */
const mediaRootDir = () => path.resolve(process.env.PROMPTCUT_EXPORT_DIR || path.resolve('out'), 'media');
// Older .proc files keep absolute paths in %USERPROFILE%/Videos/PromptCut/media.
// Keep ffmpeg's lookup in sync with the browser media endpoint so legacy
// projects render the same footage they show in the editor.
function legacyMediaRoots() {
  const roots = [path.join(process.env.USERPROFILE || process.env.HOME || '', 'Videos', 'PromptCut', 'media')];
  if (process.env.PROMPTCUT_MEDIA_DIR) roots.push(path.resolve(process.env.PROMPTCUT_MEDIA_DIR));
  return roots.filter(Boolean);
}

/** 页面拿的是哪份项目,ffmpeg 就用哪份:按导出页地址里的 timeline 去取;取不到再看 <out>/project.json */
async function loadProject(url, outDir) {
  try {
    const u = new URL(url);
    const tl = u.searchParams.get('timeline');
    if (tl) {
      const r = await fetch(new URL(tl, u));
      if (r.ok) {
        const j = await r.json();
        if (j && Array.isArray(j.tracks)) return j;
      }
    }
  } catch (e) {
    console.warn('取项目失败,改读产物目录里的 project.json:', e.message);
  }
  const f = path.join(outDir, 'project.json');
  if (fsSync.existsSync(f)) {
    const j = JSON.parse(fsSync.readFileSync(f, 'utf8'));
    if (j && Array.isArray(j.tracks)) return j;
  }
  return null;
}

/**
 * 渲帧之前先把素材层规划好:每段素材从哪儿读、有没有 alpha,以及哪些帧底下有素材
 * (那些帧要截毛玻璃遮罩;底下没素材的帧,玻璃背后只有灰底,模不模糊都一样)。
 */
async function planMedia(opts, outDir, ffmpegCmd) {
  const url = opts.url || DEFAULT_URL;
  const project = await loadProject(url, outDir);
  if (!project) return null;
  const all = composeLayers(project);
  if (!all.length) return { project, layers: [], glassFrames: new Set() };
  const mediaRoot = mediaRootDir();
  const ffprobeCmd = ffprobeOf(ffmpegCmd);
  const probed = new Map();
  const layers = all.map((l) => {
    let src = mediaSourceOf(l.media, { outDir, pageUrl: url, mediaRoot });
    let info = null;
    if (src) {
      if (!probed.has(src)) probed.set(src, probeVisual(ffprobeCmd, src));
      info = probed.get(src);
      if (!info) {
        console.warn(`素材「${l.media.name || l.media.id}」ffprobe 读不出来(${src}),这一层没有画面`);
        src = null;
      }
    } else {
      console.warn(`素材「${l.media.name || l.media.id}」找不到文件(${l.media.url || '无地址'}),这一层没有画面`);
    }
    return { ...l, src, hasAlpha: !!info?.hasAlpha, colorSpace: info?.colorSpace, decoder: info?.decoder };
  });
  const fps = opts.fps || project.fps || 30;
  let [f0, f1] = [0, Math.floor((project.duration || 20) * fps) - 1];
  if (opts.frames) [f0, f1] = opts.frames.split('-').map(Number);
  const glassFrames = new Set();
  for (const l of layers) {
    if (!l.src) continue;
    const r = clipFrameRange(l.clip, fps, f0, f1);
    if (r) for (let i = r[0]; i <= r[1]; i++) glassFrames.add(i);
  }
  return { project, layers, glassFrames };
}

/** 遮罩序列要每帧都有一张(image2 输入不能缺号):没有玻璃的帧补一张全透明的 */
async function fillGlassGaps(dir, startFrame, endFrame, width, height) {
  const { PNG } = await import('pngjs');
  const empty = PNG.sync.write(new PNG({ width, height }));
  const writes = [];
  for (let i = startFrame; i <= endFrame; i++) {
    const f = path.join(dir, `${String(i).padStart(6, '0')}.png`);
    if (!fsSync.existsSync(f)) writes.push(fs.writeFile(f, empty));
  }
  await Promise.all(writes);
}

export { mediaRootDir, loadProject, planMedia, fillGlassGaps };
