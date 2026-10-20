# AGENT-number-input-undo

分支 `claude/number-input-undo`(起点 main `4a8644f9`)。任务:编辑面板的数字框和滑块不再「每打一个字提交一次、记一步撤销」(用户在 0.7.18 验收中定要修)。

## 状态

完成,等主会话审。tsc 零错误、npm test 零失败、新旧探针全过。

## 现象与根因

在剪辑段属性面板把「不透明度」数字框从 1 改成 0.3:输入框每次 `onChange` 都调一次 store 动作,「0」「0.3」各提交一次。后果:一、中间的 0 真的落进项目,那一瞬间剪辑段完全透明,协作时别人也看到、还会同步出去;二、撤销要按两次。素材段 / 卡片段的开始结束、滤镜与音频效果参数、三维、卡片参数、部件树等面板是同一种写法。滑块(不透明度、缩放、旋转、音量、三维)每个 `input` 事件一次提交;store 里的 `mergeKey` 合并窗口(300 ms)只有测试在用,没有任何界面用它。

## 做法

### 1. store:撤销合并不再只认 300 ms

- `src/store/core.ts`、`src/store/docsync.ts`:`SetProjectOptions` / `CommitOptions` 加 `mergeWindowMs`(缺省仍是 `MERGE_WINDOW_MS` 300 ms;`Infinity` = 只认 mergeKey、不看时间)。快照栈模式(`core.ts` 的 `setProject`)和连文档服务模式(`docsync.ts` 的 `commit`)两处合并判据都改成用它。
- `src/store/core.ts` 新增 `withMerge({ key, windowMs }, fn)`(`project.ts` 转出):`fn` 里发生的 `setProject` 都带上这个 mergeKey。界面不必给七十多个 action 都加参数,面板里包一层即可。动作里再嵌套的多次 `setProject` 因为同 key 也会并成一步。
- 一次拖动用独一份的 key(`newGestureKey`)+ 无穷窗口:拖动中按住不动多久都还是一步;下一次拖动 key 不同,另起一步。键盘 / 箭头步进用一个按实例固定的 key + 1000 ms 滚动窗口:连按并成一步,停顿超过 1 秒另起一步。

### 2. 共用的数字框、滑块(新目录 `src/editor/fields/`)

- `numberDraft.ts`(纯函数):`formatNumber`、`settleDraft`(草稿定稿:空、「-」、非数、`validate` 不认、和显示的值一样 → 还原不提交)、`isTypingInput`(有 `inputType` 的 input 事件 = 敲字;没有 = 方向键或框自带上下箭头步进)、`reduceField`(数字框状态机:敲字 → 只改草稿;步进 → 立即提交并标记为步进;回车 → 让框失焦;失焦 → 定稿;Esc → 放弃草稿)。
- `NumberField.tsx`:逐事件喂 `reduceField`。回车同时让框失焦(这样 Ctrl+Z 马上能撤:全局撤销键在输入框有焦点时不生效)。调用方的 `onCommit(n)` 收到的是已确认的有限数;夹范围、校验、报错仍由调用方做(和以前一样)。
- `RangeField.tsx`:`onPointerDown` 开始一次拖动(窗口级监听 `pointerup` / `pointercancel` 结束);拖动中手柄跟本地的 `live` 值,项目里的值经 `createLatestThrottle` 限速(第一个立刻交,之后最快每 50 ms 交一次最新值,松手补交最后一个),这些提交共用一个独一份 key + 无穷窗口。键盘操作没有按下松开,每一下立即提交、走步进 key。
- `mergedEdit.ts`:`newGestureKey`、`commitMerged`、`createLatestThrottle`、常量(`GESTURE_COMMIT_INTERVAL_MS` 50、`STEP_BURST_MS` 1000)。

### 3. 协作同步方面

拖动中每次提交本来就是一条文档服务的 `project.op`(以前滑块每个 input 事件一条,指针移动一次一条)。现在拖动中限速到最多每 50 ms 一条(约 20 条/秒),松手补最后一条。探针里一次 41 次指针移动、中途停 400 ms 的拖动实际提交 14 条;文档服务里这些提交仍是 14 条日志,但在撤销栈里是一步。数字框输入过程里**一条都不发**,只有回车 / 失焦的那一条;步进每一下发一条(按键重复率,一般个位数),并成一步撤销。拖动中途的值是会同步出去的(协作同伴能实时看到滑块效果,和任务书「拖动过程中可以实时预览」一致),代价是上面说的限速后的条数。若要拖动中完全不发、只在松手时发一条,舞台预览就得有一套不进项目的临时覆盖层,那是更大的改动,没做。

