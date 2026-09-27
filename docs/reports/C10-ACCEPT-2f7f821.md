# C10-A 本机验收（提交 2f7f821）

派活方：「PromptCut 主会话（PC）」。在 C10 最终集成提交 `2f7f821` 上跑一遍 C10-A1～A10 本机验收（验收表照 `docs/archive/agent-reports/AGENT-c10-integ.md`「C10-A 本机验收」），逐条原样记结果。机器 PC，端口段 5840～5849，工作区 `.worktrees/c10-accept`（分支 `claude/c10-accept`），各探针一条一条串行跑。机器很忙（跑探针时 CPU 负载约 87%，另有 chrome 33 个、node 57 个、ffmpeg 4 个进程），计时数字只作参考。带耗时门槛的项按 `verification.md`「性能基准机」标「待笔记本复核」，PC 上的数不作数。

## 在线构建

`npx vite build --mode online --outDir <scratchpad>/online-dist`：退出码 0，2.66 s。产物里嵌的代码版本 `81266bce…395b` 与 `frameCode(cwd)` 同值（在 `assets/*.js` 里找到 1 处）。只建了一次，后面各探针都用它（下表记作 `<dist>`）。

## 结果

| 编号 | 命令 | 退出码 | ok / fails | 关键数字 | 待笔记本复核 |
|---|---|---|---|---|---|
| A1 | `node scripts/probes/c10-browser-probe.mjs --dist <dist> --base-port 5840` | 0 | `ok: true`、`fails: []`、`pending: []` | 两个舞台 5841、5842 与编辑器页 5840 同站跨源，CDP 里各是独立 iframe 目标；宿主能力 A、B 都是 `measure: true, catchUp: true, prerender: false, lowMemory: false`；播放 10 秒**主文档长任务 0**；主重卡快照换了 54 帧；按拍投递 269 次；探针帧 2 帧全部 gzip 字节转移（6968 字节）、字符串 0。全程 1197 s（创建者建项目加预渲染占 1044 s） | 长任务 0 这条是时限类断言，待笔记本复核 |
| A2 | 同上 | 同上 | 过 | L2 `costs` 4、`snapshots` 91、`ranges` 2；**测完写进文档服务 4 次、4 条、失败 0**；重开：遮罩不再出现、costs 仍 4、已在 L2 的块重新请求 **0**、L2 命中 4 | 否 |
| A3 | 同上 | 同上 | 过 | 成员页 `snap/` 366、`px/` **0**；层表 v 2；每层 `envFingerprint` 都是创建者的 `258acaaa7c5fe509`；跨源舞台的 `/media` 都打自己的源（5840→5840 3、5841→5841 3、5842→5842 3） | 否 |
| A4 | 同上 | 同上 | 过 | 0.23 秒处 `fit` 7、`deadMs` 23.33，两层显示占位；播放到头点到 0.5 秒后追到精确活渲、3 秒后仍是活渲。`a4.timing`：点 0.5 秒 20752 → 暂停态互换做完 27714，**点停到精确活渲 6962 ms**；播放态互换两次都因 `rate` 不发起（积压 11119 / 12375 ms，速率 1299 / 1323） | a4.timing 待笔记本复核 |
| A5 | 同上 | 同上 | 过 | 创建者关掉后改主重卡：页面发布 `plan:<项目>@2#clips:…`、`open`、无报错；独立渲染主机（host 档、测试指纹 `0c10b0e5f1a9e7d2`、代码版本 `81266bceae79`、ws）认领 3、完成 1、失败 0；新层环境是主机指纹、就绪 60 帧；播放中快照文字 `main-v2`；A5 段 89 s。页面错误 0、控制台错误 0；收尾删了云端项目（`shared.admin.ok`） | 否 |
| A10 | `node scripts/probes/c10-browser-probe.mjs --a10 --ticket-ttl-ms 20000 --dist <dist> --base-port 5840` | 0 | `ok: true`、`fails: []` | 等原尺寸齐 1 次后导出 **300 帧**、231.4 s（票据时限 20 s）；**续签 17 次、失败 0**；素材地址换票 26 次。同一轮里 A1 的前半顺带又跑一遍：长任务 0、点停到精确 6955 ms。全程 841 s | 导出不设耗时门槛；顺带的长任务与点停时长待笔记本复核 |
| A6～A8 | `node scripts/probes/c10-ui-probe.mjs --dist <dist> --proxy-port 5840 --proxy2-port 5843 --doc-port 5841 --asset-port 5842` | 0 | `ok: true`、`fails: []` | A6：用户卡那一层的 `px/` 请求 **0**、内置卡那一层 249；徽标只在用户卡上、悬停「该模式暂不支持自定义卡」；舞台 1 个常驻「需要本地 PC 渲染辅助」；片段可选中，另一成员看得到改动。A7：导入媒体、配音、SKILL、转写字幕都 `disabled`，带表 A 文案；点击后新请求 0、页面错误 0；`/api` 守卫拦截 0、`/api` 请求 0；被覆盖提示带「下载备份」，被覆盖与离线丢弃两份备份都能下载；连不上服务器、断网、正在提交、已全部提交、素材服务断开几种提示都出现过。A8：`POST merge/…` → 501 `{"ok":false,"error":"not-implemented"}`。约 3 分钟 | 否 |
| A9 | 桌面 dev server `npx vite --port 5840 --strictPort --host 127.0.0.1`；`node scripts/probes/small-tier-probe.mjs --origin http://127.0.0.1:5840` | 0 | `ok: true`、`fails: []` | S1 60 帧 HTML + 60 张 400×225；S2 bad 0；S3 层表 1 层、键一致；S4 htmlDiff 0；41 s | 否 |
| A9 | `VITE_PC_ONLINE=1 npx vite --port 5840 --strictPort --host 127.0.0.1`；`node scripts/probes/lowmem-online-probe.mjs --origin http://127.0.0.1:5840 --remote-port 5846` | 0 | `ok: true`、`fails: []` | G1 单舞台、低内存档；G2 小尺寸视频 3、原尺寸 0、`px/` 2、`snap/` **0**（在线来源 `tier: small`、`store: true`）；G3 暂停后追一帧 217 ms 画好；G4 缺原尺寸时提示「等待上传方」，到齐后导出 h264 1920×1080 60 帧 2.000 s + aac，中心像素品红 | G3 的 5 秒时限待笔记本复核 |
| A9 | `node scripts/probes/c10a-demo-probe.mjs --local --dist <dist> --port 5840 --proxy-port 5843 --doc-port 5844 --asset-port 5845` | 0（第 2 轮） | `ok: true`、`fails: []` | 386 s。手机：小尺寸视频 3、原尺寸 0、`px/` 7、`snap/` 0；播放全抑制，停下追一帧 105 ms（暂停处 71 ms）；界限搜索 1 条记录、测 1 次、轻卡判轻，补渲 0，播放中轻卡占位；改卡后新键 6.1 s、新小尺寸 183 s、整段重渲 206 s，认领顺序 `NNNNNBB`；低内存档导出 300 帧 10.000 s + aac，`snap/` 300、素材原尺寸 3、小尺寸 0；作废邀请码后旧链接被拒、新链接能进；桌面版手填、粘贴两种加入都过 | 停下追一帧的时限待笔记本复核 |
| 成本 | `node scripts/probes/c10-cost-probe.mjs --dist <dist> --port 5840 --proxy-port 5843 --doc-port 5844 --asset-port 5845` | 0 | `ok: true`、`fails: []` | 桌面 16 张测完；3.1 s 内 16 条写进文档服务；手机 16 条记录、测 6 次（二分 4，上限 ⌈log₂(n+1)⌉+4），界限第 9 张（门槛 24.7 ms）；9 轻 7 重；补渲清单 7 张（正好是判重的）；播放中 16 层全抑制 | 否 |
| G0-R 编码 | 桌面 dev server 5840；`node scripts/probes/stream-produce-probe.mjs --origin http://127.0.0.1:5840`（不带 `--group`） | **1**（两轮都是） | `fails` 只有一条：「1080p 全幅流 15 帧分段编码 ≤ 300 ms(无别的编码器争 CPU)」 | 第 1 轮 clip-bg 1920×1080 编码 536 / 579 / 579 ms，p50 **579**；第 2 轮 502 / 573 / 648，p50 **573**；药丸 560×374 p50 186 / 174；编码器 libx264；其余各条核对全过 | **待笔记本复核**（PC 上挂，见下） |
| T4 | `node scripts/probes/tiers-probe.mjs --port-a 5843 --port-r 5846` | 0 | `ok: true`、`fails: []` | T4 窗口 6311 ms、编辑 51 次、错误 0、**> 50 ms 长任务 0**（对照窗口 3001 ms、24 次、0）；同步耗时最大 2 ms；三个素材都重封装，小尺寸 ready；队列逐个素材先小后大 | **待笔记本复核** |

