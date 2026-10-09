# 018 missing material user path — Luna 实施记录

## 本阶段边界

本阶段只消费项目内明确标记为 `confirmed-missing` 的素材状态，接入编辑器预览、浏览器导出与服务器逐帧素材合成。它不会把临时下载失败、无权限、坏解码或任意 HTTP 错误标成缺失，也不实现旧文件恢复证明的生产者。原素材对象、哈希、URL、名称、片段编排与恢复关联保持可用；软件内置 `missing-material.wav` 不写入项目文件或上传素材服务。

## 当前检查

- 开工基线：`ad9c640f8b26d6595fdd0b770c8c5777d1c193f0`，分支 `codex/018-missing-material-user-path`。
- 开工工作树干净；开工前已只读查阅开发指南、素材/缺失语义、账号绑定任务书与契约、018 设计及对应预览/音频/渲染入口。
- 已确认实现接缝：普通素材预览在 `src/render/VideoTrack.tsx`，非 live/export 帧场景在 `src/render/FrameScene.tsx`；编辑器声音在 `src/editor/preview/MediaLayers.tsx`；浏览器导出声音计划在 `src/export/browserExport.ts` 经 `src/audio/renderMix.ts`；服务器逐帧素材规划在 `server/bakery/media.mjs` 的 `planMedia()`，随后由 ffmpeg 合成。新增共享视觉/音频 adapter，不改 `src/kernel/audioPlan.mjs` 的通用计划规则。

## 尚未实施

报告建立后将按已批准租约逐步接入，并记录实际修改、测试证据、未完成的旧文件恢复验证和任何范围缺口。不得将模块/fixture 测试描述成真实旧项目恢复验收。
