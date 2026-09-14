# 音频效果系统:预览和导出同一张 Web Audio 节点图

2026-09-12。视频滤镜(`kernel/filters.mjs`)做完之后,声音这边照同一个形状再做一套:效果是项目级的库,
片段引用它,参数可以随时间变,Agent 和界面走同一份工具。不同的是**两条管线都用 Web Audio**,不像视频那样
CSS 和 ffmpeg 各实现一遍再逐像素对齐。

## 起因

一份真实对话(对话诊断-20260911-142727)里 Agent 三轮都说「工具里没有调音量的地方」;补上 `set_clip_volume`
之后又有三个问题:音量最大只到 1、太轻的人声放不大;它听不见声音,只能凭经验写「配乐压到 0.3」——
实测那批素材配乐本身比配音响 10 LU,0.3 还是盖住人声;混音 `normalize=0` 叠加之后真峰值 +4.8 dBFS,削波。

## 先说几件和直觉相反的事

- **「最小响度」照字面取是个没意义的数。** 逐秒短期响度的最小值是 -120.7(开头 3 秒窗口没填满)。
  正确做法是 EBU R128 的 LRA:滤掉低于 -70 LUFS 和比整体低 20 LU 以上的点,再取第 10 / 95 百分位 ——
  ffmpeg ebur128 的 `LRA low / LRA high` 就是它,实测和自己算的分位数逐位一致(-15.5 / -8.2)。
- **Librosa / Pedalboard 都不用加。** Pedalboard 是 GPLv3,安装包只带 MIT / Apache / BSD 三种许可证;Librosa 是分析库
  不是效果库,依赖 41.9 MB 的 llvmlite。ffmpeg 已经有全部常见效果,但它进不了浏览器预览 —— 真正的问题是预览和导出一致。
- **Web Audio 能当导出引擎。** 实测(自带的 Chrome 152):OfflineAudioContext 同一输入渲两次逐样本相同;88.7 秒立体声
  过「高通 + 压缩 + 2 秒卷积 + 增益」0.82 秒;highpass 200 Hz 和 ffmpeg `highpass=w=0.707` 差 -91.8 dB。
  chrome-headless-shell(导出用的那个)里 OfflineAudioContext 一样能用。

## 结构

```
kernel/audioFx.mjs      种类、参数范围、表达式求值、混响脉冲响应(确定性)、预设      ← 纯 JS,node 能跑
kernel/audioPlan.mjs    时间轴上谁在什么时候出声、多响(导出 / 测响度共用)
src/audio/fxChain.ts    一步 → Web Audio 节点;整条链 + 随时间改参数                  ← 预览和导出共用
src/audio/previewAudio.ts   预览:<video>/<audio> 第一次需要效果时接进 AudioContext(createMediaElementSource)
src/audio/renderMix.ts      导出:OfflineAudioContext 按位置 / 音量 / 淡入淡出 / 效果渲成 wav
src/AudioMixView.tsx        ?audioMix=1 页面:读 plan.json → renderMix → POST /api/export/audio-mix/<id>
scripts/export-frames.mjs   mixAudioInChrome:ffmpeg 裁每段用到的那一截 → 开混音页 → mix.wav 合进 preview.mp4;
                            失败退回 scripts/mux-audio.mjs 的 ffmpeg 滤镜图(没有效果);--audio ffmpeg 强制走老路
server/vite-plugin-audio.ts POST /api/audio/measure:ffmpeg ebur128 测素材 / 片段 / 整条时间轴
src/editor/right/audioFxTools.ts   list / create / update / remove / apply_audio_fx 的校验和门槛(Agent 和界面共用)
src/editor/left/library/audioFxGroups.tsx  左栏「特效」里的「音频效果 / 音频预设」两组;ClipAudioFxForm.tsx 编辑分区里素材段的效果栏
```

效果种类:gain(能超过 0 dB)、highpass、lowpass、peaking、lowshelf、highshelf、compressor、limiter、delay、reverb、pan。
每步 `{ kind, <参数>: 数字 | 表达式 }`,表达式和滤镜同一套小语法(t / d / p + 自定义参数)。
混响是合成的脉冲响应(mulberry32 噪声 × 指数衰减,能量归一),同一个 decay、同一个采样率两边生成同一条尾巴
(预览的 AudioContext 跟设备走,常见 44.1 k;导出固定 48 k —— 采样率不同时尾巴统计上一样、逐样本不同)。
限幅器要把 DynamicsCompressor 的自动补偿增益抵消掉(`fxChain.ts` 的 compressorMakeupDb,实测和 Chrome 一致),
再减掉 ratio=20 留下的 -ceiling/20 dB 残差;它不是硬墙,热信号会高零点几 dB。

## 实测(东京 7 日项目,截到 24 秒,8 段出声)

| 路 | integrated | LRA | 峰值 | 备注 |
|---|---|---|---|---|
| ffmpeg 滤镜图(老路,`--audio ffmpeg`) | -11.5 LUFS | 9.4 LU | -0.4 dBFS | |
| Chrome 混音,没挂效果 | -11.5 LUFS | 9.5 LU | -0.4 dBFS | 逐秒短期响度和上一行差:平均 0.01、最大 0.10 dB |
| Chrome 混音,配乐挂 gain -12、配音挂「人声清晰」 | -12.8 LUFS | 12.5 LU | -0.4 dBFS | 效果生效 |

Chrome 渲 24 秒 8 段 0.1 秒;裁段(ffmpeg,4 并行)一两秒。
编辑台预览:灌入同一个项目、播到 1 秒处,`window.__pcPreviewAudio()` 报 routed 2 / withChain 2 / state running ——
正好是挂着效果的那两段,没挂的元素一个没碰。

## 已知边界

- 混响的 decay 不随时间变(换长度要重建脉冲响应),表达式里写了也按初值。
- 预览里跨域外链素材接不进 Web Audio(会静音),效果只在导出里生效,console 提示一次。
- `measure_audio` 测的是效果之前的原声(ffmpeg 在服务端跑);要看效果之后的数,导出后看 preview.mp4。
- 混音仍然 `normalize=0` 直接相加,叠太多会削波 —— 导出日志会报峰值,Agent 该挂 limiter 或压低音量。
- 老项目一个字段都不多:没挂效果的片段和以前一样直出元素,导出走同一条 Chrome 路但结果和 ffmpeg 路差 0.1 dB 以内。