### 4. 换过去的面板

| 面板 | 文件 | 改了什么 |
|---|---|---|
| 剪辑段属性 | `src/editor/left/CutSegmentForm.tsx` | 本地那个逐字提交的 `NumberField` 删掉,数字框与全部滑块(缩放、旋转、不透明度、音量)换共用组件 |
| 素材段 / 卡片段「开始、结束」 | `src/editor/left/Inspector.tsx` | 4 个数字框 |
| 滤镜参数 | `src/editor/left/ClipFilterForm.tsx` | 数字框 |
| 音频效果参数 | `src/editor/left/ClipAudioFxForm.tsx` | 数字框 |
| 三维 | `src/editor/left/Frame3DForm.tsx` | 旋转 / 深度的滑块与数字框、视角滑块 |
| 卡片参数 | `src/editor/left/ParamsForm.tsx` | 数字框;参数名上左右拖动微调(原来每次指针移动一步撤销)改成一次拖动一步 + 限速 |
| 部件树 | `src/editor/left/PartsForm.tsx` | 框 x / y / w / h、进场毫秒、部件参数的数字框;w / h 用 `validate` 保持「必须大于 0」 |

## 没动的数字框和滑块

`grep -rn 'type="number"' src --include=*.tsx`:

| 位置 | 为什么没动 |
|---|---|
| `src/editor/left/SoundEffectForm.tsx`(合成音效参数、固定种子) | 本来就是本地草稿,点「重新生成」才进项目,不存在逐字提交 |
| `src/editor/ProjectSettingsDialog.tsx`(总时长) | 对话框里的草稿,点「确定」才提交 |
| `src/editor/timeline/ClipVolumeDialog.tsx`(音量百分比数字框与滑块) | 对话框草稿,点「确定」才提交一次 |
| `src/editor/right/AiSetupDialog.tsx`(熔断阈值、重查间隔、自主轮次) | 设置类,不进项目;已经是失焦保存 |
| `src/StartPage.tsx`(缓存上限) | 设置类,不进项目,点「设定」才存 |

滑块(`type="range"`):`src/App.tsx` 与 `src/editor/nodes/NodeGraphTab.tsx` 的播放头、`src/editor/preview/ControlBar.tsx` 的预览音量、`src/editor/timeline/Toolbar.tsx` 的时间轴缩放、`src/voice/VoiceSettings.tsx` 的声音设置,都不改项目内容(播放头、界面状态、设置),没动。

没处理的邻居(任务书没点名,报告里提一下):`ParamsForm` 的文本框、`ColorControl` 的取色器 / 色值框、`PartsForm` 的文本框、`CodeTab` 等仍是每次变化提交一次;取色器拖动的撤销粒度问题和滑块同类,可以之后用 `RangeField` 同一套办法解决。

## 验证

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0,零错误 |
| 全量测试 | `npm test`(设了 `PROMPTCUT_ACCOUNT_PROVIDER_ROOT`、`PROMPTCUT_PASSWORD_ORDER_MODULE`,后台静默跑) | tests 7204、pass 7190、fail 0、skipped 14,退出码 0 |
| 新单测 | `node --experimental-test-module-mocks --test src/editor/fields/fields.test.mjs` | 14 条全过:草稿不提交、回车 / 失焦各提交一次且之后不重复、Esc 还原、空 / 半截 / 非数 / validate 不认 / 与显示值相同都不提交、步进每下提交并标记、限速(第一个立刻交、窗口内只交最新、flush 补交、cancel 丢弃)、快照栈模式下一次拖动(停顿 1.5 秒)只记一步且下一次拖动另起、步进滚动窗口、连文档服务模式下一次拖动一步撤销(4 条提交各发一条) |
| store 回归 | 同上跑 `src/store/docsyncStore.test.mjs`、`src/store/docsync.test.mjs` | 与新单测合计 59 条全过(`mergeWindowMs` 缺省行为不变) |
| 浏览器探针(新) | `node scripts/probes/number-input-undo-probe.mjs --origin http://127.0.0.1:5390 --out docs/reports/assets/number-input-undo`(本工作区的 vite,端口 5390;页面连着 dev server 自带的文档服务,走的是文档服务的提交与撤销) | N1～N9、M1～M5、E0 共 14 条全 PASS(下表) |
| 浏览器探针(既有) | `node scripts/probes/cut-segment-panel-probe.mjs --origin http://127.0.0.1:5390 --out ...` | P1～P9、L1、E0 全 PASS(期望已按新提交时机改:`typeInto` 敲完按回车;P4u 原来「X 三步 + Y 两步 + 缩放一步共六步」现为 X、Y、缩放各一步共三步) |

