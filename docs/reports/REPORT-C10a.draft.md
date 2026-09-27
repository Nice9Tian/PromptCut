> 草稿（2026-09-27 PC 主会话写，交接时带进仓库）：合入时补完、去掉 `.draft` 改名为 `REPORT-C10a.md`，并归档对应的 AGENT 报告。文中 scratchpad 路径指 PC 本机，只作记录。

# C10a 阶段报告：在线浏览器模式 demo 最小可用（草稿）

契约 `docs/plan/c10a-contract.md`（第 1 版发给用户但不等；第 16 节是开工后的裁定，`dc28209`）。

## 0. 过程
- 三个分支从 C6.6 集成分支 `claude/c66-integ` 的 `851ffe9` 拉出〔裁：与 C6.6 的 T9 重叠进行，不跳过任何验收〕；C6.6 合入 main 后合并 main。
- 测试方提出的六处空白由主会话裁定，写进契约第 16 节并告知两个实现分支。

## 1. 分支
- `claude/c10a-tests`（`opus-dev`）：53 条契约用例（邀请码 IV-01～19、低内存档 LM-01～09、能力闸 GT-01～07、MP4 MP4-01～04、预渲染小尺寸 PS-01～07、在线构建与守卫 API-01～06）加真浏览器探针 `c10a-online-probe.mjs`；假设 K1～K7 集中在 `server/test/c10a-kit.mjs`。实现不在时自动跳过（本分支 `npm test` 3126 / 3072 / 0 / 跳过 54）。用照契约写的最小参考实现自检：邀请码 20/20、判定 9/9、能力闸 7/7、小尺寸 7/7、MP4 4/4、守卫 2/2。
- `claude/c10a-web`（`opus-dev-high`，报告 `AGENT-c10a-web.md`）：提交 `3becd84`、`16ac2fa`、`3c75b59`、`acc1ba7`、`753fef1`、`1741d17`、`c25394e`。tsc 0；npm test 3098 / 3097 / 0 / 1；分支单测 邀请码 15/15、含鉴权与 C6.5 管理 127/127、部署与 sp-hosting 18/18、在线逻辑 6/6；`vite build --mode online` 与桌面 `vite build` 都成功；探针 `online-join-probe.mjs` 39/39（本机托管组合 5634/5635、代理 5633 代替 nginx、桌面编辑器 5630～5632）；截图在 scratchpad `c10a-web-shots/`。
  - 偏离契约：`invite-create` 多回 `linkOrigin`；经 `/hosted/` 的 WebSocket 地址保留末尾斜杠（nginx 对不带斜杠的 301，升级跟不了重定向）；桌面手填进入仍搜局域网（「打开共享项目」删掉后这是进入别人本机项目的唯一路）。
- `claude/c10a-lowmem`（`opus-dev-high`，报告 `AGENT-c10a-lowmem.md`，`ad321f8`…`acc3a19`）：tsc 0；npm test 3114 / 3113 / 0 / 1；verify-determinism（5640）1800/1800。探针：`lowmem-online-probe`（手机仿真 412×915、`deviceMemory: 4`、替身素材服务）ok——低内存档、只一个同源舞台 `/?stage=1&id=A&preview=stage`、没有 `/api/data/costs` 与 `/api/frames` 请求，观看时小尺寸视频 2、原尺寸视频 0、无小尺寸视频 0、`px/` 2、`snap/` 0，全带只读票据，无小尺寸的视频显示「等待上传方」角标；暂停后重卡保持抑制、显示小位图；原尺寸没到齐导出提示「等待上传方」、取消不出文件；到齐后导出 h264 60 帧 2.000 s 1920×1080 + aac 94 帧，取了原尺寸与 60 个 `snap/`、0 个小尺寸；`small-tier-probe` ok——60/60 帧有 400×225 带 alpha 的 WebP，清单 `small` 表与磁盘一致，关掉小尺寸时原 HTML、`index.json`、键逐字节不变；`lowmem-export-compare`（45 帧）——第 0 帧平均绝对误差 2.69、PSNR 32.7 dB，之后约 7.4 / 19～20 dB（颜色已对齐，残差是动画相位漂移）。
  - 主会话裁定〔裁〕：允许改 `stageClockEntry.ts`（只在 `?export=1&rafControl=1` 时手动推进 rAF，桌面导出不带参数、行为不变，G0-R 核对）；层表先查 `snapshot-manifest` 的使用方，有按种类通读的就另开 `layer-map` 种类；偏离（层表写法、小位图按卡片框、低内存档暂停与拖动也抑制重卡、显示档设置的位置与措辞、在线页面不测卡按声明判轻重）接受；web 要接的三根线（导出句柄与 `written`、在线接受同主机素材服务、加入时 `connectSharedAssets`）与「`mode.ts` 不许被 Node 单测载的模块静态引用」放进集成。
  - 没做：PNG 快照的小尺寸（C10a 没用到）；iOS 导出的最长时长与体积（待用户项）；超过 15 分钟的导出中途票据过期。
