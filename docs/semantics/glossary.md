# 术语表

本仓库文档统一使用下列术语。「定义在」一列指向给出完整规则的文件，路径相对于 `docs/semantics/`。「级」一列是给出定义的那一本的级别：一 = 用户体验，二 = 产品功能，三 = 具体机制（见 `developer_guide.md` 的「语义的三级」）。二级文件里提到三级术语时，承诺以二级文件为准。

## 用词约定

- 说「预渲染」，不说「烘焙」。说「生成快照」，不说「冻结」。代码标识符不受此限。

## 产品与工作方式

| 术语 | 含义 | 级 | 定义在 |
|---|---|---|---|
| 传统式 | 打开编辑界面工作，用户和 AI 栏里的 Agent 一起改 | 一 | `user-workflow.md` |
| SKILL | 桌面 APP 里的 Agent 经 MCP 接入；默认关闭编辑界面，转入后台运行 | 一 | `user-workflow.md` |
| 后台运行 | 桌面应用关闭编辑界面后转为托盘图标和悬浮窗继续运行 | 一 | `user-workflow.md` |
| AI 栏 | 编辑界面右侧和 Agent 对话、看进度的区域 | 一 | `user-workflow.md` |
| 接入方式 | Agent 的四种接入：CLI、API（在 AI 栏里对话）、桌面 APP（经 SKILL）、云端（AI 栏里，对话在云节点上运行；在线浏览器模式只有这一种） | 一 | `user-workflow.md` |
| 云端 Agent | 托管方提供、跑在云节点上的 Agent 服务；对话与工具由它执行，改动经文档服务落地；发起的成员离线后对话照常跑完；署名「〈成员名〉的云端 Agent」 | 二 | product/agent.md |
| 委托票据、对话委托 | 云端 Agent 的两种身份证明：前者页面每个请求出示（2 分钟），后者随「发消息」交给 Agent 服务（60 分钟，绑成员、项目、对话），都由项目的文档服务签发与核验；成员离线不影响，被移出、关开关、删项目当场作废 | 三 | mechanism/agent.md |
| 创造力等级 | 低、中、高三档，决定 Agent 能改到多深；项目有默认值，每个对话可单独改 | 一 | `user-workflow.md` |
| 主 Agent、角色 | 主 Agent 可拉起其它 Agent 并分派任务，拉起时可附加预设的角色 | 一 | `user-workflow.md` |
| 进度汇报 | Agent 交给用户的结构化条目：做了、待办、问题 | 一 | `user-workflow.md` |

## 系统角色

