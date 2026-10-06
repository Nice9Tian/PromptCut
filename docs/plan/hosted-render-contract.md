# 托管方的渲染节点：设计与契约

状态：**主会话已审、按它开工**（2026-10-06，`claude/render-service`；草稿 `acbb2993`）。任务书 `sound-online-render-task.md` 的 D 与第 20～24 条，以及 `cloud-agent-task.md`「用户体验验收」对本段的要求。第 1 批（服务身份、目录、白名单、开关的服务端）与第 2 批（主机动态项目与代理模式、管理进程、背压与内存看护、自检、Chrome 沙箱、本机演练探针）已实现，与本文不一致的地方记在文末「实现记录」；方案 A 的隔离工作进程与语义落稿未做。标〔裁：主会话 2026-10-06〕的是主会话的裁定。

依据的现有契约：`auth-contract.md`（凭证、角色、票据）、`render-host-contract.md`（独立渲染主机）、`render-queue-contract.md` B.1、F、I（指纹、卡片锁、前置过滤）、`m7-contract.md` 第 3、6 节、`http-transport-contract.md` 第 10 节（本机信任）。〔裁〕是本文自己定的细节，每条写了理由，主会话可以推翻。「待实现时验证」是没有实测依据、实现时先用探针确认的点。

名词：

| 名词 | 含义 |
|---|---|
| 托管方 | 运营这台云节点的一方 |
| 托管方服务 | 托管方在节点上跑的、要进数据面的进程。本段只有渲染服务；第四段加 Agent 服务 |
| 服务身份 | 托管方服务向文档服务证明「我是这台节点的某个服务」的凭证。不是任何项目的成员 |
| 渲染服务 | 云节点上常驻的独立渲染主机，PM2 里的 `promptcut-render` |
| 管理进程 / 工作进程 | 渲染服务的两层：管理进程持服务私钥、连目录；工作进程是 `scripts/render-host.mjs` 起的那棵（Vite、预渲染进程、Chrome），只拿短期票据 |

---

## 0. 主会话的裁定（2026-10-06）

草稿里请主会话定的三件事，以及审稿与任务书更新后追加的裁定。下面三条保留草稿原文，裁定结果列在其后。

1. **用户卡在托管方的渲染服务里怎么跑。** 现在的独立渲染主机把各项目的用户卡装进同一个检出目录和同一个改动层（`render-host-contract.md` 第 7 节「限制」），预渲染页面与工作进程的本机接口同源。桌面上这是用户自己选择加入哪些项目；托管端任何人都能建项目（`auth-contract.md` 第 4 节「谁能建」），等于托管方替任意来源执行代码：
   - 项目甲的用户卡的顶层代码，会在渲染项目乙的页面里执行，读得到页面里项目乙的内容，再发到外面；
   - 卡片代码能请求工作进程自己的 `/api/*`。
   
   本文按**方案 A：有用户卡的项目只在按项目隔离的工作进程里渲**来写（第 7.5 节）。备选**方案 B**：第一版托管方的渲染服务不接用户卡任务（`userCards: false`、不同步卡），任务书第 23 条「含用户卡、图卡的任务它能渲」记未达成。不建议方案 C（照现状共用一个实例）。请主会话选 A 或 B。
2. **「创建者特权只有三项」这句要不要动。** `workflow/project.md` 与 `product/document-service.md` 各有一句。D 让创建者多了一个开关，这句不改就前后矛盾。任务书 D 只点名四份文档、没点 `document-service.md`，「三项」的措辞也没说怎么改。第 9 节给了建议稿（不改「三项」的数，另起一句），请主会话确认算不算在 D 的授权内。
3. **图卡。** 现在 PC 节点与独立渲染主机报的能力都是 `graphCards: false`（`server/vite-plugin-frames.ts` 的 `nodeCapabilities`、`render-node/host.mjs` 的 `HOST_CAPABILITIES`），没有任何任务写 `requires.graphCards: true`。第二段怎么给图卡任务标能力、无头 Chrome 的软件 WebGL 能不能跑图卡，要等第二段合入后才知道。本文不替它定，第 5 节只写「按第二段定的能力位报」。

**裁定〔裁：主会话 2026-10-06〕：**

| # | 事 | 裁定 |
|---|---|---|
| 1 | 用户卡 | 选**方案 A**，排在最后一批；做不稳就退到方案 B，报告里记「含用户卡、图卡的任务它能渲」未达成（非核心项，不挡）。常驻工作进程绝不同步任何卡，从第 1 批起成立 |
| 2 | 「创建者特权只有三项」 | 直说是第四项，不绕成「算在踢人里」：两处都改成「创建者特权只有四项：改项目密码、名单或邀请码，删项目，踢人，开关托管方的渲染节点；其余操作所有成员一样。」并标〔裁：决定 D 的直接后果，主会话 2026-10-06，待用户合入前审〕。第四段合流时把第四项扩成「开关托管方在这个项目里的服务」 |
| 3 | 图卡 | 不替第二段定；代码里留一处集中的能力位表，第二段合流后主会话再对 |
| 4 | 服务握手只认本机发起 | 认可 |
| 5 | 工作进程用非 root 用户 | 认可，是部署模板的推荐值，不是前提：**必须同时支持** root / 容器下直接跑、自动带 `--no-sandbox` |
| 6 | systemd slice / cgroup | **必须能降级**：没有 systemd 时自检报「无 cgroup 上限，只靠进程内看护」并继续（不是退出 78），并发、背压、内存看护照常生效（部署前会在一台没有 systemd 的 Linux 容器里演练） |
| 7 | 数字 | 资源与容量数字、16 个项目、60 秒保持、轨道流第一版不开都认可。容量上限按 `min(20 GiB, 托管数据目录所在盘总容量的四分之一)`；新节点系统盘 39 GB，实际约 9.7 GiB |
| 8 | 节点重启后自动起来 | 怎么验由主会话最后在新节点上定；部署脚本与 README 里写清 PM2 存档与开机自启的步骤 |
| 9 | 与在线页面不同提交时不能静默 | 管理进程拿到在线页面（与 Agent 服务）的代码版本与自己不一致时明确告警、状态里可查（第 7.3、7.4 节） |
| 10 | 保留用户名 `service:` | 认可；新节点上的盘点由主会话部署前做 |
| 11 | 没有成员在线时也要渲 | `active` 的判据改掉（第 1.3 节）；没人在线时由**云端 Agent 服务发布补渲计划**，渲染服务认领（第 5a 节）；有成员在线的项目优先（第 4 节） |
| 12 | 开关与通知的形状 | 两种托管方服务合成一种形状：记录 `hosted: { render, agent }`、操作 `set-hosted-service`、通知 `hosted-service-changed`、成员列表顶层 `hosted`（第 1.7、3 节）；白名单按连接的 `service` 字段查；握手对带 `sv` 的票据按登记表的 `actsFor` 分两支（第 1.1、1.4 节） |

---

## 1. 服务身份：凭证、握手、权限

### 1.1 凭证

- 每个托管方服务一对 **Ed25519 密钥**〔裁：不对称。文档服务一侧只存公钥，托管数据目录被拷走（换机迁移、备份）不会带走能冒充服务的东西；私钥只在服务自己的目录里。Node 内置 `crypto.generateKeyPairSync('ed25519')` / `crypto.sign` / `crypto.verify`，不加依赖〕。
- **登记表**（文档服务读）：`<托管数据目录>/secrets/services.json`，0600。只有公钥：

```json
{ "v": 1, "services": { "render": { "role": "render", "keys": [{ "kid": "…8 字", "alg": "ed25519", "pub": "<32 字节 base64url>", "addedAt": 0 }] } } }
```

  - 服务名 1～32 个 `[a-z0-9-]`；`role` 是这个服务能拿到的连接角色，由登记表定，握手时不由对方自报；`kid` 是公钥 sha256 的前 8 个 base64url 字符。
  - 每个服务另有可选的 `actsFor`〔裁：主会话 2026-10-06〕：`'self'`（缺省）表示服务以自己的身份进项目、不是成员（渲染服务）；`'member'` 表示服务代某个成员进项目，票据里是那位成员的身份（云端 Agent 服务）。握手按这个属性分两支（第 1.4 节），不写死服务名。同一个服务的 `role`、`actsFor` 登记后不能变。
  - 文件不存在或某个服务不在表里：这个服务的握手一律 401，目录模块不挂。局域网主机（挂载模式）从不读它。
  - 每次有人取服务挑战时看一眼文件的修改时刻，变了就重读〔裁：换钥、撤钥不用重启托管服务；重启要先等写入停止，代价大〕。重读后公钥已不在表里的服务连接，以 4003 `service-revoked` 关闭。
- **私钥**（管理进程读）：`/var/lib/promptcut/render-secrets/service-key.json`，目录 0700、文件 0600，属主是跑管理进程的用户。内容 `{ v: 1, service: 'render', kid, alg: 'ed25519', priv: '<PKCS#8 base64url>', instanceId, instanceName }`。`instanceId` 是 16～64 个 `[A-Za-z0-9_-]`，生成一次不再变。
- **产生**：在节点上跑 keygen。私钥在节点上生成、不离开节点、不打印；公钥原子追加进登记表。**命令行形状（已定死，第 3 批的部署脚本照此调）**：

```
node server/hosted-render/keygen.mjs --hosted-data <托管数据目录> --secrets <私钥目录>
     [--service render | agent | <别的服务名>] [--role page|agent|render] [--acts-for self|member] [--instance-name <名>]
  → 标准输出一行 {"ok":true,"action":"generate","service","role","actsFor","kid","instanceId","registry","keyFile","previousKid"}
node server/hosted-render/keygen.mjs --hosted-data <托管数据目录> --retire <kid> [--service render]
  → {"ok":true,"action":"retire","service","kid","removed":true|false,"registry"}
node server/hosted-render/keygen.mjs --hosted-data <托管数据目录> --list
  → {"ok":true,"action":"list","registry","services":{"<服务名>":{"role","actsFor","kids":[…]}}}
```

  - `--service` 缺省 `render`；`--role` 缺省取与服务名同名的角色（`render`、`agent`），别的服务名必须显式给；`--acts-for` 缺省 `agent` 服务是 `member`、其余 `self`。
  - 私钥目录里已有这个服务的私钥文件时沿用它的 `instanceId`（换钥不换身份），输出的 `previousKid` 是被替换的那把。
  - 出错：标准错误一行 `{"ok":false,"error":…}`，退出码 1；参数不对退出码 2。单测与部署脚本可以直接调导出的 `runKeygen(argv)`。
- **轮换**：再跑一次 keygen（登记表里两把公钥并存）→ 重启渲染服务 → `keygen --retire <旧 kid>`。**撤销**：`keygen --retire <kid>`。

### 1.2 握手（控制连接）

托管方服务先开一条**控制连接**，不进任何项目的空间。

- 取挑战：`POST shared/service-challenge { service, deviceId }` → 200 `{ ok: true, nonce }`。`nonce` 32 字节、只用一次、60 s 过期、绑定 `('service', service, deviceId)`。服务名不在登记表里也照样回一个 `nonce`（不暴露有没有这个服务），之后握手失败。
- 握手子协议在 `promptcut.v1` 之外给一项 `promptcut.service.<base64url(JSON)>`，JSON 为 `{ v: 1, s: 服务名, kid, d: instanceId, dn: instanceName, nonce, m }`；`m` = base64url(Ed25519 签名)，被签的是 UTF-8 的 `"promptcut.service.v1\n" + s + "\n" + d + "\n" + nonce`。它与证明、连接票据、本机声明、集群令牌互斥（`auth-contract.md` 第 5 节「至多一项」）。
- 只在这些条件都成立时认：独立模式（托管端）；登记表里有这个服务与这个 `kid`；**请求真正的发起方是本机**（`auth/origin.mjs` 的 `isLocalOrigin`：对端回环、没有任何非回环的转发头）〔裁：这条不看 `PROMPTCUT_TRUST_LOOPBACK`。本机信任关掉是因为 nginx 转进来的请求看着像回环；nginx 模板用 `proxy_bind` 加 `X-Forwarded-For`，转进来的请求过不了 `isLocalOrigin`。这样私钥即使外泄，也只能在节点本机上用。服务以后要跑在另一台机器上时再放开，属于二级改动〕。
- 核对：`nonce` 先核对并作废；签名验过才采信其余字段；失败计入 `auth-contract.md` 第 9 节的限速（按来源地址）；日志 `auth.reject` 的 `reason` 新增 `bad-service`、`service-origin`，不记签名与 `nonce` 原文。`shared/verify` 同样认这一项。
- 得到的 principal：`{ userId: 'service:<服务名>', tenantId: null, scope: 'service', service: '<服务名>', serviceKid: <握手用的公钥编号>, serviceRole: <登记表里的角色>, deviceId, deviceName }`。
- **集群令牌不参与**：服务身份与管理身份是两回事。渲染服务的环境里没有集群令牌，`renderHostEnv` 本来就删掉它。