- `claude/c10a-integ`（`opus-dev-high`，从 `claude/c66-integ` `3519ca1` 拉出，报告 `AGENT-c10a-integ.md`）：提交 `ef09da6`、`9f1ef51` / `0444b00` / `6f4e35a`（三次合并，无冲突，`mode.ts` 两边 blob 同为 `247c9b4`；首次默认英文合并信息已在无后续提交时重置重做）、`03ccc9b`（kit 对账；API-03 棘轮清单 120 个；PS-07 改写、GT-02 改口径；`bootApiGuard(online)`）、`3ca5872`（`dist-online` 忽略与守门排除）、`faaa746`（`rafControl=1` 手动推 rAF；栅格化带导出页样式表）、`c697390`（导出句柄与 `written`）、`8a0a8f0`（在线认同源素材服务；守门 C10A-MODE-01/02）、`8817b5c`（在线开发服务认 `?editor`）、`3214f4c`（`online-join-probe` 修语法、加 `--with-video`）、`a6156be`（报告）。
  - 验证：tsc 0；npm test 3203 / 3202 / 0 / 1（净增 122）；C10A 53 条全真跑全过；三分支单测全过；在线与桌面构建都成功，`/api/` 路径 120 = 清单、新增 0；`small-tier-probe`、`lowmem-online-probe`（加 `8817b5c` 后）退出码 0；`c10a-online-probe` 15/15；`online-join-probe --with-video` 47 项过 46；verify-determinism（5660）1800/1800。
  - `lowmem-export-compare`（45 帧）：改前约 7.4 / 19～20 dB；只改 rAF 7.33 / 20.35 dB；rAF + 样式表 **2.22 / 34.10 dB**（推帧 0.28 s）；只带样式表对照 2.23 / 34.03 dB（推帧 13.8 s）。漂移的真因是快照省掉的 `box-sizing: border-box` 在 foreignObject 里退回 `content-box`，不是动画相位；手动 rAF 的收益是推帧从 13.8 s 降到 0.28 s。
  - 主会话裁定〔裁〕：GT-02、PS-07、`Shell.tsx` 开发入口、层表沿用现状，接受；手机上的桌面布局记进 C10 其余；**返工两项**交回集成方：① 开启「放云端」前已有的素材上云（编辑器进程加按哈希入队的接口）；② 在线页面在演示路径（打开、邀请加入、观看、改一处、导出）上不许露出被守卫拦下的 `/api` 报错，AI 栏等入口按契约隐藏或置灰，路径外剩余入口交 C10 其余。
  - 集成方发现：c10a-web 提交里的 `online-join-probe.mjs` 两个正则丢了反斜杠，原文件语法错、跑不起来（`3214f4c` 修好）；c10a-web 自报的 39/39 不是用提交进去的那一份跑的 → 以集成方重跑的结果为准。

## 2. 主会话裁定（C10a 开工后，除契约第 16 节外）
- 〔裁〕静态检查：在线构建产物里仍有 201 处 `/api/` 字符串（124 个路径），清掉要改清单外约 50 个文件。C10a 的验收按契约本意判：运行时守卫 + 网络记录里 0 个 `/api/` 请求（探针已证）。集成时把 C10A-API-03 改成「只许少、不许多」的棘轮（现有路径进清单，新出现的判红）；逐个置灰或换在线替代归 C10 其余。
- 〔裁〕`shared/challenge` 的 429 只带 `Retry-After` 头，不改 AU8；页面先读回包、再读头。
- 集成时：`dist-online` 进 `.gitignore` 与 SPR-6a、SPC6-3 的排除表；取消协作拉回素材原尺寸用带素材的项目补测；放本机一支是辅助节点窗口项。
- 已知：nginx 之后所有来源都算回环，邀请码与挑战的失败不触发限速 → HT-a。