看过的图：
- `a4-settled-live.png`：播放头 0.50、已暂停，几个重卡层（橙色卡、灰条、方格）都画着卡面，没有占位。
- `a4-placeholder-while-playing.png`：播放中 0.27 秒，顶上一层显示灰色占位条，其余层照常。
- `a6-1-user-card.png`：时间轴上「闪光文字」（用户卡）右上角有徽标，内置卡「金句药丸」没有；舞台中间是「需要本地 PC 渲染辅助」的小牌子。
- `a7-4-doc-down-unsent.png`：顶栏显示「连不上服务器，请稍后再试。你的修改先留在本页，恢复后会自动提交。」和「备份 1」，底部显示「当前离线，有未提交的修改。关闭页面将丢失这些操作。」

## 没过的项与判断

1. **stream-produce-probe 的 1080p 编码 ≤ 300 ms**（G0-R，带耗时门槛）：PC 上两轮 p50 分别是 579、573 ms，都挂了。判断为机器忙：这条门槛的前提是「没有别的编码器争 CPU」，而跑的时候 CPU 负载约 87%，另有 4 个 ffmpeg 在跑（别的子智能体起的）；同一探针其余各条功能核对全过。按 `verification.md`，这条在 PC 上的结果本来就不作数，**待笔记本复核**；笔记本上挂了才算真挂。
2. `c10a-demo-probe` 第 1 轮（07:38 开跑）跑到 `editor.up` 后被会话中断连带结束，没有结果、没有残留进程；07:49 重跑一轮，过。这不算探针失败。

## 进程与端口

本轮起过的进程：两轮 `c10-browser-probe`（托管组合、代理、创建者编辑器、独立渲染主机、无头 Chrome 都由探针自己收尾，结果里 `listening: []`）、`c10-ui-probe`、`tiers-probe`、两轮 `stream-produce-probe`、`small-tier-probe`、`lowmem-online-probe`、两轮 `c10a-demo-probe`、`c10-cost-probe`，以及两台 dev server（桌面版一台、`VITE_PC_ONLINE=1` 一台，都在 5840）。两台 dev server 由我按命令行核对（`vite.js --port 5840 --strictPort --host 127.0.0.1`）后，连同它们的子进程（预渲染进程、render-worker）一起结束。收尾 `netstat` 查 5840～5849 无监听，也没有本工作区或本轮探针的残留进程（此时在跑的 `m7-browser-probe` 属于别的工作区，没碰）。各探针都删了自己建的云端项目。没有碰 5190～5192、5203～5205、5690～5699，没有连阿里云。
