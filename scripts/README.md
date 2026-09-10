# 渲染内核脚本

0.4 起导出后端是 chrome-headless-shell 的 `HeadlessExperimental.beginFrame`。为什么换、换了多少,见
`docs/render-rebuild-plan.md`;旧的 CDP 虚拟时间后端归档在 `scripts/archive/`(仍可单独运行,用来对账)。

## 用法

先起 dev server(任意端口),导出视图用 `/?export=1`(或原型入口 `proto.html?export=1`)。

```bash
node scripts/export-frames.mjs --url "http://127.0.0.1:5197/?export=1" --frames 0-59 --out out/smoke --no-video
```

| 参数 | 说明 |
|---|---|
| `--url` | 导出视图地址。可带 `&timeline=<url>` 指定时间轴(Timeline 或 Project 形状;data URL 也行) |
| `--frames a-b` | 只落盘这一段;时间仍从第 0 帧顺序推进(动画锚点、按 delta 积分的卡片、随机数流都依赖前面推过哪些帧) |
| `--target-frames a,b,c` | 只截这几帧(离散取样,给预烘用),一趟推过去沿途截 |
| `--out` | 输出目录,帧在 `<out>/frames/%06d.png` |
| `--fps` | 覆盖时间轴 fps |
| `--warm` | 预热帧数,默认 3 |
| `--format png\|jpeg` / `--quality` | 默认 PNG(带 alpha,optimizeForSpeed:仍无损,只是压得快、文件大) |
| `--static-skip` | 画面静止的帧复用上一张,每 10 帧强制真截一张比对 |
| `--dom-cache` | 同时把每帧舞台冻结成 HTML 存到 `<out>/dom/`,供 `replay-frames.mjs` 乱序重截 |
| `--workers N\|auto` | 分片并行,默认 1。每个分片仍从第 0 帧推起,输出和单进程逐字节相同,但提速有限(见下) |
| `--no-video` | 跳过 ffmpeg 合成 |
| `PC_EXPORT_TRACE=1` | 每帧把页面时钟和全部动画状态记到 `<out>/trace.json`,排查确定性用 |
| `PC_EXPORT_VERBOSE=1` | 每帧打印进度 |
| `PC_CHROME_ARGS="…"` | 追加 Chrome 启动参数(排查用) |

不带 `--no-video` 时用 ffmpeg 合成 `<out>/overlay.mov`(ProRes 4444 带 alpha)和 `<out>/preview.mp4`(叠在灰底上)。

找不到 chrome-headless-shell 时会自动装进 `PUPPETEER_CACHE_DIR`(桌面版 = `runtime/chrome`)再重试 ——
从 0.3.x 打补丁升上来的用户手里没有它(补丁只带 `runtime/app`)。

## 其他脚本

| 脚本 | 做什么 |
|---|---|
| `verify-determinism.mjs` | 同一段导两遍到 `out/verify-a` / `out/verify-b`,逐像素比对,全部相同退出码 0 |
| `replay-frames.mjs --cache <out>/dom --out <dir> [--frames a-b] [--shuffle]` | 从 HTML 采样缓存乱序重截,不需要从第 0 帧顺推 |
| `font-audit.mjs` | 查每个文本节点实际用到的字体,落进系统回退(白名单以外)就报出来 |
| `card-audit.mjs` | 逐张卡查位置无关、确定性、DOM 结构稳定、挂载时的网络请求、画面载体 |
| `archive/export-frames-virtual-time.mjs` | 旧后端,只留作对账 |

## 确定性模型(beginFrame 后端)

每帧:`__pcSetT(sec)` → 等网络 → 排空 → **beginFrame 推一拍** → 等网络 → 排空 → `__pcSyncAnims()` → 排空 → 等素材 → **beginFrame 截图**。

1. **页面时钟量化**(`src/kernel/exportClock.ts`):`performance.now()` 和 rAF 时间戳都返回当前帧的导出毫秒。beginFrame 的帧时间只要单调递增,画面不读它。
2. **随机数和墙上时钟钉死**(`src/kernel/pinEntropy.ts`,在所有 import 之前装):`Math.random` 带种子、`Date.now()` / `new Date()` = 固定纪元 + 当前帧毫秒、`crypto` 走同一个种子。第三方库在模块加载时抓走的随机源也罩得住(实测 lottie 的 wiggle / random 表达式导两遍从 89/90 帧不同变成 0)。
3. **Web Animations 钉时间**(`ExportView.tsx` 的 `__pcSyncAnims`):每帧把每个动画 `pause()`,`currentTime` 设为「导出毫秒 − 该动画首次出现那一帧的导出毫秒」;越过结尾的 `finish()`。
4. **等网络**:Network 域数在路上的请求,清零才推下一拍。缺了它,提前挂载那一帧动态 `import("three")` 还没回来,三维画面晚一帧(实测)。
5. **排空**:页面内 `setTimeout(0)` 直到 `__pcMutationCount` 不再变,React 经 Scheduler 排的提交在这里落地。
6. **软件光栅化**:GPU 光栅化在旋转/缩放的抗锯齿边缘上两次不完全一致,加 `--disable-gpu` 等参数后逐像素相同。
7. **字体不交给系统挑**:字体栈没覆盖到的字形,不同 Chrome 构建会选不同的回退字体(实测 ✓、等宽数字、等宽栈里的中文都中过)。主题字体栈显式列全,`font-audit.mjs` 零告警。
8. **重挂载用 flushSync**:预热后 `__pcRestartCards` 同步重挂载全部卡片,第 0 帧的动画锚点才固定。

## 实测(2026-09-10,30fps,1920×1080,i7-14700KF)

| 场景 | 结果 |
|---|---|
| demo 全长 1800 帧 | 旧后端 107.7 ms/帧 → 这里 26.9 ms/帧;自己连导两趟 1800/1800 相同 |
| demo 0~20 秒 + 粒子 + scene-3d,600 帧,新旧对账 | 587/600 相同;其余 13 帧是旧后端自己的偶发两态(它两趟之间也差这 13 帧) |
| 分片 1 / 4 / 8 个进程 | 54.8s / 44.8s / 62.4s,三者两两 1800/1800 相同 —— 推进省不掉、多个软件光栅化进程互抢 CPU |
| `--dom-cache` 300 帧 | 冻结约 +56 ms/帧,带粒子 / 三维画布时约 333 KB/帧(画布存成 PNG);乱序 vs 顺序重放 300/300 相同 |
| 重放 vs 实时截图 | 不是逐字节相同(边缘有细小残差,旋转元素最明显),所以同一次交付只走一条路 |
