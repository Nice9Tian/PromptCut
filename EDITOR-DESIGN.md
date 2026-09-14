# PromptCut 编辑器 · 契约(第二阶段)

第一阶段(DESIGN.md)验证了内核:Motion 动画 + Chrome 虚拟时间逐帧导出。第二阶段把它长成一个能用的编辑器。
**先读 DESIGN.md,再读本文。** 内核目录 `src/kernel/` 的接口仍然冻结。

## 布局(src/Editor.tsx)

```
┌ WindowTitleBar / TopBar(和画布同色)                                              ┐
│ [左 rail][左抽屉卡片] ║ [预览卡片]            ║ [AI 助手卡片][右 rail]              │
│ [左 rail][──── TimelineView 卡片:左对齐抽屉卡、右对齐 AI 面板卡 ────][右 rail]              │
└ StatusBar                                                                          ┘
```

整体是 Fluent 风格的深色 Studio 界面:最底层是画布(`--ui-bg`),面板是浮在画布上的圆角卡片(`.pc-card-surface`),
卡片之间留 `--ui-gap`(8px)的缝,**这条缝本身就是拖杆**(`src/editor/ResizeHandle.tsx`,静止时不可见,hover 出一条细线)。
设计变量(圆角四档、`--ui-gap`、`--ui-rail-w`、`--pc-cube-s` 等)由 `src/skins/skins.ts` 挂到所有皮肤上,
共享样式类(`.pc-card-surface`、`.pc-rail*`、`.pc-chip`、`.pc-icon-btn`、`.pc-btn-primary`、`.pc-section-title`)在 `src/skins/studio.css`。
默认皮肤 `studio-dark`;还停在旧默认 `indigo-dark` 的用户会被迁移一次(标记 `pc.skin.studioMigrated`)。

- **时间轴卡片夹在两条 rail 中间**:rail 那一列从上通到底,时间轴左边对齐素材库抽屉卡、右边对齐 AI 面板卡
  (`Editor.tsx` 的 `.pc-editor-bottom` 左右各缩进 `RAIL_W`,某一侧收起时再多让一个 `HANDLE_W`,对齐预览卡边缘);抽屉和 AI 面板只占时间轴上方。
- 两侧各一条 64px 竖向 rail(`RAIL_W`,`src/editor/sideRails.ts`)。点 rail 上已选中的项 = 收起 / 展开旁边的抽屉或面板,
  状态存 `pc.rail.left.collapsed` / `pc.rail.right.collapsed`。左侧整列宽 = `RAIL_W + (收起 ? 0 : drawerW)`,右侧同理。
- 抽屉宽 `pc.left.drawerW`(默认 240,正好是素材库 big 单列的宽度;最小 200)、AI 面板宽 `pc.right.panelW`(默认 360,最小 280)、
  时间轴高 `pc.timeline.h`(默认 272,最小 120,最大窗高 70%;分页栏和工具条变高之后 224 只露得出一条序列);拖动时改 state,松手才写 localStorage。
- 某一侧收起时,那根拖杆照样渲染(槽位不变),只是不可拖。
- 中间预览始终留 `MIN_PREVIEW_W = 320`;可用宽度不够时收抽屉 / 面板的宽度(不低于各自最小值),不会自动收起面板。
  ResizeObserver + window resize 两条路都盯着。
- 双击拖杆复位到默认值。拖动期间 `<body>` 上有 `data-pc-resizing`,
  `index.css` 靠它把预览 iframe 的 `pointer-events` 关掉,免得鼠标滑进 iframe 就断了。
- `RightPanel` 在网格里始终占同一个兄弟槽位,布局模式、收起状态都不能让它卸载重建(正在跑的 AI 对话会断)。
- **动效**(全部 `cubic-bezier(0.16, 1, 0.3, 1)`,只在 `prefers-reduced-motion: no-preference` 下生效):
  - 收起 / 展开时网格列宽过渡 220ms:`Editor.tsx` 只在收起状态切换那一刻给 `.pc-editor-grid` 挂一小会儿 `data-pc-rail-anim`,
    拖杆拖宽度、窗口变窄自动收缩都不走过渡;过渡期间抽屉 / 面板卡片保持原宽被列裁掉(`--pc-left-drawer-w` / `--pc-right-panel-w`),内容不逐帧重排。
  - 分区切换、组打开 / 关闭、右侧页切换、新消息行、报告卡、队列行的入场用 `src/editor/enterMotion.ts` 的 `playEnter(el, class)`
    (关键帧 `.pc-enter-rise / -from-right / -from-left / -fade` 在 `skins/motion.css`),演完摘掉 class,重新显示时不重播。
