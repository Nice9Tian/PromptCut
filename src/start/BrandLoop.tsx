/**
 * 登录页左栏那块极光的**成品**：一段由 PromptCut 自己的渲染器预渲染出来的循环视频。
 *
 * 用户 2026-10-24 定：「左侧为渲染器经过预渲染的动画」「用视频循环」「可以出两个版本」。
 * 实测一个版本 512 宽、CRF 32 只有 ~520 KB，而页面只加载当前皮肤那一个，
 * 所以干脆**一套皮肤一个**（六个），预渲染唯一的代价——左栏不再跟着 `--ui-accent` 变——就补回来了。
 * 视频由 `scripts/login-art/render-all.mjs` 批量产出，源头是 `BrandCanvas.tsx` 里那同一段 GLSL
 * （经 `scripts/login-art/make-card.mjs` 生成的用户卡），所以这一版和兜底那一版画的是同一个东西。
 *
 * 循环为什么接得上：卡片里时间走的是一个闭合的圈（`uLoop` 0→1 走满回到起点），
 * 所以第 0 帧和第 N 帧算出来**逐字节相同**。2026-10-24 实测：把项目拉到 49 秒、
 * 单独导第 0 帧与第 1152 帧，两张 SHA-256 完全一致、逐字节零差异。
 *
 * 兜底：视频放不出来（解码不支持、文件取不到、自动播放被拦）就退回实时着色器 `BrandCanvas`，
 * 那一版自己还有一层 CSS 兜底（`BrandAurora`）。所以这一块任何时候都不会是一片空白。
 *
 * 「减少动态效果」：不自动播，停在第一帧——有图、不动。
 */
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { BrandCanvas } from "./BrandCanvas";
import { useSkin } from "../skins/useSkin";
import "./brandCanvas.css";

import studio from "./art/login-art-studio.mp4";
import steel from "./art/login-art-steel.mp4";
import graphite from "./art/login-art-graphite.mp4";
import indigo from "./art/login-art-indigo.mp4";
import terminal from "./art/login-art-terminal.mp4";
import clay from "./art/login-art-clay.mp4";

/** 调色盘 id → 那一套的循环视频。键和 `src/skins/palettes.ts` 里的 id 一一对应 */
const LOOPS: Record<string, string> = { studio, steel, graphite, indigo, terminal, clay };
const FALLBACK = studio;

/** `data-skin` 是「调色盘-深浅」，取前半截 */
const paletteOf = (skinId: string) => skinId.replace(/-(dark|light)$/, "");

export function BrandLoop(): JSX.Element {
  const { skinId } = useSkin();
  const [failed, setFailed] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const src = LOOPS[paletteOf(skinId)] ?? FALLBACK;

  useEffect(() => {
    const el = video.current;
    if (!el) return;
    const still = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (still) { el.pause(); return; }
    // 自动播放被拦（有些浏览器连静音视频也拦）不该让这一块变空：退回实时着色器
    void el.play().catch(() => setFailed(true));
  }, [src]);

  if (failed) return <BrandCanvas />;
  return (
    <video
      ref={video}
      className="ps-brand-loop"
      data-pc="start-brand-loop"
      src={src}
      loop
      muted
      playsInline
      preload="auto"
      aria-hidden="true"
      onError={() => setFailed(true)}
    />
  );
}
