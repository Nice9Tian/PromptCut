# Python 自定义卡片管线：安装版验收记录

日期：2026-09-13。结论：自定义效果编写、实际看帧、保存重开已通过；真实项目播放仍未达标，因此完整交付验收未通过。已执行约定上限的五轮构建、静默安装和验收，没有开始第六轮。

## 本次交付

- 完整安装包：`desktop/release/PromptCut-0.5.9-setup.exe`，429,202,321 字节，约 409.3 MiB。
- 构建源码提交：`3d19f56ac669498a3ddabbd71d1479388fc32082`。
- 安装包 SHA256：`FAF04A462D607234FA1D6842E1DB75448A0C90ACBF6D74F52397F51394FF98F8`。
- 静默安装退出码 0；16 个关键运行文件匹配，桌面外壳通过 Tauri 安装元数据差异校验。
- 已安装到 `C:\Users\admin\AppData\Local\PromptCut`。验收结束后正常关闭了本次测试启动的应用。
- 本包是保留最终实现与复现条件的交付物，不能标记为已通过流畅播放验收的稳定版本。

## 已实现的路线

Python class 定义效果，统一采用 `card(source, time)` 和构造函数风格参数。支持不可变时间查询、时间区间、多输入、音频块，以及卡片定义和使用实例的分别保存。Agent 通过 `create_card`、`get_card_source`、`edit_card` 和 `apply_card` 传递及修改源码。

可注册的 GLSL 在浏览器 GPU 路径求值；任意 Python 算法通过实际隔离运行器执行，包含 NumPy/Pillow。没有假定所有 Python 都能自动编译成 GLSL。Rust 管理有容量限制的常驻 LPAC Python 工作进程，输入只读、任务输出与临时目录可写，隔离失败不会回退到普通执行。

旧 React/HTML 卡片按实际时间访问能力接入。需要历史推进和是否能独立缓存分别判断；依赖背景的效果保留 Chrome 合成上下文。后台按必须预渲染、独立控件 MOV、整片 MOV 的顺序工作；占位和不完整结果有明确标识。源码、参数、风格、输入与时间轴参与缓存失效处理。

## 最后一轮实际结果

| 检查 | 结果 | 证据或范围 |
| --- | --- | --- |
| 最终 JavaScript 测试 | 1,189 通过，0 失败 | `work/card-integration/cycle5-final-unit-tests.log` |
| TypeScript 编译检查 | 通过 | `work/card-integration/cycle5-typecheck.log` |
| 完整开发集成 | 通过 | 实际 LPAC、GLSL、Pillow、音频、多输入、旧 Chrome 输入、状态推进、缓存优先级、风格与保存重开 |
| 安装版运行器 | 通过 | 并发响应、容量与重复请求限制、EOF 清理、崩溃/FIFO/取消恢复 |
| 安装版 NumPy | 通过 | 三张 1080p RGBA float 数组，私有内存约 116 MiB |
| 真实 Harness Agent | 通过 | 8 个模型轮次，13 次工具调用成功，0 次工具失败，正常完成，无服务商错误 |
| 自定义转场与滤镜 | 通过 | 两份 Python 源码实际创建、应用；各检查 0.5、2.5、4.5 秒 |
| 实际保存、重开与暂停预览 | 通过 | `saved-project.proc` 与 `installed-preview.png` |
| 首次冷缓存播放 | 未通过 | 稳定测量区间内没有有效画布呈现帧 |
| 预先完成测试区间缓存后的播放 | 未通过 | 约 1.09 fps，最大帧间隔约 4.40 秒 |

缓存准备通过安装版帧接口生成了 0–12 秒共 361 张真实帧，耗时 292.778 秒。随后观察实际 UI 播放十秒，并剔除前两秒启动阶段：8.2523 秒内只呈现九张不同帧。93.19% 的画布采样没有有效帧编号；它不等同于整个界面黑屏率，因为 UI 还可能显示预览图或占位。没有降低 24 fps、最大间隔小于 300 ms 的验收标准。

播放响应里反复出现两个缓存标识交替，并出现已发布帧数量归零。客户端在 MOV 改变时会清空已解码帧，这是一条具体诊断线索。最终保存项目与 UI 项目的画面标识字段相同，但还不能据此排除请求中间状态、素材时间戳或代码指纹差异；根因没有完成确认与修复。

## 五轮记录

| 轮次 | 完整安装 | 主要结果 |
| --- | --- | --- |
| 1 | 成功 | Agent 创建和应用后，看帧失败；修复输入图保留、签名和帧读取问题 |
| 2 | 成功 | 安装版渲染失败；修复 NumPy 线程内存与 Windows Chrome 路径问题 |
| 3 | 成功 | 两效果看帧成功，但服务商最终返回错误；独立保存重开验证后预览遇到 Python 管道退出 |
| 4 | 成功 | 滤镜看帧成功，转场 GLSL 错误未修好；补齐编译诊断并解决作用域生命周期阻塞 |
| 5 | 成功 | Agent、两效果看帧、保存重开与暂停预览成功；冷播放及缓存播放仍不流畅 |

## 原项目与证据

真实项目为桌面的 `《九箭旅行社·东京7日深度游》4.proc`，88.7 秒、1920×1080、30 fps、17 轨。每轮使用独立副本。原文件最终 SHA256 与开始时相同：`ba43926c331c17b0d7b953d9006183d8ba3fa0a12b905d881758021baeb02c4d`。

第 5 轮全部证据位于 `work/installed-card-cycle-5/`：

- `acceptance-report.json`、`cycle.json`、`failure.json`：最终状态与失败原因。
- `chat-sse.redacted.json`、`agent-completion.txt`：真实 Agent 工具过程与完成消息。
- `agent-transition-1.png` 至 `3.png`、`agent-filter-1.png` 至 `3.png`：从软件保存的原始看帧记录取得的图片，没有重新合成。
- `saved-project.proc`：通过产品实际保存功能产生、包含两份源码和使用实例的项目。
- `cold-playback-metrics.json`、`warm-playback-metrics.json`、对应 samples/trace 与 `playback-status-observation.json`：播放证据。
- `install-result.json`、`installed-file-hashes.json`、`installed-shell-verification.json`、`lpac-*.log`：安装与隔离运行验证。

其余实际限制：四个独立运行器同时初始化仍可能触发 30 秒 ACL 获取超时；单独运行的完整集成通过，但与故意争用权限锁的压力测试同时运行时曾出现冷 Chrome 预览超时。这些失败记录均保留。开发侧集成与当前实际安装版的两个效果验证不能代替整个 88.7 秒项目的完整音画导出验收。

With Agy 的两份最新独立审视与主 Agent 裁定位于 `work/with-agy/cycle5-acl-review/`。没有采用解除 ACL 清理锁的建议，也没有把模型意见当成实际测试结果。后续工作应先追踪播放时缓存标识变化及解码窗口重置，再复验真实项目播放；当前已达到用户规定的五轮上限。
