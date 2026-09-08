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

> 二级分页栏**下面**还有一条统一导航条 `AssetToolbar.tsx`(素材下的三档共用):左边「+」按分页分流
> (卡片=清空搜索回顶、视频=导入视频文件、字幕=选 .srt),右边搜索框(三档各记各的搜索词)。
> 素材下第一档是 `StyleTab.tsx`「全局风格」——主题卡列表,切换调 `setProjectMeta({ themeId })`,
> 顶栏不再有主题下拉。视频卡右键多一项「以视频比例作为项目比例」。
> 参数表里 key 命中 speaker/talking/口播 之类的 text 控件会多一个「…」按钮,
> 打开 `SpeakerPicker.tsx` 从素材或本地文件选口播视频。

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
  「代码」页显示的是这张卡的**约定封装**(`src/kernel/envelope.ts`:card + lifecycle / time / frame / blend / motion / parts / params),
  不是原始的 `{ cardId, start, end, params }`,也不是组件源码;Agent 的 `get_clip` / `set_clip` 看到和改的是同一份;
  选中的是组合卡(cardId `composite`,内容是 `clip.parts` 部件实例树)时「参数」页换成 `PartsForm`:一棵可增删改移的部件树,
  卡片页多一组「部件库」(`PartCell`),点一下加进选中的组合卡或新建一张;
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
  左边那枚钉在 0,右边那枚显示总时长、**可以拖**——拖动时只动本地状态,松手才 `setDurationManual(sec)`(见下面「总时长」一节),
  所以一次拖动只占一步撤销。播放头从卡尺开始画(`<Playhead top={RANGE_H} />`),不压住卡标。

## 序列换序(拖行头)

- `timeline/useReorder.ts`:按住行头上下拖就能调顺序,不用 HTML5 拖放(那套没法做预览和动画)。
- 拖动过程中**不改文档**,只在 context 里放一份 `reorder = { id, from, to, dy }`:
  被拖的那条跟着指针走(不带过渡),让位的那几条平移一个行高(可变 `trackH`,见「行高三档」)、带 150ms 过渡——
  于是松手前就能看到排完之后的样子。
- 行头(`TrackHeader`)和轨道行(`TrackRow`)读的是同一个 `useRowOffset(index, trackId)`,所以整条序列一起动。
- 松手先把被拖的那条滑到目标格(140ms),动画走完才 `actions.moveTrack`,落位不会闪。
- 位移不足 3px 当成点击(不进换序态);`button` / `input` 上按下不触发拖动,所以改名、显隐、锁定照常。

## 时间轴的布局、行高与总时长

- **行头列宽可调**:`utils.ts` 只留 `HEADER_W_DEFAULT = 180 / MIN = 120 / MAX = 420`,当前值在 `TimelineContext`
  (localStorage `promptcut.timeline.headerW`),行头右缘嵌一根 `ResizeHandle axis="x"`,双击复位。
  **凡是要用行头宽的地方都读 context,不要再写死 200**(滚轮缩放锚点、播放头自动滚动、拖动自动横滚都在用)。
- **行高三档**:`ROW_SIZE_H = { small: 28, medium: 44, large: 72 }`,默认 medium,档位记 localStorage,
  由 `timeline/Toolbar.tsx` 切换。`TRACK_H` 常量已经没有了——`TrackRow / TrackHeader / InsertZones /
  NewTrackZone / useReorder` 一律从 context 读 `trackH`。中/大档片段里显示摘要(卡片段取第一个 text 控件的值,
  没有就用卡片描述;素材段显示文件名 + 时长),小档保持单行。
- **总时长**:store 里多了 `durationManual`(null = 从没手动设过)和两个 action——
  `setDurationManual(sec)`(RangeBar 拖动用,进撤销栈)、`syncDuration(sec)`(自动跟随用,不进撤销栈)。
  规则:没手动设过就跟着内容走(最后一个片段的 end + 2 秒,只伸不缩);手动设过就以手动值为底,
  内容超出继续伸、内容缩回退回手动值。
- **底部自定义滚动条**(`timeline/Scrollbar.tsx`):条身 = `[0, duration]`,滑块 = 当前可视区间;
  拖滑块中间平移(改 scrollLeft),拖两端把手改 `pxPerSec`(缩放),双击复位。原生横条用 CSS 隐藏了(竖条保留),
  Ctrl+滚轮缩放行为不变。

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

