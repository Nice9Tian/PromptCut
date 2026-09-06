# 渲染内核脚本

## 用法

先起 dev server(任意端口),导出视图用 `proto.html?export=1`(原型独立入口)或 `/?export=1`。

```bash
node scripts/export-frames.mjs --url http://127.0.0.1:5188/proto.html?export=1 --frames 0-59 --out out/smoke --no-video
```

| 参数 | 说明 |
|---|---|
| `--url` | 导出视图地址。可带 `&timeline=/path.json` 指定时间轴(Timeline 或 Project 形状) |
| `--frames a-b` | 只落盘这一段;时间仍从第 0 帧顺序推进(卡片必须按序挂载) |
| `--out` | 输出目录,帧在 `<out>/frames/%06d.png` |
| `--fps` | 覆盖时间轴 fps |
| `--warm` | 预热帧数,默认 3 |
| `--no-video` | 跳过 ffmpeg 合成 |
| `PC_EXPORT_TRACE=1` | 每帧把页面时钟和全部动画状态记到 `<out>/trace.json`,排查确定性用 |
| `PC_EXPORT_VERBOSE=1` | 每帧打印进度 |

不带 `--no-video` 时用 ffmpeg 合成 `<out>/overlay.mov`(ProRes 4444 带 alpha)和 `<out>/preview.mp4`(叠在灰底上)。

```bash
node scripts/verify-determinism.mjs --url http://127.0.0.1:5188/proto.html?export=1 --frames 0-59
```

同一段导两遍到 `out/verify-a` / `out/verify-b`,逐像素比对,全部相同退出码 0。

## 确定性模型

每帧五步:`__pcSetT(sec)` → 推进一格虚拟时间 → `__pcSyncAnims()` → 等素材 → 截图。

1. **页面时钟量化**(`src/kernel/exportClock.ts`):导出视图里 `performance.now()` 和 rAF 时间戳都返回当前帧的导出毫秒。React 提交、rAF 回调落在虚拟时间那一格的哪个位置两次导出并不一样,量化后同一帧里读到的时间恒定。Motion 的 JS 动画、第三方 rAF 循环因此逐帧一致。
2. **Web Animations 钉时间**(`ExportView.tsx` 的 `__pcSyncAnims`):CSS / WAAPI 动画的钟和虚拟时钟不同步,也不靠实测比值校正(比值随机器负载变)。每帧把每个动画 `pause()` 后把 `currentTime` 设为「导出毫秒 − 该动画首次出现那一帧的导出毫秒」;越过结尾的 `finish()`。必须 pause:transform / opacity 跑在合成线程,只设 currentTime 的话截图那一帧合成器仍按自己的钟采样。
3. **rAF 等待在推进预算之前挂上**:预算耗尽后虚拟时间暂停,rAF 不会再回调,后挂会死锁。
4. **截图期间让虚拟时间流动**:虚拟时间暂停时,只要页面没有主线程侧的可见改动(空舞台、或卡片全是 Web Animations),Chrome 不会为截图出帧,`Page.captureScreenshot` 一直等。截图时切到 `advance`,截完切回 `pause`。此时动画已钉住、时钟已量化,这段时间画面不会变。
5. **软件光栅化**:GPU 光栅化在旋转/缩放的抗锯齿边缘上两次不完全一致(实测每帧差十几个像素、幅度 ≤ 8/255),加 `--disable-gpu` 等参数后逐像素相同。
6. **重挂载用 flushSync**:预热后 `__pcRestartCards` 同步重挂载全部卡片,第 0 帧的动画锚点才固定。

## 实测(2026-09-06,30fps,1920×1080)

| 段 | 内容 | 导两遍结果 |
|---|---|---|
| 0–59 | 探针卡(Motion JS 淡入平移、CSS 旋转、rAF 计数器)+ Magic UI 数字滚动 | 60/60 逐像素相同 |
| 60–119 | Magic UI 模糊浮现(第三方 Motion 组件,未改动画写法) | 60/60 相同 |
| 300–359 | 自家翻牌计数器(玻璃底、backdrop-filter),之前 0–10 秒五张 Magic UI 卡依次挂载卸载 | 60/60 相同 |

追踪数据(`trace.json`)里两遍的 `probeMs`、每个动画的 `currentTime` 完全一致。