### 1.3 目录模块（控制连接上能做的事）

新模块 `hosted`（类型前缀 `hosted.`），只在独立模式且组装方给了登记表时挂。控制连接只能发下表的消息，别的一律 `forbidden`（`spaces.mjs` 与 `modules/shared.mjs` 的 `spaceOf` 对 `scope: 'service'` 且没有 `tenantId` 的身份回 null，与管理身份同样不进任何空间）。

| 消息 | 回包 | 内容 |
|---|---|---|
| `hosted.watch` | `hosted.projects { full: true, projects: [{ projectId, enabled, active, members, hosted }] }` | 订阅；之后每次变化推 `hosted.project { projectId, enabled, active, members, hosted }` 或 `hosted.project { projectId, removed: true }` |
| `hosted.ticket { projectId }` | `hosted.ticket.ok { ticket, exp }`，或 `error { reason }`：`no-project`、`service-disabled`、`service-revoked`、`relocating` / `relocated` | 给这个服务签一张进这个项目的连接票据 |
| `hosted.demand { projectId, holdMs? }` | `hosted.demand.ok { projectId, until }` | 声明「这个项目有活要别的托管方服务做」 |
| `hosted.delegate.verify` | 本段回 `error { reason: 'unsupported' }` | 分发点，第四段实现（只对 `agent` 服务开） |

- `enabled`：这个项目对**订阅的那个服务**的开关（渲染服务看渲染的，Agent 服务看 Agent 的）。`hosted`：各服务的 `{ available, enabled }`，与成员列表顶层同形状（第 1.7 节）；一种服务据此知道另一种的开关（Agent 服务要知道渲染开没开，第四段 R7）。
- `active`〔裁：主会话 2026-10-06，改掉草稿的「有成员在线」〕：按订阅的服务各算各的——这个项目的空间里此刻有**不是本服务自己**的连接（成员；或别的托管方服务的连接，如 Agent 代成员开的连接、Agent 的发布连接），或者别的托管方服务声明过这个项目有活（`hosted.demand`，还没到期）。某一类连接的最后一条离开后再保持 60 s。服务自己的连接不算，不然它连上之后永远不会断开。理由：发起人退出软件后，云端 Agent 接着改出来的重卡要有人渲；同时连接数仍然跟有活的项目数走，不跟项目总数（上限 1000）走。
- `members`：此刻有没有成员连接（不含保持期）。渲染服务据此让有人在线的项目优先（第 4 节）。
- `hosted.demand`：只有控制连接能发；`holdMs` 缺省 2 分钟、上限 10 分钟，到期前重发即续期，`holdMs: 0` 撤回。它只影响**别的**服务看到的 `active`，不绕过开关。用途：服务在这个项目里没有连接、但知道有活要渲的时候（例如 Agent 服务重启后要补发计划之前）。
- 「队列里还有未完成的任务」不单独算进 `active`〔裁〕：任务的发布方（页面、Agent 的发布连接）在线时已经算在上一条里；发布方离线超过队列的宽限期后，没认领的任务会被队列撤掉（第 5a 节），不存在「有任务而没有任何别的连接」的稳定状态。渲染服务自己另加一条：手里还有认领时不因 `active` 变假而断开，做完再走。
- `hosted.ticket` 签的是普通的连接票据（`auth-contract.md` 第 8 节，`k: 'conn'`，2 分钟），签名密钥是那个项目的 `ticketKey`，负载多两个字段 `sv`、`sk`：`{ kid, k: 'conn', p, u: 'service:render@<instanceId>', r: <登记表里的角色>, sv: 'render', sk: <公钥编号>, dn, g, ug: 1, exp, iat }`。
- `hosted.ticket` 的分发点：代成员进项目的服务（`actsFor: 'member'`）的票据，以及 `conversation`、`delegation`、`purpose` 三个字段位，由第四段实现；本段遇到就回 `unsupported`（第 8 节）。
- 票据负载另带 `sk`：签发时服务所用公钥的 `kid`。撤掉这把公钥后，凭它签出的票据（连接与素材）当场失效，在线的连接被关。

### 1.4 数据连接

服务凭票据（`promptcut.ticket.<票据>`，现有路径）进项目的空间。握手对带 `sv` 的票据先看三样：登记表里还有这个服务与票据的 `sk`、角色与登记表一致；项目没在搬迁；项目对这个服务的开关开着（否则 401，日志 `reason` 为 `service-revoked` / `service-disabled`）。然后按登记表的 `actsFor` 分两支〔裁：主会话 2026-10-06〕：

- **`self`（渲染服务）**：票据的 `u` 必须是这个服务的保留用户名。**不查名单、不查禁入表**（它不是成员）。principal：`{ userId: 'service:render@<instanceId>', tenantId: projectId, scope: 'service', service: 'render', serviceKid, username: 'service:render', deviceId, deviceName, creator: false, role: 'render', conversation: null, owner: null }`。
- **`member`（云端 Agent 服务）**：票据的 `u`、`ug` 是成员的，`u` 不许是保留用户名。**照成员查名单与禁入表**，踢人、移出名单对它和对成员自己的票据一样生效。principal 是那位成员的（`scope: 'member'`）再带上 `service`、`serviceKid`。这种票据由第四段在目录的分发点里签；本段实现并测了握手这一支（HR7）。
- 带 `service` 字段的连接，不论 `scope`，一律走第 1.5 节的白名单。
- 接续（会话层的 `resumeGate`）与逐消息的 `gate` 都重新看开关和登记表，关掉后接续被拒。

**保留用户名**〔裁〕：以 `service:` 开头的用户名留给服务身份。`shared/create` 的创建者名、`set-list` 的名单项、进入挑战、握手证明里出现这样的用户名，按格式不对处理（挑战回伪盐）；`kick` / `unban` 的目标是这样的用户名回 `bad-message`。理由：`deviceId` 是客户端自报的，不保留的话成员可以自报 `service:render` 加同一个 `deviceId`，拼出同一个 `userId`，在队列的节点绑定、任务来源、日志里冒充它。这是一条新的校验规则，现有项目里有这种用户名的会进不来；部署前在新节点上盘点一次（只列用户名，待主会话做），有就先报告。

### 1.5 权限位：白名单

带 `service` 字段的数据连接走**白名单**，由组装层的 `gate(principal, type, msg)` 把关（核心的 `gate` 为此多传一个参数：整条消息）：不在表里的消息类型一律 `forbidden`，表里没有这个服务就全拒〔裁：新身份按「缺省拒绝」接入。现有模块里按 `scope === 'member'` 拒绝的判断（如地址登记）对新 scope 会变成放行，逐处补判断容易漏〕。按 `service` 字段查、不按 `scope`〔裁：主会话 2026-10-06〕：云端 Agent 的连接 `scope` 是 `member`。白名单是 `server/docservice/service-gate.mjs` 里的一张「服务名 → 消息类型」表，本段只有 `render` 一行，`agent` 一行由第四段填。`gate` 每条消息另重新核对登记表与开关（第 3 节）。

渲染服务（`service: 'render'`）的白名单：

| 能做 | 消息 |
|---|---|
| 报到、认领、交付 | `node.hello`、`node.active`、`queue.watch`、`publisher.hello`、`task.publish`（只许细任务，`kind: 'plan'` 回 `forbidden`）、`task.claim`、`task.progress`、`task.complete`、`task.fail`、`task.release` |
| 读项目 | `project.open`、`project.close`、`project.snapshot.get` |
| 读内容库 | `content.get`、`content.list`、`content.watch` |
| 写预渲染清单 | `content.put`，只许 `kind` 为 `snapshot-manifest`、`render-manifest`（在 `gate` 里按消息的 `kind` 判） |
| 取素材服务地址 | `service.watch` |
| 取素材票据 | `auth.ticket { kind: 'asset' }`；`kind: 'conn'` 回 `forbidden` |

明确拒绝、并各有单测的：`project.op`（现有：render 角色已拒）、`project.announce`、`project.upload`、`project.snapshot.put`、`project.follow`、`content.put` 写 `card-source` 或 `event-detail`、工具调用事件、在场状态、成本记录、`shared.*`（成员列表、创建者挑战、创建者操作）、`service.announce` / `service.withdraw`、`auth.ticket { kind: 'conn' }`、`task.unsubscribe`、`card.lock`、`hosted.*`。

- 最后一条是关键：现有的 `auth.ticket` 允许一条 render 连接给同一个 `userId` 签 `page` 角色的连接票据（成员这么做没问题，本来就是同一个人）。服务身份不拦这条，就能自己换成能改项目的连接。
- 白名单以实现时在整套演练里抓到的消息类型为准，多一种就回来改本表。

### 1.6 素材服务

- 票据仍由项目的文档服务签（语义「票据由谁签发由谁核对」不变）：服务在数据连接上发 `auth.ticket { kind: 'asset', access }`，签出的票据负载带 `sv: 'render'`。
- 素材服务对带 `sv` 的票据多一条限制〔裁：D 说「能写预渲染产物」，没说能写素材〕：写入（分片与收尾）只许进 `snap`、`px` 两个命名空间，写 `media` 回 403。读与成员相同（按哈希读，`auth-contract.md` 第 8 节的既有裁定）。素材服务的 HTTP 接口本来就没有删除（草稿里写的「删除一律 403」不需要：`auth-contract.md` 第 8 节提到的 `remove` 只是数据层的方法，没有对外的路由）。票据核对的结果多回一个 `service`，素材服务据此判。
- 关掉开关、撤销服务、删项目之后，已发的素材票据最长还有 15 分钟有效期。〔裁〕素材服务核对带 `sv` 的票据时另看一眼开关与登记表，不满足当场 401，不等过期。

### 1.7 成员列表

**接口已定死（第 4 批的界面照此读）：**

- `shared.members.list` 的 `devices` 里，以服务自己的身份进来的连接（渲染服务）单独一行，行上多一个字段 `service: 'render'`；这种行 `username` 是 `service:render`、`displayName` 同它、`creator: false`、`deviceId` 是服务的 `instanceId`、`deviceName` 是它的 `instanceName`、`conns: [{ role: 'render' }]`。界面按 `service` 字段显示为「托管方的渲染节点」，不看用户名；排在成员之后，不计入成员数，没有踢人按钮。手里有认领时 `tags.rendering` 照常为真。
- 代成员进来的服务连接（云端 Agent）不另起一行，归在那位成员的行里，`conns` 里那一项多一个 `service: 'agent'`。
- 消息顶层多一个 `hosted: { render: { available, enabled }, agent: { available, enabled } }`〔裁：主会话 2026-10-06，两种服务一个形状〕：`available` 表示这台文档服务的登记表里有这个服务；`enabled` 是本项目对它的开关（记录里没有算开）。**放本机的项目（挂载模式）没有 `hosted` 这个字段**；托管端没给登记表（旧部署）时同样没有。
- 开关变化时，订阅了成员列表的连接收到一条新的 `shared.members.list`。

---

## 2. 看到节点上所有项目

办法：**推为主，拉兜底**，都走第 1.3 节的控制连接。

- 凭证存储加变更通知（`store.onChange`）：建项目、删项目、改开关、搬迁装入与搬走，都触发目录模块重算并推 `hosted.project`。`active` 由目录模块自己的连接表算（它和别的模块一样收得到每条连接的进出）。
- 时延上限：变化发生到渲染服务开始或停止接这个项目的活，**5 s 以内**（推送是同步的，余量留给建连与报到）〔裁〕。
- 渲染服务按目录维护数据连接：`enabled && active` 的项目各一条；`enabled` 变假的，手里的认领放回（`task.release`）后关连接；只是 `active` 变假的，手里的认领做完再关。同时连着的项目数上限 16，超出时 `members` 为真的项目先连〔裁：主会话 2026-10-06，有成员在线的优先〕。上限 16〔裁：三级数字；超出的按变成 `active` 的先后排队，打日志〕。
- **对账**：控制连接每次（重）连上都重新 `hosted.watch`，拿到的 `full: true` 清单是唯一依据——清单里没有的项目关掉，新出现的连上。另外每 60 s 主动重发一次 `hosted.watch` 兜底〔裁〕。控制连接断着的时候，已有的数据连接照常干活，但续不了票据：数据连接断了要等控制连接回来才能重连。
- 新建项目：创建者的页面一连上，项目变成 `active`，渲染服务 5 s 内报到，不用任何配置。
- 没有任何成员在线：云端 Agent 代成员开的连接、它的发布连接都算「不是本服务自己的连接」，项目照样 `active`，渲染服务照样连着接活（第 5a 节）。
- 删项目：全空间连接以 4004 关闭（现有行为），目录推 `removed`。
- 文档服务重启：控制连接与数据连接都断，按退避重连后重新对账；队列重建由发布方重发（现有规则）。
- **放本机的项目不受影响**：目录模块只在独立模式挂；局域网主机不读登记表、不认服务握手。项目搬到云端后进清单，搬回本机后从清单消失。

