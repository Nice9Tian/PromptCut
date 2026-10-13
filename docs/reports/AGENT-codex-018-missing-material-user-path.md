# 018 missing material user path — Luna 实施记录

## 本阶段边界

本阶段只消费项目内明确标记为 `confirmed-missing` 的素材状态，接入编辑器预览、浏览器导出与服务器逐帧素材合成。它不会把临时下载失败、无权限、坏解码或任意 HTTP 错误标成缺失，也不实现旧文件恢复证明的生产者。原素材对象、哈希、URL、名称、片段编排与恢复关联保持可用；软件内置 `missing-material.wav` 不写入项目文件或上传素材服务。

## 当前检查

- 开工基线：`ad9c640f8b26d6595fdd0b770c8c5777d1c193f0`，分支 `codex/018-missing-material-user-path`。
- 开工工作树干净；开工前已只读查阅开发指南、素材/缺失语义、账号绑定任务书与契约、018 设计及对应预览/音频/渲染入口。
- 已确认实现接缝：普通素材预览在 `src/render/VideoTrack.tsx`，非 live/export 帧场景在 `src/render/FrameScene.tsx`；编辑器声音在 `src/editor/preview/MediaLayers.tsx`；浏览器导出声音计划在 `src/export/browserExport.ts` 经 `src/audio/renderMix.ts`；服务器逐帧素材规划在 `server/bakery/media.mjs` 的 `planMedia()`，随后由 ffmpeg 合成。新增共享视觉/音频 adapter，不改 `src/kernel/audioPlan.mjs` 的通用计划规则。

## 已实施接线

- `MediaAsset.missingMaterial` 保存可序列化的确认记录及原素材身份；`src/audio/missingMaterial.ts` 与 `src/editor/io/missingMaterials.ts` 校验记录与素材 ID/类型一致后才启用代理。这里没有新增“自动探测并确认缺失”的生产者。
- 预览 `VideoTrack`、非 live `FrameScene` 和浏览器导出都消费同一确认状态。预览文字卡保留原片段位置、滤镜和透明度；视频/图片声音进入同一音频适配，图片不发声，视频 `soundOf` 分离引用从原视频确认状态推导一次。内置 WAV 始终从固定软件资源读取，片段从 0 秒播放一次并受片长裁切；已有 gain、fade 和效果配置继续沿原链路处理。
- Bakery 的 `planMedia()` 仅在结构匹配的显式确认记录上跳过原媒体 URL。FFmpeg 合成在原框中画文字代理，并沿用片段时间、布局、滤镜、淡化和图层顺序。缺失文字代理仅从 Windows Fonts 的微软雅黑/黑体/宋体候选或部署 Noto Sans CJK 候选解析字体；不使用项目路径或素材名作为字体文件。没有字体时显式报资源错误，不会无声跳过代理。
- Windows 上以真实 FFmpeg 9 合成 30 帧测试片，并从成片抽出 PNG 检查。实际文件名为 `场景:访谈(一)'试剪.mp4`；截图里“找不到素材”及完整文件名正常显示，冒号、括号和单引号没有打断滤镜。原始无字体 FFmpeg 失败记录保留在 `%TEMP%\pc-missing-compose-5dtuvm`（Fontconfig 无默认配置）；修复后的合成结果和截图保留在 `%TEMP%\pc-missing-compose-font-ZQsSpP`。

## 验证与限制

- `npm test -- src/editor/io/missingMaterials.test.mjs src/audio/missingMaterial.test.mjs src/editor/preview/missingMaterials.test.mjs src/render/MissingMaterial.test.mjs src/export/browserExport.missing.test.mjs server/test/bakery-missing-media.test.mjs server/test/export-compose.test.mjs server/bakery/mux-audio.test.mjs server/bakery/audio-mix.test.mjs server/bakery/export-missing-font.test.mjs`：31 项通过，0 失败。首次较窄服务器目标运行有 1 项测试因新断言漏导入 `MISSING_MATERIAL_WAV` 而失败；补齐测试导入后按上述目标集复跑通过。
- `npm exec -- tsc -b --pretty false` 通过；`node --check` 覆盖服务器改动模块及字体测试；`git diff --check` 通过。
- 没有启动应用服务、浏览器或真实项目数据。真实 FFmpeg 仅使用临时合成帧、显式 `confirmed-missing` fixture 与本机已安装字体；没有验证真实旧项目恢复、缺失确认 producer、真实音视频文件恢复或 Linux 主机运行。普通素材行为由原计划分支保持，专项测试也验证普通音频源路径仍按旧规则计划。
- 最终差异仍需根会话整合检查；此工作树不合并、不推送。