| 术语 | 含义 | 级 | 定义在 |
|---|---|---|---|
| 编辑界面 | 用户看和操作的地方 | 二 | `architecture.md` |
| 文档服务 | 项目文档的唯一修改入口 | 二 | `architecture.md`、product/document-service.md |
| 素材服务 | 字节的唯一读写入口，按内容哈希寻址，位置无关；取代旧名「素材存储」「素材云」 | 二 | `architecture.md`、product/asset-service.md |
| 成片渲染 | 把项目渲染成给人看的画面 | 二 | `architecture.md`、product/rendering.md |
| 即时渲染 | 有人正等着看结果时按需当场渲染指定时刻的画面，结果从渲染所在的位置直接交给请求方，不进文档服务的任务队列，不经过素材服务；目前的请求方是 Agent。与「预渲染」相对；取代旧名「查询渲染」（代码标识符和旧文档里的 query-render、查询渲染指的就是它） | 二 | `architecture.md`、product/rendering.md |
| 云端托管服务 | 常驻云端、所有多用户协作项目的公共入口，负责牵线（验证创建者机器的公网可达性；先验项目凭证与禁入表，通过才给主机地址）与中继；与云端文档服务、云端素材服务独立部署，不属于文档服务，不签发票据 | 二 | product/hosting.md |
| 本地文档服务、云端文档服务 | 文档服务的两种部署：跑在创建者本机的，和跑在云端的 | 二 | product/document-service.md |
| 本地素材服务、云端素材服务 | 素材服务的两种部署，同上。这两组词取代旧词「本地模式」「云端模式」「远程文档服务」「远程素材服务」 | 二 | product/document-service.md、product/asset-service.md |
| 会话 | 文档服务与每一方之间的连接单位：消息双向有序、带序号、接收方确认；单次传输中断不结束会话 | 二 | product/document-service.md、mechanism/document-service.md |
| 传输 | 会话的搬运方式：WebSocket 或 HTTP 长轮询，系统自动选择，业务模块与用户都不感知 | 二 | product/document-service.md、mechanism/document-service.md |
| HTTP 长轮询 | 第二种传输：用普通 HTTP 请求发消息，收消息的请求挂在服务端，有消息或到时限再回；WebSocket 握手失败时自动转用 | 二 | product/document-service.md、mechanism/document-service.md |
| 只能出网的节点 | 没有入站连接、出网只能经代理走 443 HTTPS 的机器（如云端容器）；永远是成员，不能当主机，加入放本机的项目只能走中继 | 二 | product/platforms.md |
| 连接发现 | 文档服务把素材服务的地址下发给各方（已引入）；成员怎么找到主机见「连接路径」。文档服务只下发地址，不承担素材传输流量 | 三 | mechanism/document-service.md |
| 渲染任务队列 | 文档服务在内存里托管的预渲染任务清单：只记状态和认领者，不测算、不分配 | 二 | product/document-service.md |
| 渲染节点 | 从渲染任务队列认领并完成预渲染任务的地方：本机 PC、独立渲染主机、纯浏览器；按能力区分，不按平台名 | 二 | product/platforms.md |
| 认领 | 渲染节点从队列里取一个任务：比对状态再加锁一步完成，同一任务同时只有一个认领者；断开或超时后任务回到未认领 | 三 | mechanism/document-service.md |
| 独立渲染主机 | 局域网或远程主机上、不带编辑界面的预渲染进程，作为渲染节点为多个项目取活 | 二 | product/platforms.md |
| 环境指纹 | 渲染环境的标识（操作系统、GPU 基础类别、Chrome 主版本），并入预渲染结果的键；不同环境的结果不混用 | 三 | mechanism/rendering.md |
| 卡片级指纹锁 | 一张卡的同一种预渲染结果（快照或轨道流）只出自一种环境：最先产出的环境锁定这张卡，别的环境只能用自己的指纹另起一套键、从头接手 | 三 | mechanism/rendering.md |
| 桌面运行环境 | 带预渲染进程的桌面应用（或本机 dev server）所在的运行环境，和「在线浏览器模式」对举；可以连本地或远程的服务 | 二 | product/platforms.md |
| 在线浏览器模式 | 只有页面、没有本机进程的运行形态。入口是服务器地址加固定后缀（如 `/editor`），打开即是编辑器、不用安装，第一页是开始页；页面连同一台服务器上的文档服务和素材服务 | 二 | product/platforms.md |
| 低内存档 | 手机、iPad 浏览器的运行档位：播放时只看预渲染小尺寸和素材小尺寸、不活渲；停下时把当前这一帧画出来，允许慢、有时限；轻重按共享成本记录加界限搜索判（C10a 过渡期全部按重卡）；判重又缺产物的层发补渲任务；轻量修改、可以逐帧导出；不预渲染、不当渲染节点 | 二 | product/platforms.md |
| 补渲 | 为弱设备补做的预渲染：低内存档判重、素材服务里又没有产物的层发布的任务，排在本机判重的任务之后 | 二 | product/document-service.md、product/platforms.md |
| 本地内容库 | 素材服务在某台设备上按哈希存字节的存储或缓存，不是绕过素材服务的直读通道 | 三 | mechanism/asset-service.md |
| 素材原尺寸、素材小尺寸 | 同一素材的两档：用户导入的原始文件、编码不变，导出和像素级检查只用它；缩到 800×600 以内、重压成 H.264 的副本，预览用。取代旧词「原片」「小版」 | 二 | product/asset-service.md |
| 预渲染原尺寸、预渲染小尺寸 | 预渲染产物的两档：按项目分辨率渲出的，导出和电脑预览用；由原尺寸直接缩小、不重渲的，低内存档预览用。两档都推送到素材服务 | 二 | product/rendering.md |
| 共享项目 | 系统术语，界面上叫「多用户协作」：勾上了「多用户协作」的项目，也是权限的隔离单位；放本机或云端，进入方式分自由进入、限定进入 | 二 | product/document-service.md、workflow/project.md |
| 多用户协作 | 「共享项目」在界面上的叫法，也是项目设置里的勾选：勾上后项目由本地文档服务托管，并向云端托管服务登记，别人在开始页加入；随时可以取消 | 一 | workflow/project.md |
| 邀请码 | 项目的文档服务签发的令牌，装在邀请链接和二维码里；凭它加入等价于填对了项目名和项目密码，可作废、可限时限量，作废不影响项目密码；不含项目名和密码本身 | 一 | workflow/project.md |
| 自由进入、限定进入 | 共享项目的两种进入方式：凭项目名和项目密码进入并自报用户名；只允许创建者名单里的用户名加密码进入 | 一 | workflow/project.md |
| 本机、云端（项目放在哪） | 共享项目的两种部署：文档服务和素材服务都在创建者本机，或都在云端；谁都能选，可以随时搬。取代旧词「局域网模式」「互联网模式」 | 二 | product/document-service.md |
| 连接路径 | 成员连本机项目主机的三条路，按顺序试：局域网直连、公网直连、云端托管服务中继；都是常规路径，中继最慢、受限速 | 二 | product/document-service.md |
| 局域网发现 | 局域网直连这一路里，主机在本网段广播项目名和地址，成员据此找到它；不经云端 | 三 | mechanism/document-service.md |
| 设备名 | 软件按硬件信息给每台设备生成的名字；重名的成员显示时带上它 | 一 | workflow/project.md |