## 2.5 合 main 与 G0-R（主会话）
- `1658e09` 把 main（含 C6.6、skill-gate 显式开启）合进 `claude/c10a-integ`，无冲突。基线：tsc 0；npm test 3243 / 3240 / 0 / 跳过 3 → 第三条是 `DEP-4`（没找到 Git Bash）；集成方 `aa9a85b` 改为 Windows 上找 Git Bash（GNU find 才用，不用 WSL 的 bash），之后 npm test 3243 / 3241 / 0 / 2（只剩 G0 允许的两条）；`npm run build` 与 `vite build --mode online` 都成功。
- G0-R（dev server 5690，`1658e09`；`aa9a85b` 只改测试）：`verify-determinism` 1800/1800；导出像素与 main 基准 total 1800 / identical 1800 / different 0 / missing 0 / extra 0（`stageClockEntry.ts` 的 `rafControl` 改动没碰桌面导出）；`verify-unified-frames` PASS；`ready-index-probe --port 5693` `fails: []`；`stream-produce-probe` 与 `--group` PASS；`preview-fallback-probe` 与 `--page-preload` 透明拍数 0（284 / 278 拍）。

## 2.6 部署（阿里云）
- 2026-09-27T05:17:27Z：从 `aa9a85b`（在 `.worktrees/merge-test` 干净检出、在线构建到 scratchpad，index.html + 84 个 assets）`deploy-hosted --save --editor <dist-online> --doc-public-url wss://8-219-80-16.sslip.io/hosted/ --asset-public-url https://8-219-80-16.sslip.io/media/api/asset`；先备份 pm2 配置为 `pm2.config.cjs.bak-20260927-c10a`。两个公网地址由新参数写对，**不再需要手工改回**。`promptcut-hosted` 重载一次；本机回环两个 healthz 200。
- nginx：备份 `/etc/nginx/sites-available/promptcut.bak-20260927-c10a`，在 `/media` 之后加 `/editor` 四段（`= /editor`、`= /editor/index.html` 回 `index.html` 带 `no-store`；`^~ /editor/assets/` 找不到回 404、`immutable`；`/editor/` 回落 `index.html`；都带 `Referrer-Policy: no-referrer`、`nosniff`；`/editor` 直接 200 不重定向），`nginx -t` 通过、`systemctl reload nginx`。
- 外网核对：`/editor` 200、`no-store`、`no-referrer`、`nosniff`；`/editor/assets/index-DAt70ZuU.js` 200、`public, max-age=31536000, immutable`；`/editor/some/deep/route` 200、内容是 `index.html`；不存在的资源 404；`/editor` 与 `/editor/index.html` 内容相同；两个 healthz 200；匿名 WebSocket 升级 401；匿名带 Range 读素材 401（「带票据 Range 206、1024 字节」由演示探针经页面核对）。

## 2.7 演示探针（集成方，契约第 12 节）
- `171180d` 新增 `scripts/probes/c10a-demo-probe.mjs`（7 步；`--local` 起托管组合与仿 nginx 的前缀代理，缺省指向阿里云），同一提交修两处产品：浏览器导出的探针入口在线时带上远程素材地址、核对没过时交回提示而不抛错；在线页面舞台握手时投一次快照。`5bc3eed` 修在线页面暂停时重卡一直是占位（快照字节到货后「重投」的回调只有双舞台设，加 `setSnapshotArrive`，`Preview` 在线时设，补单测）。`0dd86e9`、`851b340` 探针判据与排障选项（`--hold-min`、`--hold-on-fail`、`--debug-port`）；`db4c278`、`5263329` 报告第 9 节。
- `--local` 五轮：R1（`0dd86e9`）全过 971 s；R2 失败；R3（只多未提交的排障记录）全过 1189 s；R4（`851b340`）全过 414 s；R5（`851b340`）失败。
  - 全过轮次：创建者 plan 细任务全完成，重卡 300 帧、小尺寸 300 张上云，开启前导入的视频两档都到托管端；手机约 6.7 s 出低内存档提示、只 1 个舞台、重卡贴小尺寸，请求只有素材小尺寸 2 次与 `px/` 7～158 次，原尺寸与 `snap/` 都是 0；手机改一处后新键 6～10 s 到手机、新小尺寸 22～88 s 到手机、整段重渲 186～324 s；导出缺原尺寸时提示「等待上传方」不出片，补齐后 300 帧、10.000 s、h264 1920×1080 + aac，只用素材原尺寸与 `snap/`；作废后旧链接给表 A 的失效文案、新链接能进；桌面手填与粘贴链接都进；收尾删项目、`lookup` 404。
  - R2：内容库新键下 300 帧清单与小位图齐全，手机端层表键 900 s 不变（「新的预渲染小尺寸回到手机」超时）；另有 3 次 `404 /@media/<哈希>`（远程素材地址设好之前按相对地址取素材）。→ 主会话交 codex 攻坚（`claude/c10a-r2`，从 `5263329`）。
  - R5：第 4 步用了 710 s，第 5 步打开旧链接页面导航 120 s 超时；当时创建者仍在重渲、机器很忙，其它轮这一步约 2 s，按负载所致登记。