渲染服务实际接的是哪些任务见第 5 节：它不认领桌面版发的普通计划任务，接的是带片段清单的计划——在线页面发的、低内存档发的、云端 Agent 服务发的（第 5a 节）。

---

## 3. 项目设置里的开关

**接口已定死（第 3、4 批与第四段照此用）〔裁：主会话 2026-10-06，两种托管方服务一个形状〕：**

- **存在哪**：项目的凭证记录（`auth/projects/<projectId>.json`）加可选字段 `hosted: { render?: { enabled: boolean }, agent?: { enabled: boolean } }`，没有某一项算开〔裁：只有这份记录有创建者把关；项目文档谁都能改。记录随项目搬迁，放本机时这个字段不起作用〕。有开关的服务名是 `render`、`agent` 两个（`service-identity.mjs` 的 `HOSTED_SERVICES`）。
- **谁能改**：创建者。新的创建者操作 `shared.admin { op: 'set-hosted-service', service: 'render' | 'agent', enabled: boolean, proof: { nonce, m } }`，证明的用途串里 `op` 就是 `set-hosted-service`，证明与限速同其它创建者操作；成功回 `shared.admin.ok { op: 'set-hosted-service' }`；不加代数、不断成员自己的连接。`service` 不是这两个之一、`enabled` 不是布尔值、或登记表里没有这个服务，回 `error { reason: 'bad-message' }`。
- **谁能看**：所有成员，从 `shared.members.list` 顶层的 `hosted` 看（第 1.7 节）。
- **关掉之后**：
  1. 记录落盘，目录推 `enabled: false`，握手、接续、取票据、素材票据核对从这一刻起都拒；
  2. 这个项目里这个服务的连接（按连接的 `service` 字段找，含代成员的 Agent 连接）以 4003 `service-disabled` 关闭；它持有的认领**立即**放回未认领（不等断线宽限期）〔裁；已实现：关之前由队列模块替它逐个发 `task.release`〕；
  3. 渲染服务丢掉这个项目在做的任务；晚到的完成报告按队列现有规则作废；已经推进素材服务的产物留着（按哈希寻址，无害）；
  4. 给本空间其余成员连接（不含发起操作的那条、不含服务连接）发 `shared.notice { event: 'hosted-service-changed', service, enabled }`（打开时也发），并刷新成员列表。
- **再打开**：目录推 `enabled: true`，渲染服务按第 2 节连回来。
- **界面**：项目设置里多用户协作那一组加一个勾选「托管方的渲染节点」。只在项目放云端且 `available` 时出现；创建者可改（改时照其它创建者操作验证创建者身份），其他成员只读。

---

## 4. 并发与资源上限

节点 8 核 16 GB、无交换分区、出口约 19 Mbps；同机的托管服务 PM2 上限 700 MB。产物从渲染服务推到素材服务走本机回环，不占出口带宽。下面的数字都是〔裁〕，三级，写进 `mechanism/hosting.md`；理由统一是「给文档服务与素材服务留一半以上的机器」，本机演练与新节点实测后可调。

| 项 | 值 | 手段 |
|---|---|---|
| 并发任务总数 | 2 | `maxConcurrent`（主机现有上限 4）。快照共用一条串行通道，第二个名额主要让「推产物」与「下一段渲染」重叠 |
| 同时连着的项目 | 16 | 第 2 节 |
| 工作进程 | 常驻 1 个；隔离工作进程最多再 1 个（第 7.5 节） | 管理进程 |
| Chrome | 每个工作进程一个浏览器进程（预渲染进程现有做法） | — |
| 内存 | 整组硬上限 6 GB，节流线 5 GB | systemd 的 `promptcut-render.slice`：`MemoryMax=6G`、`MemoryHigh=5G`；工作进程经 `systemd-run --scope --slice=…` 起 |
| CPU | 最多 4 核，抢占时权重是缺省的五分之一 | 同一 slice：`CPUQuota=400%`、`CPUWeight=20`；另 `Nice=10` |
| 磁盘 IO | 权重是缺省的五分之一 | `IOWeight=20` |
| 进程数 | 4096 | `TasksMax=4096` |
| 被系统杀的先后 | 先杀渲染 | `OOMScoreAdjust=500` |
| 管理进程自身 | 300 MB | PM2 `max_memory_restart`（它只量管理进程自己，见下） |

- **为什么不用 PM2 的内存上限管渲染**：`max_memory_restart` 由 PM2 的内部检查每 30 s 看一次，文档没说把子进程算进去；渲染的内存几乎都在 Chrome 子进程里。无交换分区的机器上 30 s 也太慢。所以硬上限交给 cgroup，PM2 只管管理进程的拉起。（待实现时验证：`systemd-run --scope` 在 PM2 拉起的进程里可用、子进程都落在 slice 里；Ubuntu 22.04 缺省是 cgroup v2。）
- **背压**（管理进程每 5 s 采一次）：`MemAvailable` 低于 2 GB，或本机 `http://127.0.0.1:8787/healthz` 连续 3 次超过 500 ms，或 1 分钟负载高于 8 → 通知工作进程**停止认领新任务**，手里的做完；恢复正常满 30 s 再放开。
- **超限时的表现**：
  - 并发满：不认领，任务留在队列里等；
  - 内存到节流线：内核对这一组加压，渲染变慢；到硬上限：内核在这一组里杀进程（通常是 Chrome），工作进程退出，管理进程记 `worker.exit { reason: 'oom' }`，手里的认领由队列按断线规则收回，管理进程按退避（1 s 起、翻倍、封顶 60 s）重起；10 分钟内第 3 次被杀，并发降到 1 并打 `render.degraded`；
  - CPU：被配额限住，只是慢；任务超过队列的卡死时限由队列收回（现有规则）；
  - 文档服务、素材服务不在这个 slice 里，不受上面任何一条影响。
- **没有 systemd 时必须能降级**〔裁：主会话 2026-10-06〕（Windows 上的本机演练；没有 systemd 的 Linux 容器——部署前的演练就在这样一台容器里：root、4 核 15 GiB）：没有 cgroup 上限。自检报一条 `selfcheck.warn { reason: 'no-cgroup' }`「无 cgroup 上限，只靠进程内看护」并**继续**，不是退出 78。进程内的手段照常生效：并发上限、背压、管理进程自己量工作进程整棵树的常驻内存（每 5 s，超过硬上限就结束这棵树——表现与上面「到硬上限」一致）、降优先级（`nice`）。只有新节点（Ubuntu 22.04、有 systemd）上才用 slice。
- **有成员在线的项目优先于没人在线的项目**〔裁：主会话 2026-10-06〕：没人在线的项目（靠 Agent 的连接或声明才 `active`）也占渲染并发，并发、背压的数字不变，但认领时先认 `members` 为真的项目的任务，都没有了才认没人在线的项目的；同一类里照队列现有的先后（`normal` 先于 `backfill`）。Agent 服务发的计划用补渲那一档（第 5a 节），本来就排在页面判重发的任务之后。

---

## 5. Linux 上的环境指纹与认领范围

- 指纹三项：操作系统、GPU 基础类别、Chrome 主版本（`render-node/fingerprint.mjs`）。预渲染的 Chrome 一律 `--disable-gpu` 加软件 WebGL，桌面上 GPU 类别也是 `software`；同一提交的 Chrome 主版本相同。所以云节点与 Windows 桌面的指纹**只差操作系统一项**（`linux` 对 `windows`），必然不同。
- 结果键 = 内容键 × 指纹（契约 B.1），云节点产的块与桌面、浏览器产的块键不同，不会串；一层只出自一种环境由卡片级指纹锁保证（契约 F、I）。这些都是现有机制，本段不改。
- **能认领的**：
  - 带片段清单的计划任务（在线页面的清单计划、低内存档的补渲计划、云端 Agent 服务发的补渲计划——形状相同，认领不看发布方是谁）：它来切分，按自己的指纹出细任务，再做这些细任务；
  - `requires.envFingerprint` 等于它的指纹的快照细任务（上一条切出来的，或别的 Linux 节点切的）；
  - 卡被别的环境锁着、锁定方闲置超过 30 s 且没做完：切分时按自己的指纹接手（`m7-contract.md` D2，现有规则）；
  - 预渲染小尺寸随原尺寸一并产（主机现有的 `enableSmallTier`），低内存档靠它。
- **不认领的**：
  - 桌面版发的不带片段清单的计划任务（留给发布方自己的节点，现有规则 6）；因此只有桌面成员的项目里它基本没活；
  - 指纹不是它的细任务（给桌面或浏览器环境的那一份）；
  - `requires.localMedia` 的任务（素材只在发布方本机）；
  - `requires.codeVersion` 不是它的代码版本的任务。**渲染服务必须和在线页面出自同一个提交**，否则一个任务也认领不了（第 7.4 节）；
  - 轨道流任务：〔裁〕第一版不开（不传 `--streams`）。在线浏览器没有轨道流、低内存档看的是小尺寸，开了只白耗 CPU。ffmpeg 仍然装、仍然自检，开关留着；
  - 用户卡任务：方案 A，由隔离工作进程做（第 7.5 节）；图卡任务：按第二段定的能力位报。能力位集中在一处（`render-node/host.mjs` 的 `HOST_CAPABILITIES` 旁边加托管方渲染服务自己的一张表），第二段合流后主会话再对。
- 节点 `profile` 仍是 `host`，`nodeId` 形如 `hosted-render:<instanceId>/<projectId 前 8 位>`。
- 本机演练在 Windows 上，指纹与本机桌面相同，验不出「键不串」：演练里渲染服务用现有的测试环境变量 `PROMPTCUT_TEST_ENV_FINGERPRINT` 报一个不同的指纹，真实的 Linux 指纹留到新节点上验。

---

## 5a. 没有成员在线时的预渲染

`cloud-agent-task.md`「用户体验验收」：创建者发出一个云端 Agent 任务后完全退出软件，Agent 改动的重卡由云节点渲出来、产物入库，全程不需要任何成员的设备在线；之后进来的成员看到的是渲好的画面。

**缺口**：预渲染任务现在都由页面发布（在线页面发清单计划，桌面版由本机预渲染进程发）。队列只在内存里，按发布方的连接记账。没有页面在线时没有发布方。

**两条路的比较：**

| | (a) Agent 服务每次改动落地后发布补渲计划 | (b) 渲染服务自己发现项目变了、自己发布自己做 |
|---|---|---|
| 谁知道该渲什么 | Agent 服务：执行器知道每次写入动了哪些片段 | 渲染服务要自己判断「哪些片段变了、要不要渲」，等于把在线页面的判重搬一份进来 |
| 与页面发布的重复 | 不重复：同一个结果键只有一个任务（队列现有规则） | 有页面在线时会与页面发的计划各算一遍；要另定「有页面在线就不发」 |
| 没人看的项目渲到什么程度 | 只渲 Agent 动过的片段，范围有界 | 要另定范围（整个项目？最近改的？），没人看的项目可能白渲 |
| 渲染服务的权限 | 不变（只发细任务） | 要放开发布计划任务，等于让它对「渲什么」有决定权 |
| 对队列的要求 | 发布方可以是服务身份；发布方的连接要保持到结果入库 | 无 |
| 代价 | Agent 服务多一条发布连接、一份待渲清单的持久化与超时处理（第四段做）；本段要保证计划的认领与清单写入不依赖发布方是页面 | 渲染服务多一整套变更跟踪与判重；与页面的协调规则；更多无人使用的渲染 |

**选 (a)〔裁：主会话 2026-10-06〕**：由云端 Agent 服务发布补渲计划，渲染服务认领。(b) 不做、不留接口。做法的全文在第四段的 `cloud-agent-contract.md` 第 16 节；本段这一侧要做到的（编号沿用它的 R1～R9）：