## 项目数据

| 术语 | 含义 | 级 | 定义在 |
|---|---|---|---|
| 剪辑 | 项目里的一条独立时间轴；同一时刻只有一条激活 | 二 | product/project-model.md |
| 序列 | 时间轴上的一行，不分种类；靠上的画在上层 | 二 | product/project-model.md |
| 片段 | 序列上的一段，分卡片段和素材段 | 二 | product/project-model.md |
| 效果库 | 项目里的滤镜、像素映射、音频效果定义 | 二 | product/project-model.md |
| 滤镜 | 整帧调色 | 二 | product/project-model.md |
| 像素映射 | 需要逐像素判断的选区处理 | 二 | product/project-model.md |
| 转场 | 交叉溶解、淡入、淡出；独立对象，把相关片段绑成一组 | 二 | product/project-model.md |

## 卡片

| 术语 | 含义 | 级 | 定义在 |
|---|---|---|---|
| 卡片 | 画面上的特效或动效，本质是一段代码 | 二 | product/cards.md |
| DOM 卡、图卡、组合卡、素材封装卡 | 卡片的四种形态 | 二 | product/cards.md |
| 部件 | 组合卡的零件，有自己的框、参数和进场时机 | 二 | product/cards.md |
| 约定封装 | 一张卡对外唯一的样子，Agent 和代码页看的都是它 | 二 | product/cards.md |
| 随机访问卡 | 按时间直接算出画面的卡 | 三 | mechanism/cards.md |
| 可定位的推帧卡 | 能把动画时间一步钉到目标帧的有状态卡 | 三 | mechanism/cards.md |
| 只能逐帧推的卡 | 自己累积状态、只能从起点逐帧推进的卡 | 三 | mechanism/cards.md |
| canvas 卡 | 画在 2D canvas 或 WebGL 上的卡 | 三 | mechanism/cards.md |
| 独立卡、源依赖卡、下层依赖卡 | 按依不依赖下层分的三类 | 三 | mechanism/cards.md |
| 审阅表 | 卡片分类的权威记录，优先于卡片源码里的声明 | 三 | mechanism/cards.md |

## 渲染

