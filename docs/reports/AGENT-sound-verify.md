# AGENT-sound-verify：声音在真实浏览器里的验收

分支 `claude/sound-verify`，起点 `e7d18340`。负责任务书第一段第 2、3、6、7、8 条。逐条结果随提交陆续补在下面。

## 状态

- 2026-10-06 开工，报告文件建立。

## 第 2 条:声音探针完整版

环境:PC(Windows 11),Chrome 152.0.7977.75(puppeteer 缓存里的 headless),dev server `127.0.0.1:5710`(本分支 worktree,临时数据目录),资产服务端口 8792/8793。浏览器带 `--mute-audio`,测试期间不向扬声器出声。

命令与结果原文:

- `node --experimental-transform-types scripts/probes/sound-effects-probe.mjs --node-only --av --out work/four-stage/sound/probe-node --asset-port 8792` → 退出码 0,48 项 PASS,0 FAIL。
- `node --experimental-transform-types scripts/probes/sound-effects-probe.mjs --av --origin http://127.0.0.1:5710 --out work/four-stage/sound/probe-full --asset-port 8792`(不带 `--node-only`,真实浏览器,带 `--av`)→ 退出码 0,`{"ok": true, "checks": 56, "errors": []}`。日志与 report.json 在 `work/four-stage/sound/probe-full*`。

探针本身修了两处(都是探针问题,不是产品缺陷):

1. 浏览器段的资产服务端口写死 5255/5256,改成 `--asset-port`(N 与 N+1);浏览器加 `--mute-audio`。
2. 浏览器段新建项目后在 3.75 秒处生成提示音,报「音效起点在项目出点之外」。这是产品的设计(总时长跟着内容走,声音尾巴不会拉长出点,见 `project-model.md`「总时长」与 `src/store/actions/sound.ts`),探针没先放内容。改成先放一张 5 秒的画面卡。

实现报告里「未在实际浏览器验证」的各项逐条结果:

| 项 | 结果 |
|---|---|
| 真实 Chromium 预览:seek / 重播 / 暂停 | 通过(`actual preview seek/replay/pause uses one persisted source`):音频元素只有一个、不是 blob、seek 后 currentTime 与时间轴一致(0.7→0.349979、1.5→1.149979,片段起点 0.35);暂停后元素均 paused。这一条只验了暂停状态下的 seek,**正在播放时的对齐由第 3 条的专项探针验** |
| 预览音量、静音、重播 | 通过(音量 0.25×片段 0.8=0.2,静音 0,重播后在播) |
| Chrome `OfflineAudioContext / renderMix` | 通过:`desktop Chromium renderMix final MP4 decoded events`,renderMix 16.6 ms,峰值 0.1299,10 个事件窗口全有能量、起点误差 ≤1 帧 |
| 在线 `browserExport` | 通过:`actual browserExport WAV-input MP4 includes audio`,150 帧、avc1.640028、audio=true;解码后 10 个事件窗口有能量、对原 WAV 波形互相关延迟在 1 帧内 |
| 浏览器 Worker 生成并入库 | 通过:真实编辑器 Worker 生成两份 WAV,经素材服务入库,原子提交两个普通音频片段 |
| 新开浏览器上下文只读持久化数据解码 | 通过(两份 WAV 解码帧数与配方一致) |
| 静音徽标截图、AV 画面像素 | 探针不覆盖,第 3 条专项探针验 |
| Windows 桌面、笔记本耗时门槛、人工试听 | 仍未测(PC 上不作数;试听归用户) |

## 第 6 条:打字动画卡逐帧比对

比对脚本 `scripts/probes/typing-card-compare.mjs`(文件头写了验收标准)。改前 = main `3da0aa0e`(临时 worktree `.worktrees/sound-verify-main`,用完删),改后 = 本分支;两边都走真实导出路径(`scripts/export-e2e.mjs` 自起 dev server、`export-frames` 逐帧截图,只有卡片层、透明底),项目 1280×720、30 fps,13~14 个用例各占一段时间轴;每边导两趟,比第二趟的 PNG 像素;两趟自己和自己的差:改前 0 帧、改后 0 帧。

### 缺陷:默认参数的普通文字,整帧边界上少一个字(核心项,已修)