- 集成方提的 `/hosted` 末尾斜杠：阿里云 nginx 是前缀 `location /hosted` 加 `rewrite ^/hosted/?(.*)$ /$1`，带不带斜杠都转到 8787；实测 `GET /hosted` 回上游的 404、不是 301，不用改。

## 2.8 再合 main 与基线（主会话）
- `9d2d54b` 合 main `1dad2b7`（无冲突）。G0：`npx tsc -b --force` 0（无输出）；`npm test` 3247 / 3245 / 0 / 2；`npm run build` 与 `vite build --mode online` 都成功。
- G0-R（dev server 5690，`9d2d54b`；上次 G0-R 之后又改了 `snapshotFeed`、`Preview` 在线分支与 main 的换档修复）：`verify-determinism` 1800/1800；导出像素与 main 基准 total 1800 / identical 1800 / different 0 / missing 0 / extra 0；`verify-unified-frames` PASS；`ready-index-probe --port 5693` `fails: []`；`stream-produce-probe` 与 `--group` PASS；`preview-fallback-probe` 透明拍数 0（274 拍）、`--page-preload` 透明拍数 0（285 拍），`fails` 都为空。

## 2.9 R2 的攻坚与修复（`claude/c10a-r2`）
- codex 两轮（见第 4 节）后，`opus-dev-high` 在同一分支接手：`36816cc` 合 `claude/c10a-integ`（`9d2d54b`）；`3f68116` 探针记各页面整页导航与 Vite 客户端消息；`9a1b317` 舞台 RPC 的 8 秒时限不再管 K1 测量的 `setTime`（带 `probe`），补单测；`a15955c` 刷新后回到共享项目、重连后重新登记失败不退回本地素材服务、在线页 5 秒重投只在暂停时做，补单测 T5-shared-5；`1b2cf5d` 探针加第 1b 步（创建者刷新后回到共享项目），意外重载只记下；`584730f`、`8de80e1` 报告。
- 对 codex `050065d` 的复核：层表与 `px/` 兜底超时、投递界限与重投、低内存档不理迟到 `settled`、地址未就绪不取 `/@media`（那 3 次 404 的修法）、`preload` 单飞 6 分钟兜底，保留；`stageRpc` 对带 `probe` 的 `setTime` 也限 8 秒会让桌面 K1 测量在忙机上变成失败，改为只管 `setSnapshots` 与不带 `probe` 的 `setTime`；`assetTiers` 重连后第一次登记失败会把远程素材服务置空、成员退回本地素材服务且不重试，改为失败时保留原值并重试；`Preview` 播放中也每 5 秒重投，改为只在暂停时；「重载后恢复共享连接」只管放云端的创建者，换成通用做法。
- **整页重载的根因**：开发服务里 Tailwind v4 的 Vite 插件（4.3.3）扫描项目里的非模块文件（`docs/` 下的 `.md` 等），一改就不打日志、让所有页面整页重载。证据：诊断轮创建者页 09:42:41.925Z 重载，与提交报告的文件 mtime 18:42:41.883 +0900 相差 42 ms；只带 Tailwind 插件的对照开发服务里原样重写一个 `.md`，页面重载 1 次、服务端日志为空。已排除依赖预构建、探针导航、改卡写检出目录。codex 与集成方的 R2 都是边跑探针边在同一工作区写文件，很可能同源（集成方那轮没有导航记录，坐实不了）。
- **产品缺陷**：用户自己刷新同样掉出共享项目；在线页刷新后 `#invite` 已清，凭邀请码进来的成员回不去。修法：进入共享项目时在 `sessionStorage` 记项目、身份、用户名与派生的 K（不存口令、不存邀请码），刷新后开始页与直接进编辑器的页面都凭它自动重进；主动离开、被踢、被移出、项目被删、换开别的项目、回开始页时清掉；打开邀请链接时以链接为准；创建者与成员、云端与本机、桌面与在线都适用。
- 验证（`8de80e1`）：tsc 0；npm test 3257 / 3255 / 0 / 2（codex 的 8 条与接手方的 2 条单测都在输出里通过）；`c10a-demo-probe --local` 三轮全过、无负载超时、无重跑——R1 320 s、R2 380 s、R3 317 s；刷新后回到共享项目 0.98 / 1.18 / 1.01 s；新键到手机 4.1 s ×3；新小尺寸到手机 36.0 / 76.0 / 96.1 s；整段重渲 122.9 / 141.2 / 125.3 s；手机请求素材原尺寸 0、`snap/` 0；导出 300 帧、10.000 s、h264 + aac；创建者页无意外重载。G0-R（5580）：`verify-determinism` 1800/1800；像素与 main 基准 1800 帧全同；`verify-unified-frames` PASS；`ready-index-probe` fails 空；`stream-produce-probe` 与 `--group` PASS；`preview-fallback-probe` 与 `--page-preload` 透明拍数 0。
- 主会话裁定〔裁〕：「刷新后回到刷新前打开的共享项目」语义没写到，不属于「按现有语义做不下去」，照接手方的实现接受，并建议用户补进一级语义（`workflow/project.md`「多用户协作」），同时请用户审「派生的 K 按标签页放 `sessionStorage`」能否接受（发给用户但不等）；Tailwind 静默整页重载另开维护分支 `claude/tailwind-scan`（会话写文档时用户常驻的 5190 编辑器也会被重载）；探针两处小毛病（第 3 步「整段重渲完成」只要求每段有清单、三轮那一刻都是 244/300 帧；导航计数把清掉 `#invite` 这类同页跳转也算一次）不挡验收，记遗留。
- `5b2fccc`：`claude/c10a-integ` 合 `claude/c10a-r2`（`69b9f49`），再合 main `7ff0ea8`（含生成快照 id 改名线性化、C10 契约、用户新定的语义），都无冲突。
  - G0（`5b2fccc`）：`npx tsc -b --force` 0（无输出）；`npm test` 3261 / 3259 / 0 / 2；`npm run build` 成功；`vite build --mode online` 成功（index.html + 84 个资源）。
  - G0-R（dev server 5690，`5b2fccc`）：`verify-determinism` 1800/1800；导出像素与 main 基准 total 1800 / identical 1800 / different 0 / missing 0 / extra 0；`verify-unified-frames` PASS；`ready-index-probe --port 5693` `fails: []`；`stream-produce-probe` 与 `--group` PASS；`preview-fallback-probe` 透明拍数 0（286 拍）、`--page-preload` 透明拍数 0（287 拍），`fails` 都空。
  - 顺带发现：同一提交在两个工作区做在线构建，9 个分块哈希不同。根源是在线产物里内嵌的卡片 / 部件 / render / kernel 源码原文（`src/render/cardSourceFiles.mjs` 的 `?raw` 表）按检出时的换行（CRLF 或 LF）原样进包，页面算卡片源码版本（`cardSourceVersion.mjs`，成本身份键用）时不统一换行。只影响页面本地的成本记录，不影响跨机的任务代码版本（服务端 C6.6 已统一换行）；记为 M7 之前要评估的遗留。部署用 merge-test 的干净检出（Windows 正常检出为 CRLF，与上次部署一致）。

