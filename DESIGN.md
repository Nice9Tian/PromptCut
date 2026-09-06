# PromptCut 原型 · 契约

目标:验证「Motion 动画内核 + Chrome 虚拟时间渲染内核」能让第三方 React 动效(Magic UI)不改代码就逐帧确定导出。

## 目录

- `src/kernel/` 内核,**已写好,不要改接口**(可以修 bug,改了要在回报里说明)
  - `types.ts` 卡片契约 `CardDef`、时间轴 `Timeline` / `Clip`
  - `registry.ts` 注册表
  - `clock.ts` `clockNow()`:预览读 performance.now,导出读 `window.__pcExportMs`
  - `AnimClock.tsx` 每帧把容器内所有 Web Animations 的 playbackRate 拉到 `speed * window.__pcClockRate`
  - `Stage.tsx` 按当前时刻挑活跃 clip 挂载,key 含 playToken,进入区间即重新挂载从头播
- `src/cards/magicui/` Magic UI 适配卡(每卡一个文件,`index.ts` 汇总导出 `magicuiCards`)
- `src/cards/native/` 自家 Motion 卡(每卡一个文件,`index.ts` 汇总导出 `nativeCards`)
- `src/demo.ts` 演示时间轴 `demoTimeline`,预览和导出共用
- `src/ExportView.tsx` 导出视图(`?export=1`),暴露 `window.__pcSetT(sec)`、`window.__pcReady`
- `scripts/export-frames.mjs` 导出脚本;`scripts/verify-determinism.mjs` 导两遍比对

## 卡片怎么写

```tsx
import { motion } from "motion/react";
import type { CardDef, CardProps } from "../../kernel/types";

interface Params { text: string; accent: string }

function MyCard({ params }: CardProps<Params>) {
  // 动画用 motion/react 写(initial / animate / transition),或纯 CSS animation。
  // 组件挂载 = 播放开始。不要用 IntersectionObserver / useInView 触发
  // (舞台 1920x1080 在缩放容器里,视口判定不可靠)。
  // Magic UI 组件若自带 useInView,给它传相关 props 让它立即播。
  return (
    <div className="absolute inset-0 grid place-items-center">
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} style={{ color: params.accent }}>
        {params.text}
      </motion.div>
    </div>
  );
}

export const myCard: CardDef<Params> = {
  id: "my-card", name: "我的卡", description: "…", source: "native",
  defaults: { text: "你好", accent: "#4f8cff" },
  controls: [{ key: "text", label: "文字", type: "text" }, { key: "accent", label: "主色", type: "color" }],
  Component: MyCard,
};
```

硬约束:

1. 卡片是 1920×1080 舞台上的绝对定位层,自己决定落在哪(居中 / 底部 / 左上等),背景透明。
2. 只依赖 `motion`、`react`、Tailwind、自己的 CSS。不要引入其他动画库(gsap 等)。
3. 动画只能靠 Motion / CSS animation / rAF 读 `performance.now()`。**不要读 `Date.now()`**,不要用 setTimeout 驱动画面(虚拟时间下顺序不保证)。
4. Magic UI 组件:从 GitHub `magicuidesign/magicui` 仓库(`registry/magicui/<name>.tsx`)把组件源码复制到 `src/cards/magicui/vendor/<name>.tsx`(文件头注明来源和 MIT),原样使用;适配器另写一个文件包 `CardDef`。组件用到的 `cn()` 在 `src/cards/magicui/vendor/cn.ts` 自己写简版:`(...a) => a.filter(Boolean).join(" ")`,不装 clsx / tailwind-merge。
5. 中文文案、深色背景下可读(舞台默认透明,预览是深色棋盘)。
6. 每张卡写完加进 `src/demo.ts` 的 clips(每张 2 秒顺序排,不要和别人的时段重叠:magicui 卡占 0–10 秒,native 卡占 10–20 秒),params 留空即用 defaults。

## 导出脚本契约(scripts/export-frames.mjs)

- 用 `puppeteer`(已装,Chrome for Testing 在 `%USERPROFILE%\.cache\puppeteer`)打开 `http://127.0.0.1:5190/?export=1`(dev server 由调用者先起,`npm run dev`),或 `--url` 指定。
- 视口 = timeline 宽高,`omitBackground` 透明 PNG。
- CDP `Emulation.setVirtualTimePolicy` 先 `pause`,等 `window.__pcReady`,然后每帧:`__pcSetT(i/fps)` → `setVirtualTimePolicy({policy:'pauseIfNetworkFetchesPending', budget: 1000/fps})` 等 `virtualTimeBudgetExpired` → 等一次 rAF → `page.screenshot`。
- 截图前 `await Promise.all([...document.images].map(i=>i.decode().catch(()=>{})))`,避免空白帧。
- 帧写到 `out/frames/%06d.png`,最后 ffmpeg(路径:`%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0.1-full_build\bin\ffmpeg.exe`,PATH 里有就直接用)合成 `out/overlay.mov`(prores_ks profile 4444 带 alpha)和 `out/preview.mp4`(叠在 #333 灰底上,给人看)。
- `--frames a-b` 只导一段;`--out <dir>` 指定输出目录;`--fps` 覆盖。
- `scripts/verify-determinism.mjs`:同一段导两遍到不同目录,逐帧比对 PNG 像素(可以装 `pngjs`),输出:相同帧数 / 不同帧数 / 最差帧的差异像素占比。目标:全部相同。

## 注意

- node 在 `C:\Program Files\nodejs`,新开的 shell 可能不在 PATH 里,要前置。
- 端口 5190 是这个项目的 dev server,别的项目在用 5177,不要碰。