- 左栏预览框的后台补量(`prewarmBoxes.tsx`)只在 1.5s 没有点击 / 键盘 / 滚轮输入、且浏览器空闲时才跑;
  `measureAcrossTime` 一趟里画布像素只读一次(拨 Web Animations 不会让画布重画)—— 以前它是界面交互卡顿的主要来源。

三个插槽**只暴露一个固定导出名**:`LeftPanel`、`RightPanel`、`TimelineView`,以及 `src/editor/io/index.ts` 的四个函数。
LeftPanel / RightPanel 自己画 rail 和卡片,Editor.tsx 里的两个 `aside` 是透明的。TopBar.tsx / Preview.tsx 是壳,不要改;要壳配合的地方在回报里提。

## 左栏:竖向 rail + 分区抽屉(src/editor/left/)

```
rail   素材库 | 特效 | 编辑 | 字幕
抽屉   素材库 → 分组总览 ⇄ 组详情        特效 → 分组总览 ⇄ 组详情(视觉 / 音频在同一页,用胶囊筛)
       编辑   → 参数 / 代码 / 节点          字幕 → 导入 .srt/.vtt + 搜索 + 转写列表
```

- `index.tsx` 的 `LeftPanel` = `.pc-rail--left`(`data-pc="left-rail"`,四项 `data-pc-rail="library|effects|edit|captions"`)
  + 抽屉 `.pc-card-surface`(`data-pc="left-drawer"`)。点另一项切分区并展开抽屉,点已选中的项收起 / 展开(`sideRails`)。
  四个分区(`LibrarySection` / `EffectsSection` / `EditSection` / `CaptionsSection`)**都常驻挂载**,靠行内 `display` 显隐
  (不要用 Tailwind 的 `hidden` 类:它和 `flex` 都是 display,谁生效取决于样式表顺序,不可靠),
  所以切分区不丢滚动位置、搜索词和代码框里没提交的草稿。
- localStorage:`pc.left.section`(默认 library)、`pc.left.group.library` / `pc.left.group.effects`(打开着的组)、
  `pc.left.editTab`(form / code / nodes)。
- **分组**:组定义集中在 `library/groups.tsx`,每组有 `id / name / layout / category(视觉 | 音频)`;挪组、改排版只改这张表。
  - 素材库:视频、图片(big_16_9)、音频(big_strip)、定制卡片、Magic UI、自家卡片、部件库、Lottie 动效(middle_cube)、粒子背景(big_16_9)。
  - 特效:转场、滤镜、强调、全局风格(middle_cube,视觉)、音频效果、音频预设(big_strip,音频)。
  - 总览是圆角组框(`GroupBox`:组名、「N 个项」、前几项静态缩略图),点组框打开组;组详情(`GroupDetail`)顶部胶囊行
    「所有 / 分类 / 组名 ×」,下面「N 个项目」和按该组排版的全部项目,组还可以带 `detailTop` / `detailBottom`(转场时长、已有转场、相接的两段等)。
  - 分区头部的分类胶囊 `所有 / 视觉 ▾ / 音频 ▾`(`CategoryChips`):点胶囊只看这一类,点 ▾ 列出这一类的组直接打开。
    搜索在打开的组里过滤,在总览里按组过滤。
- **排版**(纯函数 `library/layout.ts`,有测试):以 small_cube(`--pc-cube-s` = 64px,间距 8)为单位,
  `units = max(3, floor((内宽 + 8) / 72))`;small 列数 = units、middle = units / 2、big = units / 3(向下取整、至少 1),列宽拉伸填满。
  big_16_9 单列时横竖混排、竖屏最高到 4:3(居中裁掉上下),多列按素材比例瀑布流;middle 已知比例时也瀑布流;
  big_strip 固定 56px 高(音频条画整段波形,复用 `AudioWaveform.tsx` 的 `loadWave`)。瀑布流 `Masonry.tsx` 按最矮列放置。
  抽屉默认宽 240、左右内边距 12 → 内宽 216 → 3 单位,正好是 big 单列。