| # | 要求 | 本段怎么办 | 在哪一批 |
|---|---|---|---|
| R1 | 项目「活跃」算上别的托管方服务的连接 | 第 1.3 节的 `active`：不是本服务自己的连接都算（Agent 代成员的连接、Agent 的发布连接），外加 `hosted.demand`。「队列里有未完成的任务」不单列，理由见第 1.3 节；渲染服务手里有认领时做完再断开 | 第 1 批已做（目录模块）；「做完再断」在第 2 批 |
| R2 | `agent` 服务能以服务身份当发布方，只许发带片段清单的计划 | 队列模块对发布方的身份种类没有限制（`publisher.hello` 谁都能发，只有 `node.hello` 看角色），不用改。权限归第四段的白名单与 `hosted.ticket` 的 `purpose: 'publish'` 分发点。本段的白名单只对 `render` 禁发计划任务 | 第 1 批已留分发点；内容由第四段填 |
| R3 | 渲染服务认领它发的清单计划 | 节点侧过滤规则 6 只看「是不是带片段清单的计划」，不看发布方。加一条单测：发布方是服务身份的清单计划被主机认领并切分 | 第 2 批 |
| R4 | 发布方短暂断开不丢任务；已认领的做完照常入库 | 队列现有规则（`render-queue-contract.md` A.8、A.9）：发布方断开后有 10 s 宽限期，期内重连（会话接续不算断开）什么都不丢；超过宽限期，它的订阅被移除，**没人订阅又没被认领的任务删除，已认领的做完**。细任务是切分方（渲染服务）发布的，订阅者里有渲染服务自己，所以计划一旦被切分，细任务不随 Agent 的发布连接断开而丢。结果入库与写清单都是渲染服务自己做的，不依赖发布方在线。**第 2 批已核对代码并加单测（HR25），成立**：`render-queue/queue.mjs` 的 `planParentOf` 与建任务处——细任务的订阅者 = 切分方自己的发布方 id + 计划的全部订阅者；`tick` 里发布方超过宽限期只删它自己的订阅，订阅者清空且还没认领的任务才删。三个边界：(1) 继承只在「计划此刻正由发布这批细任务的节点认领着」时发生（主机是先发细任务、后交计划，满足）；(2) 计划**还没被认领**时发布方走了并超过宽限期，计划被撤——所以发布连接至少要保持到计划被认领；(3) 切分方（渲染服务）自己也断开超过宽限期，而发布方也不在，还没认领的细任务会被删，要发布方回来重发计划。发布方看得到的进度是「每做完一段一条 `task.done`」（帧级的 `task.progress` 不转给发布方）；发布方超过宽限期才重连的，订阅已清，重发同一个计划即可（已完成的当场补一条 `task.done`） | 第 2 批已做 |
| R5 | 发布方不是页面时，预渲染清单照样写进内容库 | 主机认领清单计划后，按那条连接的内容库写这一版的层表（`snapshot-manifest` 的 `layers:<项目文档 id>`，C10 契约第 18 节第 9 条），与发布方是谁无关；白名单允许。之后才上线的在线页面按层表找清单、直接贴，不用再发任务。加探针步骤：只有 Agent 发布方、没有任何页面，渲完后新开页面断言层是贴上的 | 第 2 批（单测）、第 6 批（探针） |
| R6 | 渲染服务、Agent 服务、在线页面同一个提交 | 第 7.4 节：三者的代码版本并排比，不一致明确告警、状态里可查 | 第 2、3 批 |
| R7 | Agent 服务要能知道渲染开关 | `hosted.project` 与 `hosted.projects` 的每一项带 `hosted: { render, agent }`；成员列表顶层同形状 | 第 1 批已做 |
| R8 | 用户卡 | 方案 A：清单里含用户卡的片段由隔离工作进程做 | 第 5 批 |
| R9 | 一个 200 片段的计划最坏多久 | 见下 | — |

**R9 的估计（先估算，第 6 批用探针实测后修正）。** 记号：一段快照 60 帧（`SNAPSHOT_SPAN`）；快照共用一条串行通道，一次只渲一段，并发 2 的第二个名额只让推产物与下一段渲染重叠。

- 总时长 ≈ 切分（一两秒）+ Σ 每段（帧数 × 单帧耗时 + 推送）。
- 片段长度：取 5 秒、30 帧每秒，即 150 帧、3 段。200 个片段约 600 段、3 万帧。
- 单帧耗时没有云节点上的实测，只有两个旁证（`m7-contract.md` 第 3.4 节）：浏览器里一张每帧 40 ms 的卡 60 帧约 3 秒；Lottie 卡 60 帧约 50 秒。云节点是软件渲染、限 4 核，按比桌面慢取值：一般的重卡每帧 100 ms，很重的每帧 800 ms。推送走本机回环，每段按 1 秒。
- **一般情况**：600 × (60 × 0.1 + 1) ≈ 70 分钟。**最坏**（全是很重的卡）：600 × (60 × 0.8 + 1) ≈ 8 小时。同机还有别的项目在渲、或背压暂停时再往上加。
- 所以「保持到入库最多 30 分钟」对 200 个片段的计划**不够**。给第四段的建议：(1) 不用固定时长，按「多久没有进度」判（计划与细任务的完成通知一直在来就续，连续 10 分钟没有任何完成才算失败）；(2) 仍要一个总上限的话，按片段数算，每个片段给 2.5 分钟（200 个约 8 小时），或者把每个计划的片段上限从 200 降到 20 上下（一般情况约 7 分钟，最坏约 50 分钟）；(3) 一轮对话实际动到的片段通常是个位数到二三十个，这个量级下 30 分钟在一般情况够、最坏不够。
- 这些数的不确定度是倍数级的：片段更长、卡更重、节点被别的项目占着，都会成倍变化。实测办法：第 6 批的 `hosted-render-load-probe` 加一步，发 20 个片段的清单计划（内置重卡），量从发布到层表写入的时长，再按片段数线性外推。

---

## 6. 渲染服务产物的容量

`TODO.md`「托管端与远程素材服务的产物容量」只解决其中「渲染服务自己产生的部分」。

- **记账**在托管组合的素材服务里做（它才看得到写入）：凡是凭带 `sv: 'render'` 的票据写成的块，记一条 `{ ns, hash, size, projectId, at }`，追加到 `<托管数据目录>/assets/.service-usage/render.ndjson`，启动时回放成内存表；同一个块被几个项目写到（内容相同）就记几个项目。成员写的块不记、不归这里管。
- **上限**〔裁：主会话 2026-10-06〕：`min(20 GiB, 托管数据目录所在盘总容量的四分之一)`，`PROMPTCUT_HOSTED_RENDER_CAP_BYTES` 可改。新节点系统盘 39 GB，实际约 9.7 GiB。
- **到上限**：素材服务对渲染服务的写入回 507 `service-quota`；渲染服务把任务报失败（不重试）、暂停认领 10 分钟并打 `render.quota`。成员的写入不受影响。已实现：产物库（`artifact-transfer.mjs` 的 `createAssetSink`）认出素材客户端重试用尽后抛的 `status === 507` 且 `body.error === 'service-quota'`，改抛不可重试的 `service-quota`；主机（`render-node/host.mjs`）见到任务以它失败就让全部项目暂停认领 `QUOTA_PAUSE_MS`（10 分钟），工作进程与管理进程各打一条 `render.quota`，`/status` 的 `quotaPausedUntil` 可查（HR26）。
- **记账的两条细则**（`claude/render-service-ops` 已实现）：成员后来也写了同一个块，这个块就不再只归渲染服务（不计入它的用量、不由它的淘汰删）；写之前已由成员入库的块不记。
- **淘汰**，两条：
  1. 删项目时：这个项目名下的记账条目去掉，不再被任何项目记着的块删除。
  2. ~~超过上限的 90% 时按最久没人在线淘汰~~ **不交付，另立专项**〔主会话 2026-10-06 据 `claude/render-service-ops` 的核对〕：它的前提不成立——清单里列着、块却稳定 404 时，在线页面不会按「没有产物」重新发补渲，只当成暂时错误。专项的前提是先让页面与低内存档在块缺失时重新发补渲；在那之前只交付「到上限即停」与第 1 条。

---

## 7. 常驻形态

### 7.1 进程与入口

- PM2 应用 `promptcut-render`，fork 模式、1 个实例，入口 `server/hosted-render/main.mjs`（管理进程）。与 `promptcut-hosted` 是两个独立进程，互不重启对方。
- 管理进程：读私钥 → 自检（7.3）→ 控制连接（1.2、1.3）→ 起工作进程 → 维护项目清单、背压、内存看护、诊断。它不引 Vite、不跑任何卡片代码，只用 Node 内置模块与 `server/auth/`、`server/render-node/` 里的传输。
- 工作进程：`scripts/render-host.mjs`（现有入口）加一种**代理模式**：环境变量 `PROMPTCUT_RENDER_BROKER=http://127.0.0.1:<端口>` 与 `PROMPTCUT_RENDER_BROKER_KEY=<每次启动随机>`。这时不读 `PROMPTCUT_SHARED_CONFIG`，改向管理进程的本机代理口要东西：
  - `GET /projects`（长轮询）：这个工作进程现在该连哪些项目；
  - `POST /ticket { projectId }`：一张连接票据（管理进程转 `hosted.ticket`）。每次建新会话取一张，与桌面版「页面每次交一张 render 票据」是同一做法（`auth-contract.md` 第 11 节）。
  
  工作进程里**没有私钥、没有任何项目的口令或 `K`**，只有两分钟的票据。`createRenderHost` 要能在运行中增删项目（现在的成员表在构造时定死）。
- 退出：管理进程收到 SIGTERM → 工作进程放回认领（现有 `/api/frames/queue/release`）→ 结束进程树 → 退出码 0。PM2 `kill_timeout` 20 s。
- 诊断：管理进程 `GET http://127.0.0.1:<端口>/status`（只绑回环）回目录状态、各项目连接与计数（沿用 `render-host-contract.md` 第 3 节的字段）、资源读数、背压状态、最近一次自检；不含票据与密钥。

### 7.2 配置项

| 环境变量 | 缺省 | 管什么 |
|---|---|---|
| `PROMPTCUT_RENDER_DOC_URL` | `ws://127.0.0.1:8787` | 文档服务的本机地址（直连，不经 nginx） |
| `PROMPTCUT_RENDER_SECRETS` | `/var/lib/promptcut/render-secrets` | 私钥目录 |
| `PROMPTCUT_RENDER_DATA` | `/var/lib/promptcut/render` | 工作进程的数据目录（帧库、临时目录、卡片同步） |
| `PROMPTCUT_RENDER_PORT` | 5400 | 工作进程的端口（另占 +1、+2）；隔离工作进程用 5410 |
| `PROMPTCUT_RENDER_STATUS_PORT` | 5399 | 管理进程的诊断与代理口 |
| `PROMPTCUT_RENDER_MAX_CONCURRENT` | 2 | 第 4 节 |
| `PROMPTCUT_RENDER_MAX_PROJECTS` | 16 | 第 2 节 |
| `PROMPTCUT_RENDER_MEMORY_MAX` / `_HIGH` | `6G` / `5G` | 第 4 节 |
| `PROMPTCUT_RENDER_CPU_QUOTA` | `400%` | 第 4 节 |
| `PROMPTCUT_RENDER_USER` | 空（部署模板写 `promptcut-render`） | 工作进程用的系统用户，只在有 systemd 时经 `systemd-run --uid` 生效；空表示与管理进程同一用户 |
| `PROMPTCUT_RENDER_CGROUP` | `auto` | `auto`：有 systemd 与 cgroup v2 就用 slice；`off`：不用 |
| `PROMPTCUT_RENDER_MEM_LOW` | `2G` | 背压的可用内存线 |
| `PROMPTCUT_RENDER_DOC_HEALTH_URL` | 由 `DOC_URL` 推出 `http://…/healthz` | 背压用的文档服务自检地址 |
| `PROMPTCUT_RENDER_EDITOR_DIR` / `_EXPECT_CODE_VERSION` / `_AGENT_STATUS_URL` | `/opt/promptcut-hosted/editor` / 空 / 空 | 比代码版本用（第 7.4 节） |
| `PROMPTCUT_RENDER_REPORT_TIMEOUT_MS` | 180000 | 工作进程起来后这么久没交过诊断（或中途停交）就结束它重起 |
| `PROMPTCUT_RENDER_STREAMS` / `_VERBOSE` | 不设 | `1` 开轨道流；`1` 把工作进程的输出原样转出来 |
| `PROMPTCUT_RENDER_SAMPLE_MS` / `_SKIP_CHECKS` | 5000 / 空 | 测试与演练用：采样间隔；跳过自检里的 `chrome`、`ffmpeg` |
| `PROMPTCUT_RENDER_USER_CARDS` | `isolated` | `isolated`（方案 A）或 `off`（方案 B） |

PM2 配置由部署脚本生成、放在部署目录里，不含任何秘密（同 `hostedPm2Config`）。

管理进程交给工作进程的环境变量（不由部署配置）：`PROMPTCUT_RENDER_BROKER`、`PROMPTCUT_RENDER_BROKER_KEY`（代理口与这次启动的随机口令）、`PROMPTCUT_CARD_SYNC=0`、`PROMPTCUT_VITE_CACHE_DIR=<PROMPTCUT_RENDER_DATA>/vite-cache`（Vite 的依赖预构建缓存；发布目录属 root、工作进程以服务用户跑时检出目录它写不了，`vite.config.ts` 与 `vite.prerender.config.ts` 认这个变量，不设时行为与原来相同）；其余 `PROMPTCUT_RENDER_*`、集群令牌、`PROMPTCUT_SHARED_CONFIG` 一律不传。