## 2.10 部署（阿里云，第二次）
- 2026-09-27T10:26:16Z：从 `.worktrees/merge-test` 干净检出的 `5b2fccc`，在线构建到 scratchpad（index.html + 84 个资源），`deploy-hosted --save --editor <dist-online> --doc-public-url wss://8-219-80-16.sslip.io/hosted/ --asset-public-url https://8-219-80-16.sslip.io/media/api/asset`；先备份 pm2 配置为 `pm2.config.cjs.bak-20260927-c10a2`。部署退出码 0；部署脚本里「回环 8787 healthz」那一步因进程尚未监听连不上，随后核对：外网 `/hosted/healthz`、`/media/healthz` 200，服务器上 8787 回环与私网地址 200，`promptcut-hosted` online、这次部署重载一次（restarts 6）。
- 外网 `/editor`：index.html 的 sha256 与部署产物相同（`f451fc44…`），响应头 `Cache-Control: no-store`、`Referrer-Policy: no-referrer`、`X-Content-Type-Options: nosniff`；主脚本 `assets/index-BmNXYstw.js` 外网 200、4,222,231 字节，与本地相同。
- 外网演示第 1 轮（2026-09-27T10:35:43Z～10:44:33Z，`5b2fccc`，创建者 dev server 在 merge-test 干净检出、端口 5660）：`ok: false`，只挂第 2 步「超时:手机上重卡贴着预渲染小尺寸」。其余各步：创建者 plan 5 任务全完成，刷新后 1.5 s 回到共享项目；手机低内存档提示出现、只 1 个舞台、请求素材小尺寸 4 次、原尺寸 0（经素材服务）、`px/` 5、`snap/` 0；第 3 步改一处后新键 7.4 s、新小尺寸 83.4 s 到手机（新键 276 帧小尺寸齐）；第 4 步缺原尺寸时不出片（等待 4 次），补齐后导出 300 帧、10.000 s、h264 1920×1080 + aac 469 帧，请求素材原尺寸 292、`snap/` 300、小尺寸 0；第 5 步旧邀请被拒、新邀请能进；第 6 步桌面手填与粘贴都进；第 7 步删项目、`lookup` 404。
  - 第 2 步诊断：手机重卡层就绪 2 段、115 帧，`picks`、`mounted` 空，舞台 `pc-suppressed`、`imgs` 0；在线来源 `mapFetches` 28、`manifestFetches` 57、`smallFetches` 4、`errors` 0。创建者那一步重卡 300 帧、小尺寸 295（本机三轮都是 300/300）。手机另有 2 次 `404 /@media/1904c75c…`——素材**原尺寸**的哈希、相对地址。
  - 判断：三处 C10a 产品问题，阿里云延迟大才暴露——渲染节点任务完成却缺小尺寸（契约第 9 节要求两档都推送成功才算完成）；手机一段清单缺几帧小尺寸就整段不用（语义是缺哪帧只占位哪帧）；低内存档请求原尺寸且走相对地址。交 `opus-dev-high`（`claude/c10a-aliyun`，从 `5b2fccc`）查修，修好后重新部署、再跑外网一轮。