### 预览窗口的外壳(src/editor/preview/)

- `ControlBar.tsx` 底部控制栏:播放/暂停、重播(纯图标),时间显示「当前 / 总时长」,点当前时间就地变输入框,
  支持 `12.5` 和 `0:12.5` 两种写法,回车生效、Esc 取消。播放控制原来在顶栏,已经搬到这里,顶栏不再有。
- `ToolBar.tsx` 顶部工具条:箭头(选择) / T(文字) / 十字(移动),`ToolType = "select" | "text" | "move"`。
- 画布交互:`kernel/Stage.tsx` 给每个 clip 的包装 div 加了 `data-pc-clip`(**只加了这一个属性,接口没动**),
  `StageView` 增加 `rects()` 返回活跃卡片在舞台坐标里的矩形;Preview 在 iframe 上盖一层覆盖层做命中测试。
  移动工具只在 pointerup 写一次 `setClipParams(id, {x, y})`(拖动中写会冲垮撤销栈);
  文字工具双击改第一个 text 控件;右键菜单两项:引用到 AI、删除。
- 引用契约:预览派发 `window` 上的 `CustomEvent("pc-quote-clip", { detail: { clipId, cardId, label } })`,
  AI 栏监听并插进输入框。
- `MiniScrubber.tsx`:只在对话式布局下出现的播放器式进度条(点击/拖动 seek,按 duration 画片段分布)。

## 布局模式与项目设置

- `src/editor/layoutMode.ts`:`"classic" | "chat"`,localStorage `pc.layout.mode`,`useLayoutMode()` 订阅。
  对话式(chat)下 `Editor.tsx` 只渲染预览 + AI 栏,左栏、时间轴、竖拖杆都不渲染;
  三个 `usePanelSize` 和 clamp 的 effect 仍然无条件调用,hooks 顺序不能因模式而变。
- 顶栏(`src/ui/toolbar.css` 的 `.pc-bar`)**永不换行**:`ResizeObserver` 量顶栏自身宽度,
  按 wide ≥1180 / icon ≥880 / narrow 三档降级(带 40px 滞回)。文字标签始终留在 DOM 里,
  靠 `.pc-btn-label` 的 max-width + opacity 收起,**不要卸载节点**,否则没有过渡。
  窄档把「皮肤 + 布局 + 项目设置」整组收进 ⋯ 菜单(portal + fixed,因为 `.pc-bar` 现在裁切溢出)。
- `src/editor/ProjectSettingsDialog.tsx`:16:9 / 4:3 × 横版 / 竖版 → 1920x1080 / 1080x1920 / 1440x1080 / 1080x1440,
  确定后 `setProjectMeta({ width, height })`。

## 主题契约(src/themes/index.ts)

`themes: Theme[]`、`getTheme(id)`、`themeStyle(id)` → 一组 `--pc-*` CSS 变量,Editor 和 Preview 已经把它挂到根元素和舞台上。卡片只读变量:`--pc-accent`、`--pc-fg`、`--pc-fg-muted`、`--pc-fg-faint`、`--pc-glass-bg`、`--pc-glass-border`、`--pc-glass-blur`、`--pc-radius`、`--pc-font`、`--pc-font-mono`、`--pc-shadow`。

## AI 栏:会话历史与附件

- 历史存在服务端:`server/vite-plugin-chats.ts` 提供 list/get/save/delete,落盘 `<项目根>/.pc-chats/<id>.json`
  (原子写;list 只返元信息,搜索在标题+正文里做)。localStorage 只存**当前会话 id**,不存正文。
- 附件:每个会话一个 `<项目根>/.pc-work/<conversationId>/`。选文件后前端**先同步插入 importing 占位卡片**
  (在任何 await 之前),再走两条通道之一——桌面壳拿得到 `file.path` 就交给 `server/runners/copy-attachment.mjs`
  子进程复制、立即返回 jobId 前端轮询;浏览器就用 `stream/promises.pipeline` 直写磁盘(512MB 上限)。
  失败变红可重试。删会话连带递归删 `.pc-work/<id>/`。
- `.pc-chats/` 和 `.pc-work/` 已进 `.gitignore`。
- 遗留:`useAiChat.ts` 里旧的 `localStorage.aiChat:<provider>` 历史仍与服务端历史并存,切 provider 会覆盖 messages;
  会话 json 的 `sessionId` 目前还传 undefined。要彻底统一得改 `useAiChat.ts`。

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