### 7.3 Chrome 沙箱与启动自检

- **沙箱**：`server/bakery/chrome.mjs` 加自动判断——进程以 root 运行（`process.getuid?.() === 0`）、或在容器里（存在 `/.dockerenv` 或 `/run/.containerenv`）、或环境变量 `PROMPTCUT_CHROME_NO_SANDBOX=1` 时，启动参数自动加 `--no-sandbox`，并打一行日志说明；`PROMPTCUT_CHROME_NO_SANDBOX=0` 则无论如何不加。**只在 Linux 上判**：Windows、macOS 的启动参数与原来逐项相同（HR20 钉住）。`PC_CHROME_ARGS` 照旧可追加。自检结果的 `chromeSandbox` 写 `on` 或 `off:<原因>`，关着时另有一条 `no-sandbox` 告警。
- 〔裁：主会话 2026-10-06〕两种跑法**都必须支持**：root 或容器里直接跑（自动带 `--no-sandbox`，任务书第 21 条的原文要求，部署前的容器演练就是这样跑）；以及部署模板推荐的非 root 用户。非 root 是推荐值，不是前提。
- 〔裁〕**推荐的部署**：工作进程用专门的非 root 用户 `promptcut-render` 跑（无登录权限的服务用户），Chrome 的沙箱照常开着。理由：它要执行别人写的卡片代码；Puppeteer 的文档把 `--no-sandbox` 称为强烈不建议的最后手段。这个用户读不到托管数据目录与私钥目录（都是 0700）。自动加参数只是在只能以 root 跑的环境（测试容器）里兜底。（待实现时验证：Ubuntu 22.04 上非 root 用户的 Chrome 能用用户命名空间沙箱；Puppeteer 文档说 AppArmor 的限制从 23.10 起才有。）
- **自检**（管理进程启动时做，也可单跑 `node server/hosted-render/main.mjs --check`）。每项失败打一行 `selfcheck.error { reason, detail }`（同时写 stdout 与 stderr），全部项跑完后只要有一项失败就以退出码 78 结束，不带病接活：

| `reason` | 查什么 |
|---|---|
| `node-version` | Node ≥ 22.18 |
| `service-key` | 私钥文件在、权限不宽于 0600、格式对 |
| `data-dir` | 数据目录可写；其下的 Vite 缓存目录 `vite-cache` 同样可写 |
| `no-chrome` / `chrome-launch` | 找得到 chrome-headless-shell；真起一次、开一个空白页（带上面的沙箱判断） |
| `no-cjk-font` | 在刚起的 Chrome 里把「中」「国」各画到画布上比位图：没有中文字体时两个字都是同一个缺字方框（或都不画），位图相同；报错信息写明要装 `fonts-noto-cjk`（实现时改的：量宽度在等宽的缺字方框上分不出来） |
| `no-ffmpeg` | `ffmpeg -version` 能跑；没有 H.264 编码器只告警（轨道流第一版不开） |
| `registry` | 控制连接握手成功（登记表里有这把公钥） |

  另有两项只告警、不退出（打 `selfcheck.warn { reason, detail }`，状态里可查）〔裁：主会话 2026-10-06〕：

| `reason` | 查什么 |
|---|---|
| `no-cgroup` | 没有 systemd / cgroup v2：无 cgroup 上限，只靠进程内看护（第 4 节） |
| `code-version` | 自己的代码版本（`frameCode`）与在线页面、Agent 服务的不一致（第 7.4 节）。启动时比一次，之后每 5 分钟比一次；不一致期间状态里 `codeVersion.match` 为假，日志每 10 分钟重复一条 `render.code-mismatch` |

  `registry` 一项失败时不退出，按退避重试（文档服务可能正在重启）；`--check` 不做这一项（不连文档服务），只做上表其余各项：过了退出码 0，不过 78，`deploy-render` 换 `current` 之前先跑它。另有两条只告警的：`no-sandbox`（Chrome 关着沙箱在跑，写明原因）、`no-h264`（ffmpeg 没有 H.264 编码器）。

  **工作进程的看护**（第 2 批加）：进程在、也打过就绪，却超过 `PROMPTCUT_RENDER_REPORT_TIMEOUT_MS` 没向管理进程交过诊断（队列节点没起成，例如探环境时 Chrome 卡住；本机演练里遇到过一次），管理进程打 `render.worker-stalled` 并结束它重起（`worker.exit` 的 `reason` 是 `stalled`）。PM2 配置里写 `stop_exit_codes: [78]`，自检不过就停着不反复拉起（待实现时验证这个选项在节点的 PM2 版本上有效；无效就改用带退避的重启）。

### 7.4 部署目录、依赖与升级

- **跑完整仓库加依赖**，不是托管端那份精简清单：工作进程要 Vite 转译卡片与页面（`draft_cloud-node-and-agent.md`「云节点上照旧跑 Vite」）。托管组合的部署清单（`server/hosted/files.mjs`）不变，只是因为第 1 节的改动要重新部署一次。
- 布置：

```
/opt/promptcut-render/
  releases/<提交前 12 位>/    仓库在那个提交的完整内容（本机 git archive 打包上传，不含 .git）＋ node_modules ＋ Chrome
  current -> releases/<…>     PM2 的 cwd
  pm2.config.cjs
/var/lib/promptcut/render/           工作进程的数据，属主 promptcut-render
/var/lib/promptcut/render-secrets/   私钥，属主 root，0700
```

- 系统包（`apt-get install`，任务书第 22 条允许）：`fonts-noto-cjk fonts-noto-color-emoji fonts-liberation ffmpeg`，加 Puppeteer 文档列的 Chrome 运行库（见「依据」）。Chrome 用 `npx puppeteer browsers install chrome-headless-shell` 装进发布目录，版本由仓库锁定的 puppeteer 决定。
- 部署脚本：`scripts/remote/docservice.mjs` 加 `install-render`（系统包、建用户与目录、建 slice 单元）、`deploy-render`（上传、`npm ci`、装 Chrome、`--check`、换 `current`、`pm2 startOrReload`；**加 `--save` 才 `pm2 save`**）、`status-render`、`keygen-render`、`stop-render`（停掉渲染服务进程）、`rollback-render`（`current` 换回上一份再重载）。`--check` 退出码 78 时 `deploy-render` 什么都不换。`npm ci` 在节点上跑（本仓库「不跑 npm ci」的规矩说的是本机 worktree）。
- **升级**：新提交放进新的 `releases/` 目录，自检过了才换 `current`、重载；上一份留着，回退就是换回去再重载。重载时手里的认领先放回。
- **与在线页面、Agent 服务同一提交**：任务的 `requires.codeVersion` 来自发布方（在线页面嵌入的代码版本；Agent 服务按它自己的检出算），渲染服务按自己的检出算（`frameCode`，换行统一成 LF，不含用户卡）。不同提交时它一个任务都认领不了，队列也不报错。所以三者要出自同一个提交。**不能静默**〔裁：主会话 2026-10-06〕：管理进程从两处取对方的代码版本——在线页面的取部署目录里 `editor/` 构建嵌入的版本（配置项 `PROMPTCUT_RENDER_EDITOR_DIR`，缺省 `/opt/promptcut-hosted/editor`；取不到时可用 `PROMPTCUT_RENDER_EXPECT_CODE_VERSION` 直接给）；Agent 服务的取它诊断口报的版本（配置项 `PROMPTCUT_RENDER_AGENT_STATUS_URL`，第四段定地址，没配就不比）。与自己不一致就按第 7.3 节告警，并写进 `/status` 的 `codeVersion: { self, editor, agent, match }`。`status-render` 把三者并排打出来，不同就标红。
- **PM2 存档与开机自启**〔裁：主会话 2026-10-06〕：`deploy-render` 带 `--save` 时成功后 `pm2 save`；`pm2-<用户>.service` 没装时 `pm2 startup systemd`（与 `deploy-hosted` 相同）。这两步写在部署脚本里，并在 `server/hosted/deploy/README.md` 里写明手工做法与核对办法（`systemctl is-enabled pm2-root`、`pm2 resurrect` 之后 `pm2 list` 里有 `promptcut-render`）。节点重启后是否真的自动起来，由主会话最后在新节点上定怎么验。
- **被杀与重启**：进程被杀由 PM2 拉起（`autorestart`）；节点重启由已装的 `pm2-root` 服务按 `pm2 save` 的清单拉起，所以部署成功后要 `pm2 save`。起来之后走自检、控制连接、对账，自动恢复接活。

### 7.5 用户卡的隔离（方案 A）

- 常驻工作进程**不同步任何卡**（`PROMPTCUT_CARD_SYNC=0`），只做不要卡片代码的任务。它不执行任何项目带来的代码。
- 某个项目的内容库里有 `card-source`（常驻工作进程连上后列一次，并订阅变化）时，把这个项目标成「要隔离」报给管理进程。这个项目需要卡片代码的任务由**隔离工作进程**做：
  - 同一时刻最多一个，只连这一个项目，代理口只给它这一个项目的票据；
  - 有自己的检出副本（`releases/<…>` 的拷贝，`node_modules` 链回去）、自己的数据目录与端口；开卡片同步；
  - 这个项目 60 s 没有它能做的任务就结束；换项目之前把检出副本里装进来的用户卡与整个数据目录清空；
  - 几个项目都在等时轮流，每个最多 5 分钟一换〔裁〕；
  - 与常驻工作进程同在一个 slice 里，合起来受第 4 节的上限。
- 这样，卡片代码即使把隔离工作进程完全拿下，拿到的也只是它自己那个项目的只读票据与渲染服务的产物写权限——卡片作者本来就是那个项目的成员。
- 隔离不了的面，用探针断言而不是推断（第 10 节 P-iso）：恶意用户卡读不到别的项目的内容、读不到私钥、请求工作进程的本机接口拿不到文件系统上的东西、请求云厂商的元数据地址不通。差什么补什么，补不上的写明。

---

## 8. 为第四段留的口子

通用的（本段实现，第四段直接用）：

- 登记表：一个服务一把密钥，角色写在登记表里；加一项 `"agent": { "role": "agent", "keys": […] }` 即可，渲染服务的私钥冒充不了它；
- 握手与挑战（1.2）、控制连接与目录模块的 `hosted.watch` / `hosted.ticket`（1.3）、票据的 `sv` 字段、`scope: 'service'` 的 principal、保留用户名（1.4）；
- 权限按服务名查白名单（1.5）：白名单是一张「服务名 → 允许的消息类型」的表，本段只填 `render` 一行；
- 成员列表行上的 `service` 字段（1.7）；
- 管理进程的做法：私钥只在管理进程里，干活的进程只拿短期票据。

第四段的契约（`cloud-agent-contract.md` 第 4.7 节）对通用骨架提的要求，第 1 批已落实的〔裁：主会话 2026-10-06〕：

| # | 要求 | 落实 |
|---|---|---|
| 1 | keygen 能给任意登记的服务名生成 | `--service render \| agent \| <别的>`，私钥目录由 `--secrets` 指定；`agent` 缺省 `--role agent --acts-for member` |
| 2 | `hosted.watch` 的 `enabled` 按订阅的服务取 | 是；每项另带 `hosted: { render, agent }` |
| 3 | 开关的形状统一 | 记录 `hosted: { render: { enabled }, agent: { enabled } }`、操作 `set-hosted-service { service, enabled }`、成员列表顶层 `hosted: { render: { available, enabled }, agent: { available, enabled } }`、通知 `hosted-service-changed { service, enabled }`；`agent` 那一半的数据结构与读写已做，`available` 就是登记表里有没有 `agent` |
| 4 | 白名单按连接的 `service` 字段查 | 是；有 `service` 字段的连接一律走白名单，表里没有这个服务就全拒（`agent` 一行现在不存在，所以全拒） |
| 5 | 握手对带 `sv` 的票据分两种 | 按登记表的 `actsFor` 分支：`self` 不查名单与禁入表；`member` 照成员查名单、禁入、踢人。没有写死服务名 |
| 6 | `hosted.ticket` 的分支与 `hosted.delegate.verify` 的分发点 | 留好了：`conversation`、`delegation`、`purpose`、`actsFor: 'member'` 的服务要票据、`hosted.delegate.verify`，都回 `unsupported`；控制连接的白名单里已有 `hosted.delegate.verify` |

