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
- `src/StageView.tsx` 预览渲染面(`?stage=1`),编辑器用 iframe 装着,暴露 `window.__pcStage`;
  时间由 `src/render/stageClock.ts` 接管(驱动式 rAF + `performance.now`),CSS/WAAPI 动画由
  `src/render/pinAnimations.ts` 钉住。预览显示的是「时间轴 t 那一帧」,不按墙上时钟自己播。
  时钟必须比 motion 先装,所以 `src/main.tsx` 第一行 import 的是 `./render/stageClockEntry`。
  详见 EDITOR-DESIGN.md「预览契约」
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

`CardProps` 还带两个可选字段:`t`(自 clip 起点起的秒数,舞台每帧传入)和 `duration`(clip 总时长)。绝大多数卡不读它们(挂载即播);只有跟着时间轴走的常驻卡(章节导航、字幕轨、口播视频 seek)才用,而且显示状态必须是 `t` 的纯函数,拖时间轴和导出才一致。

硬约束:

1. 卡片是 1920×1080 舞台上的绝对定位层,自己决定落在哪(居中 / 底部 / 左上等),背景透明。
2. 只依赖 `motion`、`react`、Tailwind、自己的 CSS。不要引入其他动画库(gsap 等)。
3. 动画只能靠 Motion / CSS animation / rAF 读 `performance.now()`。**不要读 `Date.now()`**,不要用 setTimeout 驱动画面(虚拟时间下顺序不保证)。
4. Magic UI 组件:从 GitHub `magicuidesign/magicui` 仓库(`registry/magicui/<name>.tsx`)把组件源码复制到 `src/cards/magicui/vendor/<name>.tsx`(文件头注明来源和 MIT),原样使用;适配器另写一个文件包 `CardDef`。组件用到的 `cn()` 在 `src/cards/magicui/vendor/cn.ts` 自己写简版:`(...a) => a.filter(Boolean).join(" ")`,不装 clsx / tailwind-merge。
5. 中文文案、深色背景下可读(舞台默认透明,预览是深色棋盘)。
6. 每张卡写完加进 `src/demo.ts` 的 clips(每张 2 秒顺序排,不要和别人的时段重叠:magicui 卡占 0–10 秒,native 卡占 10–20 秒),params 留空即用 defaults。

## 导出脚本契约(scripts/export-frames.mjs)

细节和实测数据见 `scripts/README.md`。要点:

- 页面侧(`src/ExportView.tsx`)暴露 `__pcReady`、`__pcTimeline`、`__pcSetT(sec)`、`__pcSyncAnims()`、`__pcResetAnims()`、`__pcRestartCards()`、`__pcFrameReady()`,类型声明在 `src/kernel/clock.ts`。
- 导出视图一进入就装 `installExportClock()`(`src/kernel/exportClock.ts`):`performance.now` 和 rAF 时间戳量化到当前帧的导出毫秒。随机数、墙上时钟、crypto 由 `src/kernel/pinEntropy.ts` 在所有 import 之前钉死(`render/stageClockEntry.ts`)。
- **0.4 起渲染后端是 chrome-headless-shell 的 `HeadlessExperimental.beginFrame`**(帧时间由脚本给),不再用 CDP 虚拟时间。每帧:`__pcSetT` → 等网络 → 排空 → beginFrame 推一拍 → 等网络 → 排空 → `__pcSyncAnims` 钉动画 → 排空 → 等图片 decode / 视频 seek → beginFrame 截图。旧的虚拟时间后端归档在 `scripts/archive/`。
- `AnimClock` 只在预览里做倍速;导出时不碰 playbackRate。
- Chrome 启动参数固定带软件光栅化(`--disable-gpu` 等)和 `--enable-begin-frame-control`。
- 字体:每个字形都要落在字体栈里显式写出的字体上(主题字体栈见 `src/themes/index.ts`),`scripts/font-audit.mjs` 检查。
- 页面只渲卡片的透明层(`?cardsOnly=1`),视频 / 图片素材不进 Chrome,由 ffmpeg 按预览同一套规则合进成片(`server/export-compose.mjs`)。
- 输出 `<out>/frames/%06d.png`(只有卡片),ffmpeg 合成 `overlay.mov`(ProRes 4444 alpha,只有卡片)和 `preview.mp4`(成片)。可选 `--dom-cache` 同时存每帧的 HTML 快照,供 `scripts/replay-frames.mjs` 乱序重截。
- `scripts/verify-determinism.mjs` 导两遍逐像素比对,目标全部相同。实测见 `scripts/README.md` 和 `docs/render-rebuild-plan.md`。

## 注意

- node 在 `C:\Program Files\nodejs`,新开的 shell 可能不在 PATH 里,要前置。
- 端口 5190 是这个项目的 dev server,别的项目在用 5177,不要碰。