第一次比对:`latin-default`、`card-default-text`、`chinese-default`、`multiline-default` 各有 1~3 帧不同(例:帧 69 改前「Hello」、改后「Hell」)。差异帧全落在 120 ms 的整数倍上(第 18、36、54、72 帧)。原因:舞台传入的 t 是帧时刻相减的秒数,`69/30 - 51/30 = 0.5999999999999999`,乘 1000 得 599.9999999999999 ms,`typingTextAt` 的「事件时刻 ≤ 已过毫秒」判不过,少显示一个字;旧实现读的是整数毫秒的钉住时钟,不受影响。

修法(`src/kernel/typingEvents.ts`):`typingTextAt` 比较时加 1e-6 ms(1 纳秒)的浮点容差,常量 `TYPING_BOUNDARY_EPSILON_MS`;补单测 `typingEvents.test.mjs`(不带修复时失败、带修复通过,已核)。字素计时、事件表本身不变。

### 修后结果(命令:`node scripts/probes/typing-card-compare.mjs --main <main worktree> --port 5714`,退出码 0)

```
帧数:改前 1330 改后 1330
PASS empty                          [same] 帧 0-44:45 帧,差异 0
PASS latin-default                  [same] 帧 51-158:108 帧,差异 0
PASS card-default-text              [same] 帧 165-230:66 帧,差异 0
PASS chinese-default                [same] 帧 237-320:84 帧,差异 0
PASS multiline-default              [same] 帧 327-404:78 帧,差异 0
PASS slow-duration-200              [same] 帧 411-500:90 帧,差异 0
PASS duration-100-frame-boundaries  [same] 帧 507-596:90 帧,差异 0
PASS part-text-typing-default       [same] 帧 603-698:96 帧,差异 0   (部件 text-typing,经组合卡)
PASS part-text-typing-chinese       [same] 帧 705-782:78 帧,差异 0
INFO emoji-zwj-default      [differs] 90 帧,差异 39 帧(首个差异帧偏移 15)
INFO combining-and-flag     [differs] 90 帧,差异 54 帧
INFO part-text-typing-emoji [differs] 90 帧,差异 36 帧
INFO pause-params           [differs] 150 帧,差异 123 帧
INFO crop-from-middle       [differs] 90 帧,差异 90 帧
PASS 用例之间的留白帧 85 帧,差异 0
```

默认参数下的普通文字(空文本、拉丁、中文、含换行、不同每字毫秒、两个部件用例)共 9 个用例、全部帧与 main 逐像素相同。

应当不同的 5 个用例逐帧说明(三联图在 `work/four-stage/sound/typing-compare/sheets/`,命令里的「文字模型」要求:按「改前只数 UTF-16 码元、忽略新参数、挂载从头打」与「改后字素事件表」推出的文字不同的帧集合,恰好等于像素不同的帧集合,五个用例全部一致):

- `emoji-zwj-default`(「Hi 👩🏽‍💻🎉 ok」):改前按码元计时,打到 ZWJ 序列中途显示一个替换符(菱形问号),整个序列要晚好几拍才凑齐;改后一个字素一拍,出现的是完整的 👩🏽‍💻。差异 39 帧,全部是改前显示残缺码元或进度落后的帧。这是用户认可的修正。
- `combining-and-flag`(「école 🇯🇵 été」):改前把组合记号当成单独一拍(先出 e 再变 é),国旗拆成两个区域指示符;改后 é、🇯🇵 各一拍。差异 54 帧。
- `part-text-typing-emoji`:同上,部件里的 emoji,36 帧。
- `pause-params`(delay 300、标点后停 400、换行后停 300、抖动 30、种子 7、第 3 字后停 500):改前没有这些参数、全部忽略,按匀速打;改后按新节奏,123 帧不同(从延迟段开始每一拍都错开)。
- `crop-from-middle`(mediaOffset 0.6 s):改前每次挂载从头打(第 1 帧是空白);改后接着 0.6 s 处打(第 1 帧已是「Cropp」)。90 帧都不同,这是「片段从中间裁切不从头重来」的预期行为。

提交见文末清单。

## 第 3 条:浏览器端预览(桌面版形态 + 在线浏览器模式)

探针 `scripts/probes/sound-preview-probe.mjs`(文件头写了验收标准)。两种形态跑同一套断言(`runSuite`):