## 3. 验收
（填：G0、G0-R、契约测试、本机替身 demo、低内存档逐帧导出、桌面加入表单、真手机扫码=待用户项）

## 4. 顾问调用记录
| 阶段 | 用途 | 问题 | 结论 | 采纳 |
|---|---|---|---|---|
| C10a | 查资料（codex，`gpt-6-sol`/`high`，只读联网） | 7 题 | `docs/plan/c10a-research.md`；thread `01a0dfb6-89e5-7350-b6c3-b68e3c41a096` | 采纳，契约第 13 节 |
| C10a | 交互与文案（Gemini，`gemini-3.1-pro-high`） | 加入表单、多用户协作、低内存档提示与 18 个待定点 | `docs/plan/c10a-ux-draft.md` | 核对后采纳，契约第 14 节 |
| C10a | 攻坚（codex worktree，`gpt-6-sol`/`high`） | 演示 R2：手机端层表 900 s 不更新；相对地址取素材 404 | thread `01a0e1d3-f195-7782-8599-66011ae576d7`，两次各跑满 1800 s 时限没跑完三轮演示；失活路径审计与多处修复（层表与 `px` 请求兜底超时、`preload` 单飞超时、`setSnapshots` 回包界限与重投、服务登记重试、地址未就绪不取 `/@media`），故障注入单测先红后绿，npm test 一度 3249/3247/0/2；最后查到创建者页在第 1 步整页重载后 `startSync()` 接回本地默认项目 | 主会话把源码与测试改动原样提交为 WIP `050065d`（调试脚本与探针输出不进提交），交 `opus-dev-high` 在同一分支复核、做完、验证 |

## 5. 待跨机复核项 / 待用户项
- 待用户项：真手机扫码（iPhone 相机、微信各一次，契约第 12 节）。
