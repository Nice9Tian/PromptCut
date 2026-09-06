# PromptCut 编辑器 · 契约(第二阶段)

第一阶段(DESIGN.md)验证了内核:Motion 动画 + Chrome 虚拟时间逐帧导出。第二阶段把它长成一个能用的编辑器。
**先读 DESIGN.md,再读本文。** 内核目录 `src/kernel/` 的接口仍然冻结。

## 布局(src/Editor.tsx,已写好)

```
┌ TopBar:项目名 · 播放/重播 · 撤销/重做 · 主题选择 · 导入视频/打开项目/保存项目/导出视频 ┐
├ 左栏(可拖宽)   │ 中央 Preview(视频层 + 动效渲染面,自适应缩放) │ 右栏(可拖宽)        │
│ LeftPanel       │                                              │ RightPanel(AI 助手)│
├ 底部 224px:TimelineView(多序列时间轴)                                                  ┤
```

三块面板的大小都能拖(`src/editor/ResizeHandle.tsx`,左右栏、时间轴共用同一根拖杆组件):

- 左栏宽 `pc.left.w`(默认 300,最小 200)、右栏宽 `pc.right.w`(默认 360,最小 240)、
  时间轴高 `pc.timeline.h`(默认 224,最小 120,最大窗高 70%);拖动时改 state,松手才写 localStorage。
- 中间预览始终留 `MIN_PREVIEW_W = 320`;可用宽度不够(窗口拉窄、上次存的宽度放不下)时两侧按比例收回来,
  ResizeObserver + window resize 两条路都盯着。
- 双击拖杆复位到默认值。拖动期间 `<body>` 上有 `data-pc-resizing`,
  `index.css` 靠它把预览 iframe 的 `pointer-events` 关掉,免得鼠标滑进 iframe 就断了。

四个插槽各由一个任务负责,**只暴露一个固定导出名**:`LeftPanel`、`RightPanel`、`TimelineView`,以及 `src/editor/io/index.ts` 的四个函数。Editor.tsx / TopBar.tsx / Preview.tsx 是壳,不要改;要壳配合的地方在回报里提。

## 左栏:两级分页(src/editor/left/)

```
顶级   素材 | 编辑
二级   素材 → 卡片 / 视频 / 字幕        编辑 → 参数 / 代码
```

- `index.tsx` 只管分页壳:两条分页栏 + 五个面板。面板**都常驻挂载**,靠行内 `display` 显隐
  (不要用 Tailwind 的 `hidden` 类:它和 `flex` 都是 display,谁生效取决于样式表顺序,不可靠),
  所以切分页不丢滚动位置、搜索词和代码框里没提交的草稿。
- 分页选择记在 localStorage:`pc.left.tab`(assets/edit)、`pc.left.assetTab`(cards/videos/captions)、
  `pc.left.editTab`(form/code)。
- `CardsTab` 搜索 + 卡片网格;`MediaTab` 素材列表(拖到时间轴、右键删除),每行的「字幕」按钮
  跳到字幕分页并选中这条;`CaptionsTab` 选素材 → 没转写就在这儿转,转过就列出每一段,
  点一段把播放头挪到时间轴上对应的位置(素材时间经所在片段的 `mediaOffset` 换算)。
- `Inspector` 只接一个 `tab: "form" | "code"` 的 prop,参数/代码这一级由分页壳控制;
  片段头部(卡名、换卡、开始/结束)在两个二级分页里都在。
- 自动化钩子(`scripts/left-check.mjs` 依赖):`data-pc="left" / "library" / "inspector" / "search" / "code-editor" / "switch-card"`、
  `data-pc-top-tab`、`data-pc-tab`、`data-pc-card`、`data-pc-media`、`data-pc-param`。
- 上下分屏(`pc.left.split`、`data-pc="split"`)已随两级分页去掉。

## 唯一真源:src/store/project.ts

```ts
import { useStore, actions, getState, subscribe } from "../../store/project";
const project = useStore(s => s.project);      // 订阅任意切片
actions.addCardClip("odometer", 3.0, { duration: 2 });
```

- `EditorState`:`project`(多轨文档)、`t`(播放头秒)、`playing`、`playToken`、`selection`(clip id 数组)、`filePath`、`dirty`
- `actions`:文档(loadProject / newProject / setProjectMeta / undo / redo)、播放(seek / tick / play / pause / togglePlay / replay)、选择(select)、轨道(addTrack / removeTrack / updateTrack / moveTrack)、clip(addCardClip / addMediaClip / moveClip / setClipParams / setClipCard / removeClip / duplicateClip / splitClip)、素材(addMedia / removeMedia)
- 所有改动都是不可变更新;轨内不重叠由 store 保证(resolveOverlap),UI 不用自己算。
- 需要新 action 时**在本任务目录内写 helper 组合现有 action**;确实要加进 store 的,在回报里提出签名,不要直接改 store。

## 文档模型:src/kernel/project.ts