- 桌面版形态:本分支 worktree 的编辑器 dev server(端口 5710,临时数据目录),页面 `/?editor&nosetup=1`。
- 在线浏览器模式:本机隔离的托管组合(文档服务 8792 + 素材服务 8793,只绑 127.0.0.1)+ 仿 nginx 的代理(5713 页面源、5714/5715 两个舞台源,带 `Origin-Agent-Cluster: ?1`)+ 本分支的在线构建(`vite build --mode online`)。创建者 = 桌面形态那一页,在项目设置里勾「多用户协作」放云端;成员 = 在线页面凭邀请链接加入。没连生产节点,没碰阿里云。在线一侧验的是「消费已生成入库的声音」。
- 不出声:无头 Chrome 带 `--mute-audio`;能量采样用 `captureStream → AnalyserNode`(只量不出声)。

场景用真实按钮、真实生成流程搭:打字机卡 mu-typing(0~7 s,43 字每字 90 ms)+「生成键盘声」得到的独立键盘声音片段(35 个事件)+「结尾加提示音」得到的提示音片段(时间轴上宽 40 px)+ 声画卡 av-pulse(5.2~6.2 s)经「生成声音」得到的内嵌声音。每 12 ms 采样 { 时间轴 t、元素 currentTime、是否暂停、音量、能量 }。

### 结果

- 桌面版形态:27 项断言全过(`work/four-stage/sound/preview-both-desktop-pack.log`,这次 `--mode both` 的在线段当时因探针里等上传的判断写错而卡住,我中途结束了它;之后在线段单独重跑,见下)。
- 在线浏览器模式:最后一次 `node scripts/probes/sound-preview-probe.mjs --mode online --dist <在线构建目录>` → 退出码 0,`{"ok":true,"checks":34,"fails":[]}`(含第 7 条的 2 项)。

| 断言 | 桌面版 | 在线 |
|---|---|---|
| P1 播放时元素 currentTime 与时间轴偏差 ≤0.15 s 的采样占比(键盘声 / 提示音 / 声画卡) | 329/329、33/33、83/83;最大偏差 0.132 / 0.129 / 0.068 s | 330/330、34/34、83/83;最大 0.099 / 0.128 / 0.090 s |
| P1 键盘声每个事件窗口都有能量 | 33/33 | 34/34 |
| P1 提示音、P6 声画卡有能量(峰值 RMS) | 0.098、0.073 | 0.099、0.092 |
| P2 暂停后 300 ms 内所有元素停下、能量低于阈值 | 35 个采样,0 个仍在播 | 34 个采样,0 |
| P3 真实指针拖卡尺:途中没有元素在播;松手停在指针处 | 136 个采样 0 个在播;t=2.5 | 同 |
| P4 从片段中间(1.6 s)开始播:currentTime 起点 | 1.6(不回 0),一路对齐 150/150 | 同 |
| P4 画面:停在 1.6 s 时打字机已打到第 17 个字 | 「The quick brown f」 | 同 |
| P4 中间播放时听到的事件 | 全部在 1.6 s 之后(首个 1.71 s),12/13(漏的 3.06 s 落在采样间隙) | 13/13 |
| P6 声画卡从 5.3 s 中间开始 | currentTime 起点 0.113(= 5.3 − 5.2),不回 0 | 0.100 |
| P5 静音(真实右键菜单「静音片段」) | `data-audio-muted`;宽片段(394 px)整块「已静音」标记;窄片段(40 px)外置图标;轨道头出现「1 静音」 | 同 |
| P5 静音后播放扫过:该片段没有元素在播;其他片段照常 | 0 个采样在播;声画卡能量照常 | 同 |
| P5 声画卡静音(参数面板按钮):标记出现、画面片段还在 | 是 | 是 |
| P5 恢复:三个片段的标记全撤、键盘声重新出声 | 是 | 是 |
| P6 声画卡与画面是同一个片段 | 项目里只有 4 个片段,没有第二个引用它声音的片段 | 同 |