第四段从含本段的集成分支出发往里填的地方：`service-gate.mjs` 的 `SERVICE_ALLOW.agent`（以及发布连接要用的另一种权限，它自己定怎么区分）；`modules/hosted.mjs` 的 `ticket`（分发点的那个判断）与 `delegateVerify`；`handshake.mjs` 里 `member` 那一支要不要带 `access`（现在的 principal 字段表 `PRINCIPAL_EXTRA` 里没有它）；`tickets.mjs` 的 `verifyTicket` 现在对带 `sv` 的成员票据允许 `c`、`o`、`cr`，`acc` 之类的新字段由它加校验；`auth.ticket { kind: 'delegate' }`。

仍留给第四段定的（本文不替它定）：

- `agent` 服务的白名单里有哪些消息；发布连接与代成员的连接怎么区分权限；
- 委托票据与对话委托的形状与核对；
- Agent 服务的素材读写范围；
- 「创建者特权」第四项的措辞扩成「开关托管方在这个项目里的服务」。

---

## 9. 语义改写的逐字稿

D 用户已定。实现阶段照此落；第二段（决定 C）会改 `product/platforms.md` 同一张表的「纯浏览器」一行，合流时两处并存，互不覆盖。

### 9.1 `product/hosting.md`（二级）

**修改前**（「不是什么」一节）：

> 不是文档服务，也不是素材服务：不排序、不记版本，不保存项目内容和素材字节，不签发票据（票据由项目的文档服务凭项目凭证签发）。不是计算服务。

**修改后**：

> 不是文档服务，也不是素材服务：不排序、不记版本，不保存项目内容和素材字节，不签发票据（票据由项目的文档服务凭项目凭证签发）。不是计算服务；托管方在同一台云节点上另跑的渲染节点见下一节。
>
> ## 托管方的渲染节点
>
> 云节点上的渲染服务是托管方自带的渲染节点（见 `platforms.md` 的「渲染节点」）。
>
> - 它自动为放在这台节点上的所有项目服务，不用逐个配置项目凭证：新建的项目不做任何设置它就开始接活，项目删除或搬回本机后它随之退出。没有任何成员在线时它照样工作：云端 Agent 改动的重卡由它渲好，之后上线的成员直接看到结果。
> - 它只有渲染身份：能读项目和素材、能写预渲染产物，不能改项目内容，不在成员名单里；成员列表里显示为「托管方的渲染节点」。它用的是托管方自己的服务身份，不是任何成员的项目凭证；素材票据仍由项目的文档服务签发。
> - 项目创建者可以在项目设置里关掉它（见 `../workflow/project.md` 的「多用户协作」）。关掉后它不再接这个项目的活，已经产出的预渲染结果留着。
> - 放本机的项目不受它影响。
> - 它有并发与资源上限，不拖慢同一台节点上的文档服务与素材服务；它产出的预渲染结果有容量上限。认证办法与各项数字见 `../mechanism/hosting.md`。

### 9.2 `product/platforms.md`「渲染节点」（二级）

**修改前**（表）：

> | 节点 | 是什么 | 能认领什么 |
> |---|---|---|
> | 本机 PC | 桌面应用的预渲染进程 | 全部：快照、轨道流、用户卡、图卡 |
> | 独立渲染主机 | 局域网或远程主机上的预渲染进程，不带编辑界面 | 全部；可以同时为多个项目、多个用户取活 |
> | 纯浏览器 | 在线浏览器模式的后台舞台 | 只认领当前登录用户自己产生的、不需要本机转码的快照任务，且一期只限内置卡片 |

**修改后**（加一行，其余不动）：

> | 托管方的渲染节点 | 云节点上托管方自带的独立渲染主机 | 放在这台节点上、创建者没有关掉它的所有项目的任务；不用配置项目凭证 |

**修改前**（表后的条目）：

> - 加入共享项目的桌面应用自动成为这个项目的渲染节点，可以认领本项目任何成员发布的任务。

**修改后**（在这一条后面加一条）：

> - 加入共享项目的桌面应用自动成为这个项目的渲染节点，可以认领本项目任何成员发布的任务。
> - 托管方的渲染节点（见 `hosting.md`）自动为云节点上的所有项目服务。它只有渲染身份：能读项目和素材、能写预渲染产物，不能改项目内容，不在成员名单里，成员列表里显示为「托管方的渲染节点」。项目创建者可以在项目设置里关掉它；放本机的项目不受它影响。它的运行环境与桌面不同，产出的结果与桌面、浏览器节点的结果不混用（见 `rendering.md` 的「不同环境的结果不混用」）。

### 9.3 `workflow/project.md`（一级）

**修改前**（「多用户协作」里）：

> - 项目设置里另有「搬到云端」「搬回本机」。

**修改后**（在这一条后面加一条）：

> - 项目设置里另有「搬到云端」「搬回本机」。
> - 项目放云端时，项目设置里另有一个勾选「托管方的渲染节点」，缺省勾上：云节点上托管方的渲染节点为这个项目做预渲染。项目创建者可以取消，取消后它不再接这个项目的活；其他成员看得到这一项，不能改。放本机的项目没有这一项。

**修改前**（「项目设置」一节）：

> 名称、画幅比例与方向、帧率、分辨率、主题、创造力等级；多用户协作的开关、放在本机或云端、进入方式与创建者信息。

**修改后**：

> 名称、画幅比例与方向、帧率、分辨率、主题、创造力等级；多用户协作的开关、放在本机或云端、进入方式与创建者信息；放云端时另有「托管方的渲染节点」的开关。

**「创建者特权」一句**〔裁：主会话 2026-10-06，直说是第四项〕。`workflow/project.md`「多用户协作」里，修改前：

> - 创建者特权只有三项：改项目密码、名单或邀请码，删项目，踢人；其余操作所有成员一样。

修改后：

> - 创建者特权只有四项：改项目密码、名单或邀请码，删项目，踢人，开关托管方的渲染节点；其余操作所有成员一样。〔裁：决定 D 的直接后果，主会话 2026-10-06，待用户合入前审〕

`product/document-service.md`「共享项目与权限」里，修改前：

> - 创建者特权只有三项：改项目密码、名单或邀请码，删项目，踢人，每次都要出示创建者用户名和创建者密码。其余操作所有成员一样。

修改后：

> - 创建者特权只有四项：改项目密码、名单或邀请码，删项目，踢人，开关托管方的渲染节点，每次都要出示创建者用户名和创建者密码。其余操作所有成员一样。〔裁：决定 D 的直接后果，主会话 2026-10-06，待用户合入前审〕

（第四段合流时把第四项扩成「开关托管方在这个项目里的服务（渲染节点、云端 Agent）」，那是它的事。）

### 9.4 `mechanism/hosting.md`（三级）

文末新增一节（全文都是本次的〔裁〕；数字见本契约第 1～7 节）：

> ## 托管方的服务身份与渲染节点
>
> 从属于 `../product/hosting.md` 的「托管方的渲染节点」。契约 `../../plan/hosted-render-contract.md`。
>
> **服务身份。** 托管方在云节点上跑的服务各有一对 Ed25519 密钥。文档服务只存公钥（数据目录 `secrets/services.json`，服务能拿到的连接角色也写在这里，不由服务自报）；私钥只在服务自己的目录里，在节点上生成、不离开节点。服务凭一次性随机数加签名握手，只认真正从本机发起的连接；握手得到的身份不进任何项目，只能看目录、要票据。集群令牌不参与，也不进数据面。换钥时两把公钥并存，不用重启文档服务；撤掉公钥后这个服务的连接随即关闭。〔裁〕
>
> **进项目。** 服务按目录为每个项目要一张连接票据（两分钟有效，由那个项目的票据密钥签，标明是哪个服务、凭哪把公钥），凭它进项目的空间。以自己的身份进项目的服务（渲染服务）不是成员：不查名单与禁入表，身份上标明是服务。代成员进项目的服务（云端 Agent）用的是那位成员的身份，名单、禁入、踢人照成员办。哪种服务属于哪一类写在登记表里。以 `service:` 开头的用户名留给服务，成员不能用。〔裁〕
>
> **权限。** 带服务标记的连接能发的消息按白名单放行，不在表里的一律拒绝，没有白名单的服务什么都不能发。渲染服务能报到、认领、交付，能读项目与内容库，能写预渲染清单，能取素材票据；不能提交项目操作、不能写卡片源码、不能做创建者操作、不能给自己签别的角色的连接票据。它的素材票据只能往预渲染产物的两个命名空间写，不能写素材原件。〔裁〕
>
> **目录。** 文档服务把「放在这台节点上的项目、每个项目对各服务的开关、此刻有没有活、有没有成员在线」推给服务：建项目、删项目、改开关、搬迁，5 秒内生效。服务每次重连取一份完整清单对账，另每 60 秒重取一次。服务只连有活的项目：项目里有不是它自己的连接（成员，或别的托管方服务），或别的托管方服务声明过有活；最后一条这样的连接离开 60 秒后断开，手里的任务做完再走。同时最多连 16 个，有成员在线的项目优先。〔裁〕
>
> **开关。** 每种托管方服务一个，存在项目的凭证记录里，缺省开，只有创建者能改，改时照创建者操作验证身份。关掉后：这个服务在这个项目的连接立即关闭，手里的任务放回队列，票据（连接与素材）当场失效，已产出的结果留着。〔裁〕
>
> **没有成员在线时。** 云端 Agent 改动了重卡而没有任何页面在线时，由 Agent 服务发布与低内存档同一种补渲计划，渲染服务认领、渲完写进预渲染清单；之后上线的成员直接贴上，不用再发任务。没人在线的项目排在有成员在线的项目之后。〔裁〕
>
> **资源。** 渲染服务与托管服务是两个独立进程。并发任务 2 个；渲染的全部进程放在一个资源组里：内存硬上限 6 GB（5 GB 起限速）、CPU 最多 4 核且抢占时权重是缺省的五分之一、磁盘 IO 权重同样是五分之一，系统内存不够时先杀它。本机可用内存低于 2 GB、文档服务的自检连续三次超过 500 毫秒、或负载高于 8 时，它停止认领新任务，手里的做完，恢复 30 秒后再认领。超过内存上限时渲染进程被结束，任务回到队列，进程按退避重起；10 分钟内三次就把并发降到 1。〔裁〕
>
> **环境与认领。** 云节点是 Linux，环境指纹与桌面不同，结果键不同，结果不混用。它认领在线页面与低内存档发的带片段清单的计划任务、按自己环境切出来的快照任务，并产小尺寸；不认领桌面版发的计划任务、别的环境的任务、要用发布方本机素材的任务；轨道流任务第一版不接。它必须与在线页面出自同一个代码提交，否则认领不到任务。〔裁〕
>
> **用户卡。**（方案 A 的写法；选方案 B 则改为「第一版不接用户卡任务」）有用户卡的项目只在按项目隔离的渲染进程里做：一次只做一个这样的项目，只拿这一个项目的票据，换项目前清空装进来的卡。常驻的渲染进程不装任何项目的卡。〔裁〕
>
> **产物容量。** 渲染服务写成的块单独记账，上限 20 GiB 且不超过磁盘的四分之一。到上限时它的写入被拒、暂停认领，成员的写入不受影响。删项目时清掉只归这个项目的块；超过上限的九成时，按项目最近有成员在线的先后清最久没人用的项目，24 小时内有人在线的不清。〔裁〕
>
> **常驻。** PM2 管一个管理进程，它持私钥、连目录、起渲染进程并看护资源；渲染进程用专门的非 root 用户跑，Chrome 沙箱照常开着，只能以 root 或在容器里跑时才自动关沙箱。启动先自检（Node 版本、私钥、数据目录、Chrome 能否启动、中文字体、ffmpeg），缺了明确报错并停下。它跑的是完整仓库加依赖，按提交分目录部署，换代靠切换链接，上一份留着回退。〔裁〕

### 9.5 其它文档（不属于语义，实现阶段一并改）

- `auth-contract.md`：第 5 节加「服务身份」一项、第 6 节 principal 加 `scope: 'service'` 与 `service`、第 7 节加 `set-hosted-service` 与成员列表新字段、第 8 节票据加 `sv` 与素材服务的两条限制；各处指向本文。
- `render-host-contract.md`：加一节「代理模式」（第 7.1 节）。
- `hosting-migration.md`：补渲染服务的迁移与重建（装系统包、建用户与目录、`keygen-render`、`deploy-render`；数据目录 `render/` 不用拷，是可重建的缓存；私钥不拷，新节点重新生成并登记；`secrets/services.json` 随托管数据目录过去后要把旧公钥撤掉）。
- `server/hosted/deploy/README.md`：加渲染服务一节与 slice 单元模板。
- `architecture.md`：不用改（扩展点表里「预渲染 → 任意渲染节点」已覆盖）。

---

## 10. 测试与演练

### 10.1 单测（前缀 `HR`，放 `server/test/`）