- **预览卡** `PreviewCard.tsx`:按 aspect 给高度,媒体 `object-fit: cover`,左下角时长 badge;悬停才起动画 / 播视频。
  **不要**给它套皮肤里 `.cursor-grab.bg-neutral-900` 那组类:那条规则悬停时画一道 3px 的左侧强调色内阴影,预览一铺满就成了漏进画面的色边。
- 素材库头部:「导入媒体」主按钮(`data-pc-add="media"`,导入后自动打开对应的组)、搜索框(`data-pc="search"`)、
  筛选图标按钮(浮层里是 `CardScopeBar`)。卡片列表和可见性只有一个来源(`useCardLibrary`),所有卡片组共用。
  右键菜单、确认框、定制卡菜单、提示条每个分区只挂一份、常驻挂载,总览、详情、搜索结果里都能用;视频卡右键有「以视频比例作为项目比例」。
- 时间轴上的视频 / 音频片段右键「转写字幕」走 `captionsBus.ts` 的 `pc-open-captions`:切到字幕分区、展开抽屉、定位那份素材。
  `CaptionsTab` 选素材 → 没转写就在这儿转,转过就列出每一段,点一段把播放头挪到时间轴上对应的位置(素材时间经所在片段的 `mediaOffset` 换算)。
- 编辑分区:`Inspector` 接 `tab: "form" | "code"`,两页都常驻挂载(`CodeTab` 按 clipId 重建,草稿不会串到别的片段);
  「代码」页显示的是这张卡的**约定封装**(`src/kernel/envelope.ts`:card + lifecycle / time / frame / blend / motion / parts / params),
  不是原始的 `{ cardId, start, end, params }`,也不是组件源码;Agent 的 `get_clip` / `set_clip` 看到和改的是同一份;
  选中的是组合卡(cardId `composite`,内容是 `clip.parts` 部件实例树)时「参数」页换成 `PartsForm`;「节点」页是 `NodeGraphTab`。
  参数表里 key 命中 speaker/talking/口播 之类的 text 控件多一个「…」按钮,打开 `SpeakerPicker.tsx` 从素材或本地文件选口播视频。
- **预览按动效的包围盒推近**,不按整幅画幅 —— 1920×1080 缩进 130px 的格子,标题卡只剩一粒。盒子分两层:
  - **算好的**:`src/cards/preview-boxes.json` 静态表(`npm run preview-boxes` 离线生成、入库、随包发)
    和本机 localStorage 缓存,悬停时直接用,一步到位;
  - **现场量**:表里没有(用户 / AI 新建的卡、刚加的部件)就藏着舞台跑一遍,把 Web Animations 逐档拨过去
    量并集(`contentBox.ts` 的 `measureAcrossTime`),量完存进缓存。
    第一次打开卡片页还会在屏幕外把表里缺的挨个补量(`prewarmBoxes.tsx`,一次一个、排在空闲时段)。
  canvas 里画了什么 DOM 看不见,所以 `contentBox.ts` 对 2D 画布直接扫像素定边界;粒子卡不进后台队列
  (53 张 canvas 引擎太贵),靠悬停时的像素扫描就够。卡片改了默认参数或动画,重跑 `npm run preview-boxes`。
- 自动化钩子(`scripts/left-check.mjs` 依赖):`data-pc="left" / "library" / "inspector" / "search" / "code-editor" / "switch-card"`、
  `data-pc-top-tab`、`data-pc-tab`、`data-pc-card`、`data-pc-media`、`data-pc-param`。
- 上下分屏(`pc.left.split`、`data-pc="split"`)已随两级分页去掉。

## 转场:把片段绑成一组(src/kernel/transitions.ts)

转场是**对象**,不再是「两段重叠 + 各自淡化」的巧合:`project.transitions` 里一条记录
(`{ id, kind, aId, bId?, dur, prevB? }`,随剪辑一起停放/取回,见 cuts.ts),它管着两端的
`fadeIn` / `fadeOut`,并且**把它引用的片段绑成一组**。