| 术语 | 含义 | 级 | 定义在 |
|---|---|---|---|
| 舞台 | 渲染给人看的画面的独立进程页面 | 二 | product/rendering.md |
| 可见舞台、后台舞台 | 两个舞台的角色：一个负责播放，一个负责测量和补跑，可互换 | 三 | mechanism/rendering.md |
| 活渲 | 在舞台里实时渲染卡片 | 二 | product/rendering.md、mechanism/rendering.md |
| 轻卡、重卡 | 某一段里活渲的卡和贴预渲染结果的卡 | 二 | product/rendering.md、mechanism/rendering.md |
| 预算 | 每拍的成本上限：1000 / fps × 70% | 三 | mechanism/rendering.md |
| 测量 | 打开项目或新加卡时实测每张卡的成本 | 二 | product/rendering.md |
| 追帧 | 推帧卡跳转后，从起点推到目标帧 | 三 | mechanism/rendering.md |
| 降级 | 播放中把最贵的轻卡改判为重卡 | 三 | mechanism/rendering.md |
| 预渲染、预渲染结果 | 没人等着看的时候离屏预先渲染重卡，产出快照或轨道流，推送到素材服务，供播放、拖动、导出时直接贴上；任务发布到文档服务的任务队列由渲染节点认领，连不上时本机自己做。与「即时渲染」相对 | 二 | product/rendering.md |
| 预渲染集合 | 所有段里重卡的并集，只有它们会被预渲染 | 三 | mechanism/rendering.md |
| 帧库 | 桌面版在本机存预渲染结果的目录，是可重新生成的缓存，有上限、按最近使用淘汰 | 三 | mechanism/platforms.md |
| 成本记录 | 一张卡的活渲单帧耗时，按「卡片身份（不含测量机器）+ 环境指纹」存在文档服务，供低内存档排序 | 三 | mechanism/document-service.md、mechanism/rendering.md |
| 界限搜索 | 低内存档判轻重的做法：按成本记录给卡排序，二分法测到自己跑不动的第一张，以它为界 | 三 | mechanism/rendering.md |
| 快照 | 某张卡某一帧的 HTML，用于暂停和拖动 | 二 | product/rendering.md、mechanism/rendering.md |
| 生成快照 | 把卡片当前的 DOM 连同样式、画布转成快照 | 三 | mechanism/rendering.md |
| 轨道流、组流 | 重卡播放时贴的 alpha 视频流；多张相邻重卡合成的一条流 | 三 | mechanism/rendering.md |
| 实体框 | 卡片实际画出内容的最小矩形 | 二 | product/rendering.md、mechanism/rendering.md |
| 兜底顺序 | 画面来不及时按满帧流 → 稀疏流 → 旧快照 → 占位符逐级退化，受算力预算约束 | 二 | product/rendering.md、mechanism/rendering.md |
| 占位符 | 兜底顺序尽头在卡片位置显示的沙漏加噪点，只出现在预览里；在线浏览器模式下轮到本机渲染、这台设备又运行不了的用户卡或图卡，没有预渲染结果时另显示「需要本地 PC 渲染辅助」 | 二 | product/rendering.md |
| 在线卡片运行时版本 | 在线浏览器执行用户卡与图卡的加载规则版本加转译器与 Tailwind 的版本；进转译缓存键、成本记录的设备串，纯浏览器节点做用户卡任务时进环境指纹 | 三 | mechanism/platforms.md |
| 隔离舞台 | 与编辑页面跨源、带内容安全策略与出口白名单的舞台文档；用户卡与图卡的画面只在这里执行，声音只在它起的专用后台线程里执行 | 三 | mechanism/platforms.md |
| 预渲染进程 | 做预渲染和即时渲染的进程，有 Agent、User、Full 三种模式；通常在本机，跑在独立渲染主机上时就是那台主机的渲染节点 | 三 | mechanism/rendering.md |

## 开发

| 术语 | 含义 | 级 | 定义在 |
|---|---|---|---|
| 基线 | 每次改动都必须通过的验证集合 | — | guide_files/verification.md |
| 专用 worktree | 会影响基线的改动所在的独立工作目录和分支 | — | guide_files/suggested_agent_behavior.md |
| 本机说明 | 只和本机有关的环境信息，不入库 | — | guide_files/constraints.md |
