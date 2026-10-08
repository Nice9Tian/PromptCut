# 音效素材、Agent 与参数面板实现报告

## 已实现
- 纯合成配方按块编码 PCM16 WAV；编辑器使用独立模块 Worker，取消立即终止 Worker，不在页面主线程等待密集块结束。没有新增播放引擎或 AudioContext。
- 复用现有 `createSnapUploader` 的素材服务 media 分片协议；本地与远程写票据路径共用 `uploadGeneratedAudio`，上传确认后才原子登记素材并新增/替换普通音频片段。
- `MediaAsset.soundEffect` 与 `TrackClip.soundEffect` 保存完整配方，后者另存请求身份与可选打字来源。复用键是规范配方的 SHA-256，与 WAV 内容哈希分开；项目中没有生成临时文件、blob URL 或绝对路径。
- `sound_presets`、`sound_generate`、`sound_status`、`sound_cancel` 走现有 page 工具路由。Agent 生成调用等待原子提交结束，保持工具操作归属；状态查询不传任务号时列当前项目任务。重试要求相同 requestId。
- 参数面板提供提示音生成、打字卡键盘声/结尾提示音、声音参数与种子草稿、显式重生成、更新文字/节奏、进度和取消。草稿不原地修改项目。
- 取消、上传失败、项目切换/重开、目标编辑、过时任务均不能覆盖旧声音。完成任务复用时检查当前素材引用，覆盖撤销后重新添加以及 A→B→A→B 重生成。
- 独立声音的分割/裁切沿用 canonical mediaOffset；带来源的 WAV 随视觉片段整体移动、裁切和切分。含转场锁与同序列结尾提示音时也整体检查碰撞，不移动声音到错误起点。
- 通知参数变化重建音列事件与时长；未手动裁切的重生成片段延长至新的自然尾音，受来源片段与项目出点限制。原视觉片段删除后可从持久配方重生成声音。
- 给后续声画同片段实现增加可选 `TrackClip.cardAudio` 类型引用，并抽出共用 WAV 上传入口；声画卡本体与播放消费由另一个分支实现。

## 资源与协作边界
- 同时运行 1 个任务，最多 4 个未完成任务，保留最近 8 个终态记录；终态释放配方与编辑器闭包。
- 核心合成上限由 core 分支提供：60 秒、10000 个事件、最多 64 个同时发声事件与 voice-frame 工作预算。
- 持久流程另限完整配方 96 KiB，超过明确要求拆段；原子项目 diff 必须小于 224 KiB，拒绝根替换，防止共享项目大操作覆盖别人并发修改。这不是核心合成的事件上限。
- 普通浏览器与桌面预览/导出都读取同一个持久 WAV。没有给独立 WAV 片段再挂音频图节点。

## 验证证据
- `npx tsc -b --force`：多次退出 0，最近一次包含 Worker、Agent 异步归属修复、AV 产物类型和状态查询。
- `node --test src/editor/io/soundGeneration.test.mjs src/store/actions/sound.test.mjs src/audio/soundGeneration.test.mjs src/audio/soundGenerationWorkerClient.test.mjs`：24 项通过；随后补充近预算并发 rename 用例，单独再测通过。覆盖真实编辑器入口与素材分片协议假件、WAV 格式、不可变写入、配方往返、重开、失败、取消、过时结果、重复请求、通知音列、打字速度更新、孤儿配方、时间轴边界与 Worker 终止。
- `node --test src/store/actions/sound.test.mjs server/test/mcp-routes.test.mjs server/test/m7-uploader.test.mjs`：22 项通过，包括真实素材服务上传器回归与 600 字近预算配方的并发项目改名测试。
- `node --test src/layering.test.mjs src/store/importGraph.test.mjs server/test/mcp-routes.test.mjs`：13 项通过。
- `npx vite build --outDir /tmp/promptcut-sound-flow-build`：退出 0，构建产物包含独立 soundGenerationWorker JS；只有现有大包、直接 eval、静态/动态混用导入警告。
- `npm test`：原始命令出现 7 项失败后停止推进约 13 分钟，已中断，退出 130。没有得到全量通过结果。
- 完整测试清单的受控诊断重跑（`node --experimental-test-module-mocks --test-global-setup=server/test/global-setup.mjs --test --test-concurrency=4 --test-timeout=60000` 加原始三组文件 glob）：4288 项，4192 通过、89 失败、7 跳过，耗时 194.6 秒，退出 1。其中一项是新工具未列入 timeout 白名单，已修正并重跑该文件 21/21 通过。其它 88 项分布在原有服务端设备枚举、网络、Chrome、FFmpeg、CLI 与宿主配置相关测试；没有用纯基线逐项证明原因，不把它们统一判成环境豁免。全部 src 测试无失败。
- 最终统一专项命令：`node --experimental-test-module-mocks --test src/editor/io/generatedAudioUpload.test.mjs src/editor/io/soundGeneration.test.mjs src/store/actions/sound.test.mjs src/audio/soundGeneration.test.mjs src/audio/soundGenerationWorkerClient.test.mjs src/layering.test.mjs src/store/importGraph.test.mjs server/test/mcp-routes.test.mjs server/test/tool-schema.test.mjs server/test/m7-uploader.test.mjs`，66/66 通过、无跳过；随后再次 `npx tsc -b --force` 与 Vite 生产构建均退出 0。

## 未测与限制
- 本分支未完成人工试听、编辑器截图或真实浏览器 Worker 性能测量；Worker 单测使用浏览器接口假件，只证明终止和迟到结果契约。
- Windows 桌面、目标在线浏览器和 Linux 实际浏览器的预览/导出验证由 QA 分支负责；不把 Node WAV 测试冒称跨平台验证。
- sourceOffset 的视觉输入接线、核心音效原生卡、打字视觉组件属于其它分支；本分支独立测试不声称覆盖那些集成行为。
- 没有正式语义文档修改、merge 或 push。

## 提交
- 起始报告：03326b9。
- 主实现：1b775fc、3ba982e。
- 后续边界修复：676cad5（在线写票据测试）、686490d（保留自定义 frames/事件）、31eae71（保留新参数草稿）、96b230f（超时白名单）。
- 审查修复与测试：ae7badf、3a97523。
- AV 类型接线：6940f74（依赖 AV 合同 78a47a2，在此分支为 dcd9377）。
- 核心依赖：871198f、d456047、a773397、f15f7cf，在此分支对应 020fbbc、be18477、f071e62、d0574c0。