- `crossfade` 要两段**首尾相接**的片段。同一条序列内不允许重叠,所以加转场时会把后一段
  往前拉 `dur` 秒、必要时挪到另一条序列(挪之前的位置记在 `prevB`,删转场时放回去);
- `fadeIn` 只加在片段开头、`fadeOut` 只加在结尾;那一端已经被交叉溶解占着就不给加;
- **组内相对时间关系锁住**:单独改时长、换序列、切开都不行(store 的 moveClip / splitClip
  直接挡回来,Agent 那边 update_clip / split_clip 抛出带 `transitionId` 的说明)。
  **整组一起平移是允许的** —— moveClip 收到组内任意一段的位移,就把 `groupOf` 算出来的
  全部成员按同一个 Δ 挪(`shiftClipsBy`,有一处放不下就整组不动);
- 删转场:擦掉淡化、放回后一段、记录去掉,那几段就自由了。删片段时引用它的转场一并撤掉。

界面上:左栏「转场」页三张卡(交叉溶解 / 淡入 / 淡出)拖到时间轴 —— 拖到两段接缝处是交叉溶解、
拖到一段的头/尾是淡入/淡出(`planTransition` 在 dragover 时就把能不能加、加多长算出来,
落不下时直接把原因写在落点提示上);那一页还列出已有的转场,每条都能删。时间轴上片段两端
画出淡化区间,被绑住的片段右上角挂一枚链条角标(标题写着为什么挪不动),右键第一项就是删转场。

Agent 那边:`list_transitions` / `add_transition` / `remove_transition`,规矩和界面同一份代码。

## 字幕轨(src/kernel/captions.ts)

字幕**不是**每句话一个 clip:整段口播共用一张 `caption-track` 卡,内容存在它的 `lines`
参数里(`起|止|中|英` 一行一条,秒数相对卡片起点)。这份格式没变过 —— 老项目文件、
`fill_captions`、卡片组件三边都认它。

变的是**时间轴上看得见了**:`kernel/captions.ts` 把那串文本解析成一条条 `CaptionLine`,
`timeline/CaptionLines.tsx` 在字幕卡内部把每条画成一小格,改完再 `formatCaptions` 写回同一个
字符串。以前时间轴上只有一个大色块,哪句话几秒出、压在哪个镜头上一概看不见。

- 时段规矩都在 kernel 里:`captionBounds` 给出「这条能挪到哪」(卡片内 + 不越过左右邻居),
  `editCaption` 只给 `start` 就是**整条平移**(长度不变)、给 `start+end` 才是修边,
  `insertCaption` 落点被占就往后找空当、塞不下返回 -1。所以界面和 Agent 谁都写不出两条抢同一秒的字幕;
- 时间轴上:点一下把播放头挪过去、拖着挪、拽两端改时长、**双击改字**、右键删/加。
  双击是自己数的 —— 拖动要 `setPointerCapture`,指针一被捕获浏览器就不再判定原生 `dblclick`;
- 字幕卡默认落在名叫「字幕」的序列上(`ensureCaptionTrack`,没有就建,**建在 tracks[0]**;
  叠放顺序是「靠上的在上层」,追加到末尾等于把字幕埋在画面底下);
- 文字稿的秒数是**素材内**的,`captionsFromTranscript` 先按素材在时间轴上的位置换算
  (认 `mediaOffset`)再减去卡片起点。素材放在开头且没修头时两者恰好相等,所以这个坑很久没被踩出来。

入口:人走左栏「字幕」页 → 转写完点「铺成字幕轨」(`actions.buildCaptions`,同一时段已有字幕卡就复用);
Agent 走 `fill_captions` 灌整份,再用 `list_captions` / `edit_caption` 改单条。

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

## AI 栏:布局与 Agent 活动展示(src/editor/right/)

- `RightPanel` = 一张卡片(剧本页 `chat/ScriptPage.tsx` + 所有 `AiPanel` 的堆叠)+ 贴窗口右边的 `chat/RightRail.tsx`:
  最上面「剧本」,分隔线,每个 Agent 分页一项,最后「+」新开分页。当前页 `pc.right.page`(`script` / `agent`),哪个 Agent 页沿用 `agentTabs.ts`。
  所有 `AiPanel` 常驻挂载,不在前台、面板收起都只是 `display:none`。