`Project { version, name, width, height, fps, duration, themeId, media: MediaAsset[], tracks: Track[] }`,
`Track { id, name, hidden, locked, clips: TrackClip[] }` —— 叫**序列**,不分种类:
一条序列里卡片段(`cardId`)和素材段(`mediaId`)都能放,轨内不重叠。旧项目文件里残留的 `kind` 字段读进来忽略。
`TrackClip { id, cardId, start, end, params, mediaId?, mediaOffset?, label? }`。
序列数组靠后的画在上面。`flattenOverlay(p)` 把所有序列里的**卡片段**压平给 Stage;`videoClipAt(p, t)` 按序列顺序找当前该播的**素材段**。

## 拖放契约(左栏 → 时间轴)

MIME 常量和拖动载荷都在 `src/editor/dnd.ts`:

- 拖卡片:`dataTransfer.setData(MIME_CARD /* application/x-promptcut-card */, cardId)`
- 拖媒体:`dataTransfer.setData(MIME_MEDIA /* application/x-promptcut-media */, mediaId)`
- 同时调 `setDragPayload({ kind, id, name, duration })`,`dragend` 时 `clearDragPayload()`。
  dragover 阶段浏览器不让读 dataTransfer 的内容,落点预览要靠这份载荷才知道拖的是什么、多长;
  dataTransfer 仍是正本,drop 时以它的 id 为准。

落点(`src/editor/timeline/useDropTarget.ts` + `dropPlan.ts`):

- dragover 和 drop 用同一个 `planDrop()` 算 `DropPlan`,所以「预览里看到的位置」= 松手后真正落下的位置。
  位置会按 `snapTime` 吸附(整秒、播放头、别的片段边缘;按住 Alt 不吸附)。
- 三种状态,预览色块跟着变:`ok`(蓝)、`shift`(黄,原位被占,顺延到后面第一个放得下的空档,和 `planPlacement` 算的一致)、
  `forbidden`(红,只剩「序列被锁定」这一种,`dropEffect = "none"`,松手不落)。
- 能接住拖动的落点有三种:序列行(`TrackRow`)、序列之间的插入缝(`InsertZones`,只在拖动时出现)、
  最下面常驻的新建序列落区(`NewTrackZone`)。后两种落到新序列:走 `actions.addClipOnNewTrack`,
  新建序列 + 落片段算一步(一次撤销就能撤掉)。
- 落完把播放头移进新片段(播放中不移),中间预览立刻能看到落下的东西。
- 拖动时贴近时间轴左右边缘会自动横向滚动。

## 时间轴左边的间距和顶部的范围卡标

- 0 秒不贴着行头:内容层整体右移 `GUTTER_PX = 24`(`timeline/utils.ts`,和缩放无关)。
  **这纯粹是留白,时间没有负数**——所有下限还是 0。
- **时间 ↔ 像素一律走 `xOfTime()` / `timeOfX()`**,不要直接乘 `pxPerSec`,否则会整体偏掉一个间距。
  卡尺刻度、片段、播放头、落点预览、插入缝、内容宽度、缩放锚点、落区提示都走这两个函数。
- 顶部 `RangeBar`(`RANGE_H = 20`,吸顶,在卡尺上面)是「开始 — 结束」范围卡标:
  左边那枚钉在 0,右边那枚显示总时长、**可以拖**——拖动时只动本地状态,松手才 `setProjectMeta({ duration })`,
  所以一次拖动只占一步撤销。播放头从卡尺开始画(`<Playhead top={RANGE_H} />`),不压住卡标。

## 序列换序(拖行头)

- `timeline/useReorder.ts`:按住行头上下拖就能调顺序,不用 HTML5 拖放(那套没法做预览和动画)。
- 拖动过程中**不改文档**,只在 context 里放一份 `reorder = { id, from, to, dy }`:
  被拖的那条跟着指针走(不带过渡),让位的那几条平移一个 `TRACK_H`、带 150ms 过渡——
  于是松手前就能看到排完之后的样子。
- 行头(`TrackHeader`)和轨道行(`TrackRow`)读的是同一个 `useRowOffset(index, trackId)`,所以整条序列一起动。
- 松手先把被拖的那条滑到目标格(140ms),动画走完才 `actions.moveTrack`,落位不会闪。
- 位移不足 3px 当成点击(不进换序态);`button` / `input` 上按下不触发拖动,所以改名、显隐、锁定照常。

## 播放头 / 卡尺(scrub)

- 卡尺和播放头共用 `src/editor/timeline/useScrub.ts`:卡尺是「按下即跳到指针处,按住接着拖」,
  播放头本体是「按下不跳,保持抓取偏移」。两者都在拖动过程中实时 `actions.seek`,画面跟着走。
- 播放头挂在轨道区(trackArea)这一层,竖线从卡尺一直贯到最后一条轨(z-40 盖过 z-20 的卡尺),
  三角抓手落在卡尺格子里——卡尺和竖线之间没有拖不动的空档。
- 时间原点统一取 trackArea 的左边(卡尺、播放头各自元素的左边都不是 0 秒)。
- 吸附走 `snapTime`(整秒、片段边缘),按住 Alt 不吸附;吸附点里不含播放头自己(传 t = -1),
  否则拖动时会黏在原地。