新探针各条(都在真实 Chrome 里敲键、拖动、读 store):

- N1 不透明度 1 → 0.3:敲「0」「.」「3」每一键之后项目里的不透明度都是 1、对 `updateClip` 的调用为零次;回车后恰好一次提交 0.3;撤销一次回到 1。
- N2 Esc 放弃草稿(框回到 1,失焦也无提交);N3 空值、「-」失焦不提交且显示回 1;N4 失焦提交一次、撤销一次回原值。
- N5 回车后直接按 Ctrl+Z 就撤回(回车让框失焦,全局撤销键才生效)。
- N6 方向键:ArrowDown 三次立即提交 0.95、0.9、0.85,撤销一次回 1;隔 1.3 秒再按另起一步(撤销一次只退到 0.95)。
- N7 滑块一次拖动:41 次指针移动、中途停 400 ms,提交 14 条(限速),松手后项目里是最后的值 0.11,撤销一次回到 1(拖动前)。
- N8 滑块方向键连按 3 下提交 3 次,撤销一次回 1。N9 整个过程 25 次提交,不透明度从未被提交为 0。
- M1 卡片段「结束」数字框;M2 卡片参数 `staggerMs` 数字框(blur-text 卡);M3 参数名上左右拖动(30 次移动、停 400 ms,提交 12 条,220 → 310,撤销一次回 220);M4 三维旋转滑块一次拖动(30 次移动提交 4 条、值 180,撤销一次回 0)与数字框(敲 30 时零次提交、回车一次、撤销一次回 0);M5 滤镜参数数字框。

看过的图(`docs/reports/assets/number-input-undo/`):`01-typing-0-stage-still-visible.png`(框里敲着「0」,舞台上的剪辑段仍然不透明,没有变透明)、`03b-after-enter-stage.png`(回车后 0.3,剪辑段变淡)、`02-typing-0.3-not-committed.png`、`03-after-enter.png`、`04-slider-mid-drag.png`(拖动中,手柄与数字框 0.64 同步)、`05-slider-after-drag.png`、`06-params-number-after-enter.png`、`07-frame3d-after-drag.png`、`08-filter-param-after-enter.png`、`00-panel.png`。

没跑的:
- `ClipAudioFxForm`、`PartsForm` 没有浏览器实测(要音频素材、组合卡才进得去),它们和已测的面板用同一个 `NumberField`,只是换了调用处,类型检查通过。
- `scripts/left-check.mjs`(写死 5194 端口,不在分配的端口段)没跑;它的 04 步在第一个 `data-pc-param` 上敲 123,只打印不判定。
- 导出确定性、快照重放一致、像素比对:没跑,本次没碰渲染与画面(只改编辑面板与撤销合并)。

## 对任务书、语义的更正建议

- 语义:`docs/semantics/workflow/editing.md`「撤销、重做」后加了一条(一级,标「2026-10-20 用户定」):

  修改前:无这一条。

  修改后:「一次输入、一次拖动只算一步改动(2026-10-20 用户定):在数字框里输入一个值,或拖一次滑块,只算一步改动、只记一步撤销,输入过程中的中间值不落进项目。数字框按回车或失去焦点时才算输入完成(输入过程中别人看不到,也不会同步出去),按 Esc 放弃;用方向键或框自带的上下箭头连续步进,也合并成一步。滑块拖动中画面可以实时跟着变,整次拖动(按下到松开)合成一步撤销。」

  说明:任务书原句的后半「输入过程中的中间值不落进项目」对滑块不成立(滑块拖动中为了预览,限速后的中间值是会提交的、会同步),所以我把它限定在数字框,滑块那句单写。如果用户要的是「滑块拖动中也不进项目」,见上面第 3 点的代价。
- `src/store/README.md` 没改(没有 mergeKey 的描述)。

## 部署要换什么

改了 `src/`(仅前端界面与 store 的撤销合并,没有服务端、文档服务协议、数据格式的改动):在线前端要重建,整份 `src/` 同步进渲染树;桌面版随下次发版带上。不需要动文档服务、素材服务、节点。
