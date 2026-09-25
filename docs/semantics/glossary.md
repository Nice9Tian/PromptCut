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
| 素材服务 | 字节的唯一读写入口，按内容哈希寻址，位置无关；取代旧名「素材存储」「素材云」 | `architecture.md`、architecture/asset-storage.md |
| 成片渲染 | 把项目渲染成给人看的画面 | `architecture.md`、architecture/rendering.md |
| 查询渲染 | 按 Agent 指定的时刻渲染画面，供 Agent 观察 | `architecture.md`、architecture/rendering.md |
| 本地文档服务、远程文档服务 | 按所连文档服务的位置区分：跑在本机的，和部署在局域网其它机器或公网云端的 | architecture/document-service.md |
| 本地素材服务、远程素材服务 | 按所连素材服务的位置区分，同上；与文档服务的位置可任意组合。这两组词取代旧词「本地模式」「云端模式」 | architecture/document-service.md、architecture/asset-storage.md |
| 连接发现 | 两部分：素材服务地址的动态下发（已引入）；设备之间直连的信令（预留）。文档服务都只交换地址，不承担素材传输流量 | architecture/document-service.md |
| 渲染任务队列 | 文档服务在内存里托管的预渲染任务清单：只记状态和认领者，不测算、不分配 | architecture/document-service.md |
| 渲染节点 | 从渲染任务队列认领并完成预渲染任务的地方：本机 PC、独立渲染主机、纯浏览器；按能力区分，不按平台名 | architecture/platforms.md |
| 认领 | 渲染节点从队列里取一个任务：比对状态再加锁一步完成，同一任务同时只有一个认领者；断开或超时后任务回到未认领 | architecture/document-service.md |
| 独立渲染主机 | 局域网或远程主机上、不带编辑界面的预渲染进程，作为渲染节点为多个项目取活 | architecture/platforms.md |
| 环境指纹 | 渲染环境的标识（操作系统、GPU 基础类别、Chrome 主版本），并入预渲染结果的键；不同环境的结果不混用 | architecture/rendering.md |
| 卡片级指纹锁 | 一张卡的同一种预渲染结果（快照或轨道流）只出自一种环境：最先产出的环境锁定这张卡，别的环境只能用自己的指纹另起一套键、从头接手 | architecture/rendering.md |
| 桌面运行环境 | 带预渲染进程的桌面应用（或本机 dev server）所在的运行环境，和「在线浏览器模式」对举；可以连本地或远程的服务 | architecture/platforms.md |
| 在线浏览器模式 | 只有页面、没有本机进程的运行形态 | architecture/platforms.md |
| 低内存档 | 平板、手机等内存受限设备的运行档位 | architecture/platforms.md |
| 本地内容库 | 素材服务在某台设备上按哈希存字节的存储或缓存，不是绕过素材服务的直读通道 | architecture/asset-storage.md |
| 小版、原片 | 同一素材的两档：800×600 以内的 H.264，和保持原编码的原文件 | architecture/asset-storage.md |
| 共享项目 | 多人共用的项目，也是权限的隔离单位；分互联网模式、局域网模式，进入方式分自由进入、限定进入 | architecture/document-service.md、workflow/project.md |
| 自由进入、限定进入 | 共享项目的两种进入方式：凭项目名和项目密码进入并自报用户名；只允许创建者名单里的用户名加密码进入 | workflow/project.md |
| 互联网模式、局域网模式 | 共享项目的两种部署：文档服务和素材服务托管在公网云端，成员连过去；创建者本机当主机，只在同一网段内能用 | architecture/document-service.md |
| 局域网发现 | 局域网模式下，主机在本网段广播项目名和地址，成员据此找到它；不经文档服务 | architecture/document-service.md |
| 设备名 | 软件按硬件信息给每台设备生成的名字；重名的成员显示时带上它 | workflow/project.md |

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
| 兜底顺序 | 画面来不及时按满帧流 → 稀疏流 → 旧快照 → 占位符逐级退化，受算力预算约束 | architecture/rendering.md |
| 占位符 | 兜底顺序尽头在卡片位置显示的沙漏加噪点，只出现在预览里；渲染不了的卡另显示「需要本地 PC 渲染辅助」 | architecture/rendering.md |
| 预渲染进程 | 做预渲染和查询渲染的进程，有 Agent、User、Full 三种模式；通常在本机，跑在独立渲染主机上时就是那台主机的渲染节点 | architecture/rendering.md |

## 开发

| 术语 | 含义 | 定义在 |
|---|---|---|
| 基线 | 每次改动都必须通过的验证集合 | guide_files/verification.md |
| 专用 worktree | 会影响基线的改动所在的独立工作目录和分支 | guide_files/suggested_agent_behavior.md |
| 本机说明 | 只和本机有关的环境信息，不入库 | guide_files/constraints.md |