| 编号 | 内容 |
|---|---|
| HR1 | 登记表解析：缺文件、坏 JSON、服务名与 `kid` 不合格、公钥长度不对；修改时刻变了重读；撤掉公钥后在线的服务连接被关 |
| HR2 | 服务握手：签名对 → 控制身份；签名错、`nonce` 复用或过期或绑定不符、`kid` 不在表里、服务名不在表里 → 401，且与口令错同样计入限速；与别的鉴权项并给 → 401 |
| HR3 | 来源：带非回环的 `X-Forwarded-For` / `Forwarded` / `X-Real-IP`、或对端不是回环 → 401（`PROMPTCUT_TRUST_LOOPBACK` 为 0 或 1 都一样）；挂载模式下一律 401 |
| HR4 | 控制身份逐个发全部数据面消息类型（照 AU11 的做法逐个列出）→ 全部 `forbidden`；只有 `hosted.watch`、`hosted.ticket` 通 |
| HR5 | 目录：建项目、删项目、改开关、成员进出，各推一条正确的 `hosted.project`；`active` 的 60 s 保持（注入时钟）；重新 `hosted.watch` 得到完整清单；`active` 的新判据——服务自己的连接不算、别的服务的连接与 `hosted.demand` 算、没有成员在线也 `active`；`enabled` 按订阅的服务取、`hosted` 带出另一种服务的开关 |
| HR6 | `hosted.ticket`：票据带 `sv`、`sk`、角色取登记表；项目不存在、开关关着、搬迁中各回对应原因；带 `conversation`、`delegation`、`purpose`，或代成员的服务来要，回 `unsupported` |
| HR7 | 数据连接：凭 `sv` 票据进入，principal 字段齐；限定进入的项目不在名单里也能进；成员伪造不了（没有 `ticketKey` 签不出 `sv` 票据；成员的 `auth.ticket` 签出的票据不带 `sv`）。代成员的服务票据（`actsFor: 'member'`）：得到成员身份加 `service`，照成员查名单、禁入、踢人，形状与登记表对不上的进不来，白名单全拒，关 Agent 开关只关它的连接 |
| HR8 | 白名单：表内每种消息都通；表外逐个列出都 `forbidden`——`project.op`、`project.announce`、`project.upload`、`project.snapshot.put`、`project.follow`、`content.put` 写 `card-source` 与 `event-detail`、事件、在场、成本、`shared.members`、`shared.challenge`、`shared.admin`、`service.announce`、`auth.ticket { kind: 'conn' }`；`task.publish` 发 `plan` 被拒；提交前后项目内容与版本号不变 |
| HR9 | 保留用户名：`shared/create`、`set-list`、进入挑战（回伪盐）、握手证明里用 `service:` 开头的用户名都进不来；`kick` / `unban` 这种目标回 `bad-message` |
| HR10 | 素材票据：`sv` 票据读任意命名空间通；写 `snap`、`px` 通；写 `media` 403；删 403；开关关掉或公钥撤掉后同一张票据当场 401 |
| HR11 | 开关：`set-hosted-service` 带创建者证明生效，不带、证明错、非创建者 `forbidden`；不加代数、成员连接不断；关掉后服务连接以 4003 关闭、认领立即回到未认领、握手与接续被拒、成员收到 `shared.notice`；再开后能进 |
| HR12 | 成员列表：服务连接的行带 `service: 'render'`、不带创建者标记；顶层 `hosted` 字段；放本机（挂载模式）没有这个字段 |
| HR13 | 空间隔离：服务在项目甲的数据连接看不到项目乙的任何消息与内容（AU9 的做法） |
| HR14 | 日志与错误回包里不出现私钥、签名、`nonce`、票据原文（AU13 的做法） |
| HR15 | 旧行为保持：没有登记表时，现有 `auth-*`、`sp-hosted`、`render-host*`、`docservice-*` 测试全过，行为与改前相同 |
| HR16 | `createRenderHost` 运行中加项目、减项目：减的时候放回认领；并发总闸与串行通道的规则不变（RH 系列不退步） |
| HR17 | 管理进程的项目维护：清单变化 → 连接增减；16 个上限与排队；控制连接断开时已有连接不动；重连对账 |
| HR18 | 背压与内存看护：注入读数 → 暂停与恢复认领；超过硬上限 → 结束工作进程、退避重起、三次后并发降为 1 |
| HR19 | 自检：每个 `reason` 各一例（注入找不到 Chrome、起不来、没有中文字体、没有 ffmpeg、私钥权限过宽等），退出码 78；全过时退出码 0 |
| HR20 | Chrome 参数：root、容器标记、环境变量三种情况自动带 `--no-sandbox`，普通用户不带（注入 `getuid` 与文件探测） |
| HR21 | 容量：`sv` 写入记账、成员写入不记；到上限 507 且只拦服务；删项目清只归它的块、几个项目共有的块不清；按最久没人在线淘汰、24 小时内在线的不清 |
| HR25 | 没有成员在线时的预渲染（第 5a 节）：发布方是服务身份的清单计划被主机认领并切分；发布方断开超过宽限期后，已切出的细任务不丢、已认领的做完、层表照写；有成员在线的项目先认领 |
| HR26 | 产物到了容量上限：素材服务回 507 `service-quota` 时产物库抛不可重试的错、任务按不可重试失败、主机全部项目暂停认领 10 分钟、到点恢复 |
| HR27 | 工作进程起来了却不交诊断的判定；Vite 缓存目录在数据目录下并进自检 |
| HR22 | 部署脚本的纯函数：PM2 配置、slice 单元、远端脚本的文本（照 `sp-hosted` 里测 `hostedDeployScript` 的做法），里面没有任何秘密 |
| HR23 | 隔离工作进程的编排（方案 A）：有 `card-source` 的项目只交给隔离进程；一次一个；换项目前清空；轮流的 5 分钟 |
| HR24 | 界面：项目设置里开关的显示条件（放云端且 `available`）、创建者可改、成员只读（组件测试） |

### 10.2 新探针（放 `scripts/probes/`）

- **`hosted-render-probe.mjs`**：整套演练的驱动，分步（`--step`），每步输出一行 JSON。验收标准写在文件头。
- **`hosted-render-isolation-probe.mjs`**（P-iso）：一张恶意用户卡加一张恶意图卡，在渲染服务里被渲染时去读——别的项目的内容、私钥文件、托管数据目录、工作进程本机接口能给出的文件、代理口、云厂商元数据地址；全部读不到才算过。
- **`hosted-render-load-probe.mjs`**：满载渲染时量文档服务的往返时延与素材下载速度，前后对比。本机跑出相对值，绝对数字到新节点上量。
- **`hosted-render-evict-probe.mjs`**：第 6 节的前提——清掉块之后，在线页面与低内存档重新发补渲、最终贴上。

不退步要跑的现有探针与测试：`render-host-probe`（H1～H3）、`shared-project-probe`、`m7-browser-probe`、`c10a-online-probe`；`npm test` 全量；`npx tsc -b --force`。

### 10.3 本机整套演练怎么搭

全部在本机回环上，端口用分配的段：托管组合 8794（文档）/ 8795（素材），渲染服务的工作进程 5730（另占 5731、5732），隔离工作进程 5733（另占 5734、5735），管理进程诊断口 5736，在线页面的开发服务器 5737（另占 5738、5739）。

1. 临时数据目录下起隔离的托管组合（`startHostedCombo`，`trustLoopback: false`，带一把临时集群令牌——与新节点同样的配置，保证演练里回环不被当本机）。
2. `keygen` 生成服务密钥，登记表写进这份数据目录。
3. 起渲染服务管理进程，指向 8794；设 `PROMPTCUT_TEST_ENV_FINGERPRINT` 让它的指纹与本机桌面不同。
4. 用在线构建的页面（无头 Chrome）与桌面节点（`render-host-probe --role creator` 那一套）扮成员。

### 10.4 任务书第 23 条逐项对应

| 第 23 条 | 本机演练的步骤 | 只能在新节点上验的 |
|---|---|---|
| 低内存档打开含重卡的项目，补渲被云节点认领、产物贴上 | `--step lowmem`：手机仿真的低内存档页面进项目，断言补渲计划被 `service:render` 认领、清单与小尺寸入库、页面贴上（截图） | 真实 Linux 指纹与中文字体下的画面；经公网的页面 |
| 在线普通档把判重的层交给渲染节点，云节点接了、结果贴回 | `--step online`：普通档页面发清单计划，断言由渲染服务切分并完成，页面贴上 | 同上 |
| 含用户卡、图卡的任务它能渲 | `--step cards`：方案 A 下带用户卡的项目由隔离工作进程完成；图卡按第二段定的规则；加 P-iso | Linux 上软件 WebGL 跑图卡 |
| 新建项目不做配置就接活；关开关后不接；删项目后断开 | `--step lifecycle`：新建 → 5 s 内诊断里出现这个项目并认领；`set-hosted-service` 关 → 5 s 内连接关闭、之后发布的任务它不认领；再开；删项目 → 连接 4004、清单里消失 | 在新节点上用测试房间重做一遍 |
| 用它的身份提交一次编辑，被拒 | `--step forbidden`：探针拿到服务的数据连接，发 `project.op` 与 HR8 的其余各项，全部被拒，项目版本号不变 | 在新节点上重做 `project.op` 一项 |
| 进程被杀后自动拉起并恢复接活；节点重启后自动起来 | `--step kill`：结束工作进程 → 管理进程重起、对账、继续认领；结束管理进程 → 由探针扮 PM2 重起后恢复 | PM2 的拉起；节点重启后的 `pm2 resurrect`（要不要真重启节点由主会话定，重启会中断托管服务） |
| 满载时文档服务响应时间与素材下载速度的前后对比 | `hosted-render-load-probe`，本机相对值 | 新节点上的真实数字（8 核 16 GB、19 Mbps 出口） |
| 资源上限生效：超过并发或内存上限时的表现 | `--step limits`：并发——发多于 2 的任务，断言同时持有不超过 2；内存——把硬上限调到很小，断言工作进程被结束、任务回队列、退避重起 | cgroup 的 `MemoryMax`、`CPUQuota` 真实生效（本机是 Windows，用的是管理进程自己的看护） |

另外只能在新节点上做的：`install-render` 装系统包；非 root 用户下 Chrome 沙箱能否启用；`systemd-run --scope` 与 slice；自检在真实环境里全过；与在线页面的代码版本一致。

---

## 11. 文件清单

新增：

| 文件 | 内容 |
|---|---|
| `server/auth/service-identity.mjs` | 登记表读写与重读、服务挑战与握手核对、用途串、保留用户名的判断 |
| `server/docservice/modules/hosted.mjs` | 目录模块（`hosted.watch`、`hosted.ticket`） |
| `server/docservice/service-gate.mjs` | 「服务名 → 允许的消息类型」白名单 |
| `server/hosted-render/main.mjs` | 管理进程入口 |
| `server/hosted-render/{keygen,directory,broker,worker,limits,selfcheck,isolation}.mjs` | 密钥生成、控制连接客户端、本机代理口、工作进程的起停与看护、背压与内存、自检、隔离工作进程的编排 |
| `server/hosted-render/deploy.mjs` | PM2 配置、slice 单元、远端脚本的纯函数 |
| `server/asset-store/service-usage.mjs` | 第 6 节的记账与淘汰 |
| `server/hosted/deploy/promptcut-render.slice`、`README.md` 补一节 | 模板 |
| `server/test/hosted-render-*.test.mjs` | HR1～HR24 |
| `scripts/probes/hosted-render-*.mjs` | 第 10.2 节的四个探针 |
| `docs/plan/hosted-render-contract.md` | 本文 |

修改：

| 文件 | 改什么 |
|---|---|
| `server/auth/handshake.mjs`、`protocol.mjs`、`tickets.mjs`、`http.mjs`、`store.mjs`、`asset-tickets.mjs` | 服务握手项与挑战端点；票据的 `sv`；带 `sv` 票据的握手分支；保留用户名；`store.onChange` 与 `hosted` 字段；素材票据核对回 `service` |
| `server/docservice/shared-service.mjs`、`spaces.mjs`、`modules/shared.mjs`、`modules/render-queue.mjs` | 挂目录模块与白名单；`scope: 'service'` 不进空间的判断；`set-hosted-service`、成员列表新字段、服务的 `auth.ticket`；关开关时立即放回认领 |
| `server/asset-service.ts` | 带 `sv` 票据的命名空间与删除限制；记账钩子；507 `service-quota` |
| `server/hosted/combo.mjs`、`files.mjs`、`deploy.mjs` | 读登记表、接记账与淘汰；部署清单加新文件 |
| `server/render-node/host.mjs`、`server/vite-plugin-frames.ts`（`startHostNode`）、`scripts/render-host.mjs` | 运行中增删项目；代理模式（向管理进程要项目清单与票据）；暂停认领的开关 |
| `server/bakery/chrome.mjs` | 自动沙箱参数 |
| `scripts/remote/docservice.mjs` | `install-render`、`deploy-render`、`status-render`、`keygen-render` |
| `src/editor/sync/collab.ts`、`syncManager.ts`、`MembersPanel.tsx`（及项目设置里多用户协作那一组所在的组件） | 开关与「托管方的渲染节点」一行 |
| 语义四份（加第 0 节第 2 条确认后的 `document-service.md`）、`auth-contract.md`、`render-host-contract.md`、`hosting-migration.md`、`draft_cloud-node-and-agent.md`、`TODO.md` | 第 9 节 |

