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
