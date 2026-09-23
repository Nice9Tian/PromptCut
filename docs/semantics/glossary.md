# 术语表

本仓库文档统一使用下列术语。「定义在」一列指向给出完整规则的文件，路径相对于 `docs/semantics/`。

## 用词约定

- 说「预渲染」，不说「烘焙」。说「生成快照」，不说「冻结」。代码标识符不受此限。

## 产品与工作方式

| 术语 | 含义 | 定义在 |
|---|---|---|
| 传统式 | 打开编辑界面工作，用户和 AI 栏里的 Agent 一起改 | `user-workflow.md` |
| SKILL | 桌面 APP 里的 Agent 经 MCP 接入；默认关闭编辑界面，转入后台运行 | `user-workflow.md` |
| 后台运行 | 桌面应用关闭编辑界面后转为托盘图标和悬浮窗继续运行 | `user-workflow.md` |
| AI 栏 | 编辑界面右侧和 Agent 对话、看进度的区域 | `user-workflow.md` |
| 接入方式 | Agent 的三种接入：CLI、API（在 AI 栏里对话）、桌面 APP（经 SKILL） | `user-workflow.md` |
| 创造力等级 | 低、中、高三档，决定 Agent 能改到多深；项目有默认值，每个对话可单独改 | `user-workflow.md` |
| 主 Agent、角色 | 主 Agent 可拉起其它 Agent 并分派任务，拉起时可附加预设的角色 | `user-workflow.md` |
| 进度汇报 | Agent 交给用户的结构化条目：做了、待办、问题 | `user-workflow.md` |

## 系统角色

| 术语 | 含义 | 定义在 |
|---|---|---|
| 编辑界面 | 用户看和操作的地方 | `architecture.md` |
| 文档服务 | 项目文档的唯一修改入口 | `architecture.md`、architecture/document-service.md |
| 素材存储 | 按内容哈希存字节的仓库 | `architecture.md`、architecture/asset-storage.md |
| 成片渲染 | 把项目渲染成给人看的画面 | `architecture.md`、architecture/rendering.md |
| 查询渲染 | 按 Agent 指定的时刻渲染画面，供 Agent 观察 | `architecture.md`、architecture/rendering.md |
| 本地模式、云端模式 | 文档服务在本机或在云端；本地模式不经过素材存储 | architecture/document-service.md |
| 在线浏览器模式 | 只有页面、没有本机进程的运行形态 | architecture/platforms.md |
| 低内存档 | 平板、手机等内存受限设备的运行档位 | architecture/platforms.md |
| 本地内容库 | 每台设备上按哈希存素材字节的目录 | architecture/asset-storage.md |
| 小版、原片 | 同一素材的两档：800×600 以内的 H.264，和保持原编码的原文件 | architecture/asset-storage.md |

## 项目数据

| 术语 | 含义 | 定义在 |
|---|---|---|
| 剪辑 | 项目里的一条独立时间轴；同一时刻只有一条激活 | architecture/project-model.md |
| 序列 | 时间轴上的一行，不分种类；靠上的画在上层 | architecture/project-model.md |
| 片段 | 序列上的一段，分卡片段和素材段 | architecture/project-model.md |
| 效果库 | 项目里的滤镜、像素映射、音频效果定义 | architecture/project-model.md |
| 滤镜 | 整帧调色 | architecture/project-model.md |
| 像素映射 | 需要逐像素判断的选区处理 | architecture/project-model.md |
| 转场 | 交叉溶解、淡入、淡出；独立对象，把相关片段绑成一组 | architecture/project-model.md |

## 卡片

| 术语 | 含义 | 定义在 |
|---|---|---|
| 卡片 | 画面上的特效或动效，本质是一段代码 | architecture/cards.md |
| DOM 卡、图卡、组合卡、素材封装卡 | 卡片的四种形态 | architecture/cards.md |
| 部件 | 组合卡的零件，有自己的框、参数和进场时机 | architecture/cards.md |
| 约定封装 | 一张卡对外唯一的样子，Agent 和代码页看的都是它 | architecture/cards.md |
| 随机访问卡 | 按时间直接算出画面的卡 | architecture/cards.md |
| 可定位的推帧卡 | 能把动画时间一步钉到目标帧的有状态卡 | architecture/cards.md |
| 只能逐帧推的卡 | 自己累积状态、只能从起点逐帧推进的卡 | architecture/cards.md |
| canvas 卡 | 画在 2D canvas 或 WebGL 上的卡 | architecture/cards.md |
| 独立卡、源依赖卡、下层依赖卡 | 按依不依赖下层分的三类 | architecture/cards.md |
| 审阅表 | 卡片分类的权威记录，优先于卡片源码里的声明 | architecture/cards.md |

## 渲染

| 术语 | 含义 | 定义在 |
|---|---|---|
| 舞台 | 渲染给人看的画面的独立进程页面 | architecture/rendering.md |
| 可见舞台、后台舞台 | 两个舞台的角色：一个负责播放，一个负责测量和补跑，可互换 | architecture/rendering.md |
| 活渲 | 在舞台里实时渲染卡片 | architecture/rendering.md |
| 轻卡、重卡 | 某一段里活渲的卡和贴预渲染结果的卡 | architecture/rendering.md |
| 预算 | 每拍的成本上限：1000 / fps × 70% | architecture/rendering.md |
| 测量 | 打开项目或新加卡时实测每张卡的成本 | architecture/rendering.md |
| 追帧 | 推帧卡跳转后，从起点推到目标帧 | architecture/rendering.md |
| 降级 | 播放中把最贵的轻卡改判为重卡 | architecture/rendering.md |
| 预渲染、预渲染结果 | 离屏预先渲染重卡，产出快照或轨道流 | architecture/rendering.md |
| 预渲染集合 | 所有段里重卡的并集，只有它们会被预渲染 | architecture/rendering.md |
| 快照 | 某张卡某一帧的 HTML，用于暂停和拖动 | architecture/rendering.md |
| 生成快照 | 把卡片当前的 DOM 连同样式、画布转成快照 | architecture/rendering.md |
| 轨道流、组流 | 重卡播放时贴的 alpha 视频流；多张相邻重卡合成的一条流 | architecture/rendering.md |
| 实体框 | 卡片实际画出内容的最小矩形 | architecture/rendering.md |
| 预渲染进程 | 本机做预渲染和查询渲染的进程，有 Agent、User、Full 三种模式 | architecture/rendering.md |

## 开发

| 术语 | 含义 | 定义在 |
|---|---|---|
| 基线 | 每次改动都必须通过的验证集合 | agent/verification.md |
| 专用 worktree | 会影响基线的改动所在的独立工作目录和分支 | `agent-guide.md` |
| 本机说明 | 只和本机有关的环境信息，不入库 | `agent-guide.md` |