截图在 `C:\Users\admin\Documents\PromptCut\work\four-stage\sound\preview\`:`desktop-1-playing.png`、`desktop-2-muted-playing.png`(静音标记,画面 1.73 s 时打到「The quick brown fox」)、`desktop-3-after-drag.png`、`desktop-3-restored-playing.png`;`online-1-playing.png`、`online-2-muted-playing.png`(在线模式,顶栏「成员: 2 人」,AI 栏提示在线不支持)、`online-3-after-drag.png`、`online-3-restored-playing.png`;`reopened-1-playing.png`(第 7 条)。

说明:

- 键盘声事件间隔 90 ms,浏览器元素与采样本身只有几十毫秒的量测分辨率,所以这一条证明的是「元素位置对、事件窗口有能量、没有从头重来」;事件级精确对位由第 2 条的解码波形互相关(0 样本)和第 8 条导出成片的起点误差(−3.2~+0.1 ms)覆盖。
- 在线页面上「生成声音」按钮置灰(`CardAudioForm` 里 `onlinePage()`),符合语义;在线合成是另一条改动。
- 探针自己的几处错误(不是产品缺陷),都已改:新项目缺省总时长太短,音效起点要落在内容之内(第 2 条已写);等素材上云的判断读错了字段(队列返回 `{ queue: {...} }`),导致成员在上传没完成时就加入;`until` 没有单次超时,页面求值挂住时一直等到 protocolTimeout(现为单次 30 s、protocolTimeout 180 s);最后「用 `m.url` 取 WAV」在线页上是桌面的相对地址,改成用播放时实际用的地址。

## 第 7 条:与 main 新功能的组合

- **打包保存 → 空数据目录打开**(同一探针,桌面段,`preview-both-desktop-pack.log`):真实 `packProcp()`(「打包保存」的实现)打出 `sound-project.procp`(1,262,598 字节,`missing: []`),样本在 `work/four-stage/sound/preview/sound-project.procp`。另起一台数据目录全空的桌面 dev server(端口 5716):打开前三份哈希的 `/@media/<哈希>` 全 404、媒体目录文件数 0;用 `loadProcpFile` 载入后项目完整(3 份声音素材、2 份带音效配方、1 个声画卡内嵌声音、4 个片段);三份 WAV 字节落进新目录(`/@media/<哈希>` 200,757,484 / 76,844 / 384,044 字节);在新页面里再播一遍 P1、P6 断言(`reopened:*` 9 项)全过。
- **协作项目里 Agent 生成声音,另一端听得到**(同一探针,在线段):Agent 一侧用创建者桌面编辑器的 `POST /api/mcp/call`(与 MCP 工具同一入口,`agent: 'verify-agent'`)调 `sound_generate`(提示音、1320 Hz、start 6.2),工具等到入库后返回 `succeeded`;成员页(在线模式)收到新素材与新片段,播放时 37 个采样的 currentTime 对齐 37/37(最大偏差 0.083 s)、峰值 RMS 0.115,播放用的素材服务地址取得到 WAV(200,76,844 字节)。Agent 一侧没有真跑模型,直接调工具入口。

## 第 8 条:三段样本 MP4

探针 `scripts/probes/sound-samples-probe.mjs`(验收标准在文件头;`node scripts/probes/sound-samples-probe.mjs`,退出码 0,`{"ok":true,"checks":15,"fails":[]}`)。画面是真实编辑器渲染的:桌面编辑器里用真实按钮生成声音,再走真实 `POST /api/export`(与界面「导出视频」同一后端),成片 1280×720、30 fps、H.264 + AAC 48 kHz 双声道。

| 样本 | 路径 | 时长 / 大小 | 内容 | 核对 |
|---|---|---|---|---|
| 提示音 | `C:\Users\admin\Documents\PromptCut\work\four-stage\sound\samples\sample-notification.mp4` | 3.000 s / 53,832 B | 「核心卖点」药丸卡 + 1.0 s 处提示音 | 有视频流与音频流;事件窗口 RMS 0.111;起点误差 +0.1 ms;事件前 0.2 s 无声 |
| 键盘声 | `...\sample-keyboard.mp4` | 3.000 s / 70,703 B | 打字机卡「Hello, PromptCut! 你好」+ 键盘声(18 个事件,空格静音) | 18 个事件窗口 RMS 最低 0.0172;最差起点误差 −3.2 ms;事件前无声 |
| 有声动效卡 | `...\sample-av-card.mp4` | 3.300 s / 37,921 B | 声画卡 av-pulse 三个片段(0.4 / 1.4 / 2.4 s),画面是扩散的圆环 | 3 个事件 RMS ≥ 0.0888;起点误差 +0.1 ms;事件前无声 |

每个样本旁有三张抽帧 PNG(`*-event.png`、`*-last.png`、`*-quiet.png`),事件时刻的画面都不是纯色(亮度标准差 5~24)。我看过提示音和声画卡的帧:药丸卡与蓝色圆环都是真实渲染。音色不挡验收,样本给用户听。

注:有声动效卡样本的项目时长是 3.3 s 而不是我设的 3.4 s——总时长跟着内容走(最后一个片段 2.4+0.9),这是 `project-model.md`「总时长」的设计,不是缺陷。

## 轻量验收(commit 之后在本 worktree 跑)

- `npx tsc -b --force`:退出码 0,零错误。
- `npm test`:`ℹ tests 4433 / pass 4432 / fail 0 / cancelled 0 / skipped 1`,退出码 0(日志 `work/four-stage/sound/npm-test2.log`)。第一轮是 4433 / 4431 / 1 失败 / 1 跳过:唯一失败是 `server/test/no-user-dirs.test.mjs` 的守门,新加的三个探针第一行 import 写成了 `'./../lib/no-user-dirs.mjs'`,守门要求恰好是 `'../lib/no-user-dirs.mjs'`。已改,该文件单独复跑 5/5,整轮重跑 0 失败。没碰到 `codex-auth-state` 的偶发卡死。
- `npm run build`:退出码 0(`tsc -b && vite build`;只有既有的 `INEFFECTIVE_DYNAMIC_IMPORT` 警告)。
- 没有跑全量渲染附加项(G0-R),按任务书留到最后。

## 修了的缺陷

| 文件 | 缺陷 | 修法 |
|---|---|---|
| `src/kernel/typingEvents.ts`(`typingTextAt`) | 默认参数下的普通文字,整帧边界上少显示一个字,与 main 不一致(见第 6 条) | 比较时加 1e-6 ms 浮点容差,常量 `TYPING_BOUNDARY_EPSILON_MS` |
| `src/kernel/typingEvents.test.mjs` | — | 补单测:整帧边界、每字 120 ms、多个起点的帧时刻相减值都得到完整字数;不带修复时失败,带修复通过;容差之外(差 0.001 ms)仍是上一个字 |
| `scripts/probes/sound-effects-probe.mjs` | 资产服务端口写死;浏览器段新建项目的总时长太短,第二个声音落在出点之外;无 `--mute-audio` | 见第 2 条 |

没有发现需要改产品代码的声音缺陷(预览播放、暂停、拖动、中间开始、静音与恢复、徽标、打包重开、协作听到、导出成片,桌面与在线都按预期)。

## 没做成或要注意的

- Windows 笔记本耗时门槛、人工试听、物理声卡设备延迟:没测(PC 上不作数,试听归用户)。
- 全量渲染附加项(导出确定性、快照重放、与 main 的像素比对):没跑,按任务书留到最后。第 6 条的逐帧比对只覆盖打字动画卡与 text-typing 部件。
- 最后一次整套 `--mode both` 没有一次跑完:第一次在线段卡在探针自己的缺陷上被我结束,之后桌面段与在线段分开各跑通一次(桌面 27 项 + 打包重开 + 重开后播放;在线 34 项)。两段用的是同一份探针代码,只有在线段的等待判断与最后一项取址在两次之间改过。

## 观察(不是缺陷,转给主会话判断)

- 「结尾加提示音」把提示音放在 `片段起点 + 打字稳定时刻`:若打字机片段正好只有打字那么长(片段终点 == 稳定时刻),提示音起点等于出点,会报「音效起点在项目出点之外」。这是「音效不隐式延长项目出点」的结果(语义已审过),但新手可能撞上;探针里给了 7 s 的片段所以没碰到。
- `sound_generate` 不带 `trackId` 时,提示音落在第一个放得下的序列(我的场景里落进了声画卡所在的序列),不新建「音效」序列;键盘声则新建了一条。行为一致、可预期,记一下。

## 要转交给 `claude/sound-ab` 的问题

没有发现 `server/bakery/export.mjs`、`src/export/` 里的缺陷。作为参照:桌面导出的三个样本(提示音、键盘声、声画卡)经真实 `POST /api/export` 导出,事件对位 −3.2~+0.1 ms,成片音轨 AAC 48 kHz 双声道;`browserExport` 的 WAV 输入路径在第 2 条的完整版探针里也通过。A、B 两条的用例没碰,不在我的范围。

## 更正建议(任务书与语义)

- `docs/plan/sound-online-render-task.md` 第 6 条「默认参数下的普通文字必须与 main 逐帧相同」的实际难点是帧边界的浮点误差,不是字素分词;建议在验收里点明「整帧边界(每字毫秒与帧长的公倍数)」要覆盖,已写进比对探针的 `duration-100-frame-boundaries` 与默认参数用例。
- 语义文档无冲突。

## 提交

见最终回复里的提交哈希清单(分支 `claude/sound-verify`,不推送、不合并)。临时的 main 比对 worktree `.worktrees/sound-verify-main` 已删(无 junction),临时数据目录与本机托管组合进程已清。
