# 声画同片段卡片实现报告

## 任务与边界

按用户最新确认，动效卡片可同时产出画面与声音；同一片段共用参数与源时间。声音预渲染成持久 WAV，在线、重开和导出复用；缺失或过期明确失败。普通独立音效继续支持。卡片内声音不支持分离音轨，由集成分支实现明确失败与醒目静音提示。

本分支负责卡片契约、图适配、音频求值与持久化、播放和导出消费、回归测试。不推送、不写 main。工具登记、面板、静音/分离动作和正式语义文档由集成分支负责。

## 已实现

- `CardDef` 允许视觉 `Component` 或 `card()` 与 `audio()` 同时声明；`inputs: {}` 明确表示无需素材输入的纯合成。声画卡必须使用视觉类别；误用 `kind: audio` 在应用、添加、换卡、生成前明确拒绝，项目不发生部分写入。
- `kernel/cardAudioRendition.mjs` 提供统一识别、源码/参数/事件/上游输入身份与持久结果校验。`clip.embeddedAudio` 让没有卡片运行时的导出也能识别尚未生成的声音。
- `clip.cardAudio.mediaId` 引用正常音频素材库里的持久 WAV；原视觉片段不改成素材片段、不增加另一条时间轴声音、不双播。
- 两路共用源时钟。片段源位置来自 `mediaOffset`（缺省再用节点 `timeOffset`），两者不相加。WAV 的 `sourceOffset` 是该文件的生成区间起点，播放偏移用当前源位置减去它。旧 WAV 覆盖的裁切、切分、复制范围可继续复用。
- 图卡的默认 `at()` 显式保留源时间；自己的素材边只补偿一次源偏移，显式输入偏移不会被抹掉。纯音频图卡沿用旧路径。
- 生成复用现有 `audio()` 采样管线和素材服务分片上传，上传完成后一个不可变项目提交同时注册素材和关联片段。可一步撤销；切换/重开项目、修改片段或代码、后发请求、取消均阻止旧结果覆盖。
- 每次只执行一个任务，最多四项排队；生成范围最多 60 秒，按小块让出页面；身份记录在生成前限制大小，提交也检查共享文档差量预算。
- 本地和在线预览统一消费持久 WAV。参数、源码、事件、输入或范围失配会报错；真实音频元素的加载失败也会显示错误，不能把存在的 URL 当作解码成功。在线不执行用户声音源码。
- 在线同步给每张用户卡计算源码闭包版本，包括作为上游的纯音频卡。上游源码变化同样令结果过期。原始内置源码表由浏览器入口注入，不让纯同步/Node 模块依赖 Vite 宏。
- 浏览器和桌面导出经过同一音频计划，持久 WAV 只出现一次，片段和序列静音均受尊重。缺失/过期不会静默导出无声文件。
- 新增原生 `av-pulse` 声画提示脉冲示例，提示音复用现有确定性 TypeScript 合成，不给所有打字机卡强制加声。

## 验证证据

最终检查于 2026-10-05 执行：

1. `node ../../node_modules/typescript/bin/tsc -b --force`：退出码 0，输出 `AV_FINAL_TSC_OK`。
2. `node --experimental-test-module-mocks --test src/kernel/cardAudioRendition.test.mjs src/editor/io/cardAudioGeneration.test.mjs src/audio/cardAudio.test.mjs src/render/cards/audioSources.test.mjs src/render/cards/graphValues.test.mjs src/editor/sync/cardAudioSourceIdentity.test.mjs src/kernel/cardSourceParse.test.mjs src/editor/measureGate.test.mjs src/cards/native/sound-effects.test.mjs src/editor/onlineUserCards.test.mjs src/kernel/audioPlan.test.mjs src/kernel/cardAuthoring.test.mjs`：81 项通过、0 失败、0 跳过。
3. 回归涵盖真实 PCM 到 WAV、标准分片上传协议、同片段不双播、保存重开、撤销、裁切/切分、全部参数与源代码失效、上游纯音频卡的在线源码变化、虚拟节点缓存、取消/重开/旧请求晚到、任务上限、共享文档预算，以及错误类别声明的原子拒绝。
4. 已尝试 `npm test`，但长任务在输出前三项后执行会话被取消，无法取得完整测试汇总；不记为全量通过。集成分支与独立验证分支负责最终全量检查。
5. 浏览器启动/访问受执行环境限制，未获得真实浏览器画面、试听、导出确定性或快照重放通过证据；这些仍为待验证，Node 检查不代替它们。

## 集成时仍需核对

- 集成分支 `cc3b2a9` 将 `sourceOffset` 投影限定到打字机与声画卡，保持普通无声 DOM 卡的旧属性口径；本分支未重复编辑该处。
- 集成分支补齐工具/UI 登记及静音、分离动作。声画卡 DOM 的 `t` 已是源时间，作者不得再叠加 `sourceOffset`；旧无声打字机仍保留原契约。
- 集成分支继续补强复用前对素材服务 `chunks.complete` 的检查，解决元数据仍在但物理 WAV 已缺失时需要重生成的问题。

## 提交

初始报告 `0f815a6`；契约 `78a47a2`；图与时钟 `f5975ff`；完整管线 `a6b74a9`；回归与在线依赖边界 `8d4ed0a`；无效类型拒绝 `3ff4b45`；全部在线上游版本 `7588c15`。

期间复用独立音效分支已提交的上传器、项目类型与生命周期基础，没有建立第二套音频引擎。
