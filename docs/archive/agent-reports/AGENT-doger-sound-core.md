# 合成音效核心与共享打字事件

## 范围与结果

- 分支：`doger-sound-core`；独立 worktree；分配端口 5230–5239；没有推送或合并。
- 已实现纯 TypeScript 提示音与键盘声合成、完整可持久配方、可随机访问分块采样和共享字素事件。
- 新增原生无输入音频卡 `sound-notification`、`sound-keyboard`，均为 `kind: audio`、`inputs: {}`，有可查询控件、来源说明和使用建议。
- `mu-typing` 保持原默认文本、120 ms 节奏、样式与 stateful 审阅；新增可选延迟、标点/换行停顿、固定种子节奏抖动；不自动发声。舞台传入 `t + sourceOffset`，切分后不重新从第一个字开始。无舞台时间的独立预览仍沿 rAF 时钟。
- 未修改项目素材持久化、素材服务、Store、编辑 UI 或 Agent 工具；父任务的 `481c9b0`（sourceOffset 只读派生）作为依赖采用。

## 接口

`src/kernel/soundEffects.ts`：

- `createNotificationRecipe(params, options)` / `createTypingSoundRecipe(typing, params, options)`。
- `validateSoundEffectRecipe(recipe)`：拒绝未知版本、缺失完整参数/来源、畸形事件、超预算；不会用当下默认值补写不完整的持久快照。
- `renderSoundEffectBlock(recipe, { start, count, sampleRate? })`：交错 Float32、默认 48 kHz 双声道；可选单声道和列出的采样率；负起点与素材结束之后补零；不同采样率请求明确报错。
- `soundEffectReuseKey(recipe)`：规范序列化的完整配方身份，包含版本、参数、种子、事件、格式、帧数和文字来源；与 WAV 字节内容哈希不同。

`src/kernel/typingEvents.ts`：

- `createTypingSchedule`、`typingTextAt`、`typingScheduleOptionsFromParams`，音画共用。
- Unicode extended grapheme：中文、组合附加符、旗帜、肤色/ZWJ emoji、CRLF 不按 UTF-16 半字切开。
- 默认首字在一个间隔后出现；标点发声，空格/换行静音。停顿作用于该字之后，可显式设置按字暂停。
- 声音配方保存实际事件及来源。视觉仍从当前文本经 `Intl.Segmenter` 计算；不同 Unicode 引擎版本对未来新字素的分段差异未宣称消除，后续可增加显式共享已存事件的版本迁移。

## 确定性与资源边界

- 每个采样只由版本、参数、种子、稳定事件身份、事件内采样序号决定。噪声使用按索引散列及有限脉冲响应滤波，无顺序 RNG 或跨块滤波状态。
- 自然尾音末采样为零；显式 `frames` 缩短只裁源采样，不改写源波形，片段淡入淡出仍交已有混音器。
- 合成器按整份配方的最大重叠数预留线性余量，单配方峰值不超过 0.8，不用硬削波掩盖过载。多个不同素材混合仍受既有混音器规则约束。
- 显式预算：最长 60 秒；最多 10000 事件；同时最多 64 声部；总声部采样运算不超过 32000000；核心单块最多 65536 帧。超限报错并建议减小密度/拆分，不截断。
- 原生 `CardDef.audio` 支持宿主最多 1048576 帧的请求，内部每 4096 帧让出一次事件循环；返回 Promise，符合既有 CardDef 契约。调度计时器不进入采样公式。
- 64 声部密集敲击、4096 帧块的实测：冷运行 43.35 ms，后四次 32.54 / 29.47 / 28.96 / 32.76 ms。只是本次云端测量，不当作用户笔记本性能验收。

## 验证证据

- 类型检查：`node ../../node_modules/typescript/bin/tsc -b --force`，退出 0。
- 专项：`node --test src/kernel/soundEffects.test.mjs src/kernel/typingEvents.test.mjs src/cards/native/sound-effects.test.mjs src/cards/magicui/typing-animation.test.mjs`，20/20 通过。
- 覆盖：提示音三种音色、键盘两种音色；整段/异长分块/倒序/非零起点/重播逐采样完全相同；尾音、裁切补零、线性增益、种子与版本/参数失效、峰值/有限值、所有资源预算、完整配方 JSON 回读、异常持久快照拒绝、ASCII 默认边界、CJK/emoji/换行、停顿、音画量化误差 ≤0.5 采样、原生音频卡输入/声道/大块、源码闭包失效、实际 React SSR 随机访问与裁切。
- 全量 `npm test` 已多次执行，仍未全绿。原默认环境：4265 用例，4170 通过、88 失败、7 跳过。隔离可写 HOME 后：4266 用例，4174 通过、85 失败、7 跳过。增加重叠预算后的运行：4267 用例，4174 通过、86 失败、7 跳过。失败集中在既有网卡枚举、独立子进程/托管服务、UDP 发现、外部编码与沙箱工具；没有音效/打字专项失败。父任务需对照未修改基线确认环境差异。
- 最后代码提交 `f15f7cf` 的全量测试：初跑 4263 用例、4169 通过、87 失败、7 跳过（约 119 秒）。在线构建测试子进程曾 SIGKILL，原测试包装器自动独立重跑该文件，8/8 通过；其余既有失败仍在，最终退出 1。本次日志确认新增的完整配方快照校验用例与全部声音/打字测试通过。
- 导出确定性探针确实尝试：`PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium PC_CHROME_ARGS='--no-sandbox --disable-dev-shm-usage' node scripts/verify-determinism.mjs --url 'http://127.0.0.1:5230/?export=1' --frames 0-10`，退出 1；浏览器两次启动均在 ProcessSingleton 的 `socket()` 被运行环境以 EPERM 拒绝，尚未到页面渲染。没有声称通过像素基线或浏览器测试。

## 未通过、未测与待用户决定

- 全量基线与浏览器确定性未通过，不符合合入 main 的全绿条件。保留提交/分支，交父任务汇报，由用户决定后续。
- Windows 桌面、目标在线浏览器、真实设备人工试听、浏览器最终成片与笔记本性能未在本分支验证；独立 QA 负责更完整的素材/MP4 管线证据。
- 正式产品语义由主会话与用户确认后写入；本分支没有修改正式语义，也没有把草稿当成已通过的平台承诺。