- `AiPanel.tsx` 只做组合:`chat/ChatHeader`(右侧只有「显示思考」可激活按钮、历史、设置)→ 登录横幅 → `chat/MessageList` → `chat/ThinkingStrip`
  → `chat/QueueList` → `chat/Composer`(占面板高度 1/3;底部工具条放附件、✦ 菜单〔分工模式 / 一键配特效 / 诊断 / 新对话〕、provider 与模型、⋯ 运行选项、发送 / 停止)。
- 「详细模式」挪进 AI 设置对话框的「显示」小节;它和「显示思考」都是 `chat/viewPrefs.ts` 的模块级 store(键 `aiViewMode` / `aiShowThinking`,所有分页共享)。
- **Agent 的文字回复默认不显示**。一条 Agent 消息(`chat/AgentBubble.tsx`)按先后切段:每段是一排操作图标(`chat/ToolIcons.tsx`)+ 段尾的
  `report_progress` 报告卡(已完成 / 待办 / 问题,空组不显示);正常结束却没交 `final: true` 报告时给一句「这一轮没有提交小结」。
  「显示思考」打开时,气泡底部多一块「思考与原文」(文字一律走 `LiveMarkdown`,流式期间节流解析)。
- 操作图标是 `--pc-cube-s`(64px)的方块:相邻同类操作合成一个图标,**每个最多装 5 个**,第 6 个开新图标(纯函数 `chat/iconRuns.ts`,有测试)。
- `chat/ActivityCarousel.tsx`:把 Agent 看过的图(视觉记录里的 `images`、旧消息的 `files`)和能可视化的操作(修改前后动图、参数 diff)做成轮播,
  支持拖动、点两侧、横向滚动、方向键翻页;翻到哪页,那页所属的图标放大发光。视觉记录由 `ToolVisual.tsx` 的 `loadVisualRecord` 按 id 缓存。
- `chat/ThinkingStrip.tsx`:输入区上方一条,只显示这一页正在跑的消息的**当前一步**(`thinkingSteps.currentStep`,没有步骤时显示正在跑的工具)和已用时间。

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
`list_cards`(含 controls 和 defaults)、`get_project`、`get_selection`、`add_clip`、`update_clip`(params/时段/换卡)、`remove_clip`、序列管理(`list_tracks` / `add_track` / `remove_track` / `update_track` / `move_track`,见 `src/editor/right/trackTools.ts`)、滤镜库(`list_filters` / `create_filter` / `update_filter` / `remove_filter` / `apply_filter`,数值和三条合成管线的翻译在 `src/kernel/filters.mjs`,门槛在 `src/editor/right/filterTools.ts`)、音频效果库(`list_audio_fx` / `create_audio_fx` / `update_audio_fx` / `remove_audio_fx` / `apply_audio_fx` / `measure_audio`,数值在 `src/kernel/audioFx.mjs`,预览和导出共用的 Web Audio 节点图在 `src/audio/fxChain.ts`,门槛在 `src/editor/right/audioFxTools.ts`;导出的混音在 Chrome 的 OfflineAudioContext 里渲,见 `src/audio/renderMix.ts` 和 `scripts/export-frames.mjs` 的 mixAudioInChrome)、`seek`、`play/pause`、`set_theme`。
工具 schema 从 `CardDef.controls` 自动生成,这样加卡不用改工具。

**进度报告 `report_progress`(服务端工具)**:Agent 的文字回复默认不显示给用户,用户看的是它在每个小阶段结束(`final: false`)
和任务收尾 / 需要用户操作时(`final: true`)交上来的 `{ final, stage?, has_done, has_todo, has_problem, done[], todo[], problems[] }`。
声明在 `server/mcp-tools.mjs`,校验与规范化在 `server/progress-report.mjs`(条目截到 60 字、每组最多 8 条、布尔以数组为准),
执行分支在 `server/vite-plugin-ai.ts` 的 `callToolInternal`;界面直接读 `tool_call` 事件的 `input`,解析在 `src/ai/progressReport.ts`
(工具名兼容 `mcp__promptcut__` 等前缀)。用法规则写在 `server/ai-system-prompt.md` 的「向用户汇报」一节。

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