- 播放中开始 scrub 会先 `actions.pause()`,不然播放循环会把播放头拽回去。
- 三角抓手上留着 `clip-playhead` 类名:`scripts/timeline-verify.mjs` 靠它定位播放头。

## 预览契约(渲染面 ?stage=1)

预览窗口不自己按墙上时钟播动效,它只是显示「时间轴 t 那一帧」。

- 动效跑在 `src/StageView.tsx`(`?stage=1`)里,由 `src/editor/Preview.tsx` 用 iframe 装着。
  视频层还留在编辑器这边(iframe 透明,浮在 `<video>` 上)。
- 渲染面里的时间被接管:`src/render/stageClock.ts` 把 `performance.now()` 和
  `requestAnimationFrame` 换成驱动式的——浏览器不再自己触发帧,由 `render(t)` 显式推进。
  **这个时钟必须比 motion 先装好**,所以 `src/main.tsx` 第一行是
  `import "./render/stageClockEntry"`(motion 在模块初始化时就把 rAF 抓走了)。
  只在 `?stage=1` 装;编辑器主文档不装,不然自己的界面动画会被冻住。
- CSS / WAAPI 动画走 `src/render/pinAnimations.ts`:记下每个动画头次出现时的舞台时间当锚点,
  每帧把 `currentTime` 钉成「现在 − 锚点」再暂停。和导出视图的 `__pcSyncAnims` 同一个办法。
- 编辑器只调三件事(同源直接拿 `iframe.contentWindow.__pcStage`,见 `PcStageApi`):
  `setProject(project)`、`render(t, { jump?, replay? })`、`size()`;渲染面挂好后会
  `postMessage({ type: "pc-stage-ready" })`。
- `render` 的两条路径:时间小步往前(< 0.5s)= 连续播放,接着推进;
  其余(拖播放头、跳转、重播)= 把该时刻活跃的卡全部重挂载,从各自入点分步补跑到 t。
  分步是必须的:Motion 把单帧 delta 夹在 40ms 以内,一步跨几秒动画只会前进 40ms。
  补跑上限 6 秒(`stageClock.ts` 的 `DEFAULT_MAX_CATCH_UP`),更早的动画早就播完了。
- 只改卡片参数不重挂载(免得每敲一个字画面闪一下);片段的位置/时长/用哪张卡/画布尺寸变了才重算这一帧。
- 于是「同一个 t = 同一帧」:反复跳到同一秒画面完全一致,和导出用的是同一份卡片代码和同一套钉时间的办法。

## 主题契约(src/themes/index.ts)

`themes: Theme[]`、`getTheme(id)`、`themeStyle(id)` → 一组 `--pc-*` CSS 变量,Editor 和 Preview 已经把它挂到根元素和舞台上。卡片只读变量:`--pc-accent`、`--pc-fg`、`--pc-fg-muted`、`--pc-fg-faint`、`--pc-glass-bg`、`--pc-glass-border`、`--pc-glass-blur`、`--pc-radius`、`--pc-font`、`--pc-font-mono`、`--pc-shadow`。

## MCP / AI 契约

AI 助手在浏览器外(node 进程)跑,通过 MCP 工具操作项目。工具的执行端在浏览器里(store 在浏览器里),所以链路是:
`AI 进程 → (SSE/WS) → 浏览器 src/ai/mcpExecutor → actions.*`。工具清单至少:
`list_cards`(含 controls 和 defaults)、`get_project`、`get_selection`、`add_clip`、`update_clip`(params/时段/换卡)、`remove_clip`、`add_track`、`seek`、`play/pause`、`set_theme`。
工具 schema 从 `CardDef.controls` 自动生成,这样加卡不用改工具。

## 目录归属(并行时不要越界)

| 目录 | 任务 |
|---|---|
| `src/themes/`、`src/cards/native/hud.*`、10 张卡片文件(让它们改读 `--pc-*` 变量) | 主题 |
| `src/editor/timeline/` | 时间轴 |
| `src/render/`、`src/StageView.tsx`、`src/editor/Preview.tsx` | 预览渲染面 |
| `src/editor/left/` | 左栏 |
| `src/editor/right/`、`src/ai/`、`server/`、`vite.config.ts`(加 AI 桥插件) | AI 助手 |
| `src/editor/io/`、`scripts/`、`src/ExportView.tsx`、`vite.config.ts` 里的 `/api/export` 中间件(和 AI 任务协调:各自写成独立 vite 插件文件 `server/vite-plugin-*.ts`,vite.config.ts 只加一行 import) | 导入导出 |

公共文件(`src/Editor.tsx`、`src/store/project.ts`、`src/kernel/*`、`src/main.tsx`、`package.json`)由壳的负责人改;要改就在回报里写清楚。装新包也要在回报里说明并给出理由。

## 参考来源

外部参考材料的清单和阅读范围见工作目录下的 `AGY-TASK-sources.md`(过程文件,不入库)。入库的文件内容和提交信息里不引用外部项目。