**与并行分支可能冲突的地方**：

- `server/vite-plugin-frames.ts`：本段改 `startHostNode` 一段。第二段（在线执行用户卡与图卡、纯浏览器节点认领范围）可能改同一文件里的 `nodeCapabilities` 与节点报到。改动点不同函数，预计可自动合并；`nodeCapabilities` 一处本段不碰，留给第二段。
- `server/render-node/filter.mjs`、`split.mjs`：第二段会改（浏览器节点可认领用户卡、图卡）。本段不改这两个文件。
- `server/auth/`、`server/docservice/modules/shared.mjs`：第四段（云端 Agent 服务）会在本段之上加 `agent` 服务。按顺序合，第四段从含本段的集成分支出发即可；若第四段已先行开工改了这里，要人工合。
- `src/editor/sync/MembersPanel.tsx`、`collab.ts`、`syncManager.ts`：不在任务给的并行清单里（清单是 `src/editor/sync/onlineCardSources.ts`、`src/editor/dock/`），但与 `onlineCardSources.ts` 同目录，第二段若顺手动了 `syncManager.ts` 会有文本冲突。
- `server/bakery/chrome.mjs`：第一段的声音探针若加过启动参数，会与自动沙箱参数在同一个数组上相邻。
- 不碰：`src/audio/`、`src/export/`、`src/editor/sync/onlineCardSources.ts`、在线舞台与用户卡执行、`server/vite-plugin-ai.ts`、`server/agent/`、`src/editor/dock/`。

**工作量估计**（按提交批次）：

1. 服务身份、目录、白名单、开关的服务端与 HR1～HR15：改动最集中、最要小心的一批，约 1200 行代码加 1500 行测试。
2. 主机的动态项目与代理模式、管理进程、背压与内存看护、自检、Chrome 参数与 HR16～HR20：约 1300 行加 900 行测试。
3. 部署脚本、模板、容量记账与 HR21、HR22：约 700 行加 400 行测试。
4. 界面开关与 HR24：约 250 行。
5. 方案 A 的隔离工作进程、P-iso 与 HR23：约 600 行加探针 400 行；选方案 B 则这一批只剩几十行。
6. 四个探针与本机整套演练、语义与契约文档落稿。

---

## 依据

联网查证（2026-10-06）：

- PM2 进程声明：`max_memory_restart`「超过指定内存就重启」、`kill_timeout`「发最终 SIGKILL 之前等的毫秒数」、`autorestart` 缺省为真、`max_restarts` 与 `min_uptime`。该页没有列出 `uid`、`gid`、`stop_exit_codes`、`exp_backoff_restart_delay`（所以相关用法都标了待实现时验证）。https://pm2.keymetrics.io/docs/usage/application-declaration/
- PM2 内存上限：检查内存的内部任务每 30 秒跑一次；非 cluster 模式下是直接重启；文档没有说明是否计入子进程。https://pm2.keymetrics.io/docs/usage/memory-limit/
- Puppeteer 排障：Chrome 用多层沙箱保护宿主；`--no-sandbox` 是「强烈不建议」的最后手段；Ubuntu 23.10 起的 AppArmor 配置会阻止 Puppeteer 下载的 Chrome 使用用户命名空间；Debian / Ubuntu 上 Chrome 需要的运行库清单：`ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 libc6 libcairo2 libcups2 libdbus-1-3 libexpat1 libfontconfig1 libgbm1 libgcc1 libglib2.0-0 libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 libpangocairo-1.0-0 libstdc++6 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 libxtst6 lsb-release wget xdg-utils`。https://pptr.dev/troubleshooting
- systemd 资源控制（Ubuntu 22.04 手册页）：`MemoryMax=` 是硬上限，压不住时在这个单元内调用 OOM killer；`MemoryHigh=` 是限速线；`CPUQuota=` 按百分比给 CPU 时间；`CPUWeight=`、`IOWeight=` 取 1～10000，要求统一的 cgroup 层级；`TasksMax=` 限任务数。https://manpages.ubuntu.com/manpages/jammy/man5/systemd.resource-control.5.html

没有联网依据、凭经验写的（都已标待实现时验证）：Ubuntu 22.04 缺省 cgroup v2；`systemd-run --scope` 在 PM2 拉起的进程里的用法；`fonts-noto-cjk` 这个包名；PM2 的 `stop_exit_codes`。

查仓库得到的：

- 预渲染的 Chrome 一律 `--disable-gpu` 加 `--enable-unsafe-swiftshader`，只有 `PC_CHROME_ARGS` 能追加参数，没有沙箱判断：`server/bakery/chrome.mjs` 的 `CHROME_ARGS`。
- render 角色已不能提交项目操作、事件、在场状态：`modules/project.mjs` 的 `submit`、`modules/events.mjs`、`modules/presence.mjs`；`content.put`、`project.announce` 没有按角色的限制；`auth.ticket` 能给任何角色签连接票据：`modules/content.mjs`、`modules/project.mjs`、`modules/shared.mjs` 的 `ticket`。
- 组装层已有逐消息的 `gate(principal, type)` 与接续前的 `resumeGate`：`server/docservice/shared-service.mjs`、`service.mjs`。
- `spaceOf` 只把管理身份排除在空间之外，其余没有 `tenantId` 的身份落进 `local` 空间：`server/docservice/spaces.mjs`。
- nginx 模板转发时用 `proxy_bind` 与 `X-Forwarded-For`：`server/hosted/deploy/nginx-site-promptcut.conf`；`isLocalOrigin` 的判据：`server/auth/origin.mjs`。
- 独立渲染主机的成员表在构造时定死、凭证取自静态配置文件、各项目的卡装进同一个改动层与检出目录：`server/render-node/host.mjs`、`server/vite-plugin-frames.ts` 的 `startHostNode`、`render-host-contract.md` 第 7 节。
- 主机不认领不带片段清单的计划任务、认领带清单的：`server/render-node/filter.mjs` 规则 6。
- 本机素材服务已有的容量淘汰做法（第 6 节参照）：`server/asset-store/px-evict.mjs`。

---

## 实现记录

### 第 1 批（2026-10-06）：服务身份、目录、白名单、开关的服务端

已实现并有单测（`server/test/hosted-render-identity.test.mjs`、`hosted-render-access.test.mjs`、`hosted-render-actsfor.test.mjs`，工具 `hosted-render-kit.mjs`）：第 1.1～1.7、2（文档服务一侧）、3（服务端）节，HR1～HR15。

与草稿（`acbb2993`）不一致的地方，正文已按实现改过：

1. **白名单的三处内容判断放在 `gate` 里，不在各模块里。** 核心的 `gate` 多传第三个参数（整条消息）；`content.put` 的类别、`auth.ticket` 的种类、`task.publish` 里有没有计划任务，都在 `service-gate.mjs` 一处判。`modules/content.mjs` 没有改。
2. **票据多一个字段 `sk`**（签发时服务所用公钥的 `kid`），principal 多 `serviceKid`：撤掉某一把公钥时，凭它建的连接、签的票据能被准确地关掉、判无效，换钥期间两把并存时互不影响。
3. **素材服务没有删除接口**，草稿的「删除一律 403」去掉了。
4. **`active` 的判据、`hosted.demand`、`members`、`hosted` 字段**：按主会话 2026-10-06 的裁定改（第 1.3 节）。
5. **开关的形状**：`hostedRender` / `set-hosted-render` / `hosted-render-changed` 改成 `hosted` / `set-hosted-service` / `hosted-service-changed`（第 1.7、3 节）。
6. **登记表多 `actsFor`**，握手对带 `sv` 的票据分两支；白名单按 `service` 字段查（第 1.1、1.4、1.5 节）。
7. **关开关时的「立即放回认领」做到了**：队列模块加 `releaseClaims(connId)`，关连接之前替它逐个发 `task.release`；没有动队列本体。
8. **目录的连接表由目录模块自己维护**，不借共享模块的。
9. **保留用户名在进入挑战里不回 400**：照名单外的用户名回伪盐，之后握手失败（与草稿一致，这里写明）；`shared/create`、`set-list`、邀请兑换回 400 / `bad-message`，握手证明里出现记 `bad-format`。
10. **`shared/verify` 也认服务握手项**（排障用，与成员证明同一套核对）。
11. 握手日志的 `reason` 另有 `service-revoked`、`service-disabled`（带 `sv` 的票据被拒时）。

白名单的最终清单（`server/docservice/service-gate.mjs`）：

- 控制连接：`hosted.watch`、`hosted.ticket`、`hosted.demand`、`hosted.delegate.verify`（最后一个现在回 `unsupported`）。
- 渲染服务的数据连接：`node.hello`、`node.active`、`queue.watch`、`publisher.hello`、`task.publish`（不许含 `plan`）、`task.claim`、`task.progress`、`task.complete`、`task.fail`、`task.release`、`project.open`、`project.close`、`project.snapshot.get`、`content.get`、`content.list`、`content.watch`、`content.put`（只许 `snapshot-manifest`、`render-manifest`）、`service.watch`、`auth.ticket`（只许 `kind: 'asset'`）。
- `agent` 服务：没有这一行，全拒，留给第四段。

这份清单是按主机节点现在会发的消息定的，还没有在整套演练里抓过实际流量；第 2 批接上代理模式后若发现缺哪一种，回来补并加单测。

### 第 2 批（2026-10-06）：主机动态项目与代理模式、管理进程、看护、自检、本机演练

已实现并有单测（`server/test/hosted-render-service.test.mjs`，HR16～HR20、HR25～HR27；产物库的容量用例在 `artifact-transfer.test.mjs` 的 T6）与探针（`scripts/probes/hosted-render-probe.mjs`）：第 2 节（渲染服务一侧）、第 4 节（并发、背压、内存看护、有成员在线的优先）、第 5a 节 R3～R5、第 6 节「到上限」的渲染服务一侧、第 7.1～7.4 节（管理进程、代理模式、自检、代码版本告警）。

与正文原稿不一致、正文已按实现改过的：

1. **代理口比原稿多一条 `POST /report`**：工作进程每秒对账时把自己的诊断交给管理进程，管理进程不反过来请求工作进程；`GET /projects` 是每秒轮询，不是长轮询。清单项带 `members`、`drain`、`nodeId`。
2. **节点 id** 是 `hosted-render:<instanceId 前 12 位>/<projectId 去掉 sp_ 的前 8 位>`。
3. **工作进程发现管理进程没了就自己退出**（每 5 s 带口令问一次代理口：401 立即退，连续 3 次问不通也退），不留孤儿占端口。
4. **能力位集中在 `render-node/host.mjs` 的 `hostedRenderCapabilities`**：不同步卡的常驻工作进程不报 `userCards`（原来照独立渲染主机报 true，靠卡片代码身份过滤才不认领）；`graphCards` 为 false，留给第二段合流后对。
5. **自检的中文字体判据**改成比两个汉字的位图（见第 7.3 节）；自检多 `chromeSandbox`、Vite 缓存目录两项。
6. **看护多一条**：工作进程不交诊断就重起（第 7.3 节）。
7. **第 5a 节 R4 核对成立**，三个边界写进了 R4 那一格。
8. **内存超限的退出原因**：管理进程自己量到超限而结束的记 `oom`；有 cgroup 时由内核杀的那种，管理进程只看得到被信号结束（`reason: 'exit'`、`signal: 'SIGKILL'`），不计入「三次降并发」——待新节点上验证后再定要不要按信号归类。
9. **没做的**：方案 A 的隔离工作进程（第 7.5 节，`isolation.mjs`、HR23、P-iso）；现在的行为等同方案 B（含用户卡的任务渲染服务不认领）。`hosted-render-load-probe`、`hosted-render-evict-probe` 没有单独成文件：负载对比是 `hosted-render-probe` 的 `load` 步骤，淘汰一项不交付。浏览器观察端的 `lowmem`、`online` 两步（第 10.4 节前两行）没有做进探针：探针按「不依赖浏览器」写，成员一侧由 Node 扮演，发的是与在线页面、低内存档同形状的清单计划与补渲计划。

白名单：整套演练里渲染服务的数据连接实际发过的消息都在第 1 批的清单里，没有缺的。
