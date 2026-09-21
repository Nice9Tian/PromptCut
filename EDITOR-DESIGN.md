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
- **rail 自由布局**(`src/editor/dock/`):rail 上的项(五个左栏分区、`script`、每个 `agent:<tabId>`)都能拖 ——
  同一条 rail 里换顺序,或者拖到另一条 rail;任何一侧的抽屉 / 面板都显示**这一侧 rail 当前选中项**的页面。
  - 布局 `pc.rail.layout.v1` = `{ left: ItemId[], right: ItemId[], active: { left, right } }`;纯逻辑(校验、move、「+」位置、空侧)
    在 `railLayout.ts`(有测试),store 在 `railStore.ts`(调试把手 `window.__pcRailLayout`)。读出来会校验:去掉已关的 Agent,
    缺的分区补回左边末尾,缺的剧本补回右边顶上。Agent 分页的增删仍以 `agentTabs.ts` 为准,布局只记位置;选分区照样写 `pc.left.section`。
  - 拖动 `railDrag.ts`:按下移动超过 4px 才算拖动(否则是原来的点击),跟手半透明图标 `data-pc="rail-drag-ghost"`、
    落点线 `data-pc="rail-drop-indicator"`(只在拖动中出现),Esc 取消;落在 rail 矩形 ±8px 内才算数。放下后被拖项成为目标侧选中项并展开;
    某一侧被拖空就保留空 rail 当落点、抽屉强制收起。
  - **「+」**(`IconBubblePlus`,气泡里一个 +)不是可拖项:每一侧紧跟在**这一侧最后一个 Agent 项下面**;一侧没有 Agent 项就不画。
    点它新建的 Agent 插在这一侧最后一个 Agent 后面、在这一侧打开。
  - **rail 上的项之间不画分隔线**,只靠间距。
  - **页面不因换侧卸载**(reverse portal):`DockPages` 在 `RightPanel` 里把每个页面各渲染一次,portal 进各自固定的 `div.pc-dock-page`
    (`data-pc-dock-page=<ItemId>`);两侧的 `DockHost`(`data-pc-dock-host=left|right`)只把节点挪进来,React 树不动 ——
    正在跑的对话、输入框草稿、滚动位置、搜索词在换侧后都还在。挪节点优先 `Element.moveBefore`,手动保存 / 写回滚动位置。
  - 收起按钮跟着页面所在的一侧走:在左侧是右上角 `left-collapse`,在右侧是左上角 `right-collapse`(`dockSide.ts`)。
  - 对话式布局:两条 rail 只显示剧本 / Agent;哪一侧一个 AI 类项都没有,那一侧整列不显示。
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
rail   素材库 | 动画 | 特效 | 编辑 | 字幕
抽屉   素材库 → 分组总览 ⇄ 组详情(视频 / 图片 / 音频)    动画 → 分组总览 ⇄ 组详情(各类卡片 + 部件,不画分类胶囊)
       特效   → 分组总览 ⇄ 组详情(视觉 / 音频在同一页,用胶囊筛)
       编辑   → 参数 / 代码 / 节点                        字幕 → 导入 .srt/.vtt + 搜索 + 转写列表
```

- `index.tsx` 的 `LeftPanel` = 左 rail(`dock/RailBar.tsx`,`data-pc="left-rail"`,默认五项 `data-pc-rail="library|animations|effects|edit|captions"`)
  + 左侧宿主卡片(`DockHost side="left"`,`data-pc="left-drawer"`)。点另一项切页并展开抽屉,点已选中的项收起 / 展开(`sideRails`)。
  分区也能被拖到右 rail,这时它在右侧卡片里显示(见「布局 → rail 自由布局」)。
  五个分区(`LibrarySection` / `AnimationsSection` / `EffectsSection` / `EditSection` / `CaptionsSection`)第一次显示后**常驻挂载**(由 `DockPages` 渲染),靠行内 `display` 显隐
  (不要用 Tailwind 的 `hidden` 类:它和 `flex` 都是 display,谁生效取决于样式表顺序,不可靠),
  所以切分区不丢滚动位置、搜索词和代码框里没提交的草稿。
- **分区头部**统一用 `SectionHead.tsx`:标题行 = 分区名 + 右上角「收起面板」图标钮(`.pc-icon-btn`,`data-pc="left-collapse"`),
  点它就是 `setRailCollapsed("left", true)`,和再点一次 rail 当前项走同一条收起动画;标题行下面放分区自己的主按钮 / 搜索 / 胶囊。
- localStorage:`pc.left.section`(默认 library;library / animations / effects / edit / captions)、
  `pc.left.group.library` / `pc.left.group.animations` / `pc.left.group.effects`(打开着的组)、`pc.left.editTab`(form / code / nodes)。
  存的组 id 不在该分区的组表里就回总览(`useOpenGroup` 读的时候就滤掉,`GroupBrowser` 的 effect 再兜一层)——
  拆分之前 `pc.left.group.library` 里存过卡片组,现在读出来就是素材库总览,不迁移。
- **分组**:组定义集中在 `library/groups.tsx`(`LIBRARY_GROUPS` / `ANIMATION_GROUPS` / `EFFECTS_GROUPS`,各配一份 `*_GROUP_IDS`),
  每组有 `id / name / layout / category(视觉 | 音频)`;挪组、改排版只改这张表。
  - 素材库:视频、图片(big_16_9)、音频(big_strip)。
  - 动画:定制卡片、Magic UI、自家卡片、部件库、Lottie 动效(middle_cube)、粒子背景(big_16_9)。
  - 特效:转场、滤镜、强调、全局风格(middle_cube,视觉)、音频效果、音频预设(big_strip,音频)。
  - 总览是圆角组框(`GroupBox`:组名、「N 个项」、前几项缩略图),点组框打开组;组详情(`GroupDetail`)顶部胶囊行
    「所有 / 分类 / 组名 ×」,下面「N 个项目」和按该组排版的全部项目,组还可以带 `detailTop` / `detailBottom`(转场时长、已有转场、相接的两段等)。
  - 缩略图(`ThumbTile`)不接点击 / 拖动 / 右键、不带钩子,点下去是打开组。唯一例外:视频缩略(`mediaGroups.tsx` 的 `MediaThumb`)
    指针停在哪一格就静音从头循环播哪一格,移开停下回到首帧(`.is-hoverplay` 只让这一格接指针,`<video>` 本身不接;`preload="metadata"`);
    格子被整块藏起来收不到 mouseleave 时,靠 timeupdate 发现自己没有布局盒就停。
  - 分区头部的分类胶囊 `所有 / 视觉 ▾ / 音频 ▾`(`CategoryChips`):点胶囊只看这一类,点 ▾ 列出这一类的组直接打开。
    组表里只有一种分类时(「动画」),`GroupBrowser` 不画这一行,组详情的胶囊行也不画分类那颗、只剩「所有 / 组名 ×」。
    搜索在打开的组里过滤,在总览里按组过滤。
- **排版**(纯函数 `library/layout.ts`,有测试):以 small_cube(`--pc-cube-s` = 64px,间距 8)为单位,
  `units = max(3, floor((内宽 + 8) / 72))`;small 列数 = units、middle = units / 2、big = units / 3(向下取整、至少 1),列宽拉伸填满。
  big_16_9 单列时横竖混排、竖屏最高到 4:3(居中裁掉上下),多列按素材比例瀑布流;middle 已知比例时也瀑布流;
  big_strip 固定 56px 高(音频条画整段波形,复用 `AudioWaveform.tsx` 的 `loadWave`)。瀑布流 `Masonry.tsx` 按最矮列放置。
  抽屉默认宽 240、左右内边距 12 → 内宽 216 → 3 单位,正好是 big 单列。
- **预览卡** `PreviewCard.tsx`:按 aspect 给高度,媒体 `object-fit: cover`,左下角时长 badge;悬停才起动画 / 播视频。
  **不要**给它套皮肤里 `.cursor-grab.bg-neutral-900` 那组类:那条规则悬停时画一道 3px 的左侧强调色内阴影,预览一铺满就成了漏进画面的色边。
- 素材库头部:「导入媒体」主按钮(`data-pc-add="media"`,导入后自动打开对应的组)、搜索框(`data-pc="search"`,「搜索素材…」)。
  素材右键菜单、确认框、提示条挂在分区这一级、常驻挂载,总览、详情、搜索结果里都能用;视频卡右键有「以视频比例作为项目比例」。
- 动画头部:搜索框(`data-pc="animations-search"`,「搜索动画、卡片…」)+ 筛选图标按钮(`data-pc="scope-toggle"`,浮层里是 `CardScopeBar`,
  有档位关着时按钮右上角一个小点)。卡片列表和可见性只有一个来源(`useCardLibrary`),所有卡片组共用;定制卡右键换档菜单(`UserCardMenu`)同样挂在分区一级。
  `index.tsx` 必须**静态**导入 `AnimationsSection`:`index → AnimationsSection → cardGroups → CardCell → previewZoom → prewarmBoxes`
  这条链把 `window.__pcPreviewBoxes` 挂上去,不要改成 lazy。
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
- 自动化钩子(`scripts/left-check.mjs` 依赖):`data-pc="left" / "left-rail" / "left-drawer" / "library" / "animations" / "effects" / "inspector" / "captions"`、
  `data-pc="search" / "animations-search" / "effects-search" / "caption-search" / "scope-toggle" / "left-collapse" / "code-editor" / "switch-card"`、
  `data-pc-rail`、`data-pc-group`、`data-pc-open-group`、`data-pc-chip`、`data-pc-category`、
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
- **底部自定义滚动条**(`timeline/Scrollbar.tsx`):滑块宽 = 可视时长 / 总时长(最窄 48px),滑块位置 = 滚动进度 `scrollLeft / 最大滚动量`,
  在 `[0, 条身宽 − 滑块宽]` 里摆;拖滑块中间平移,`scrollLeft = 起始值 + dx × 最大滚动量 / (条身宽 − 滑块宽)` —— 和摆滑块的换算互逆,
  长项目里滑块被撑到 48px 时指针也不会和滑块脱开。拖两端把手改 `pxPerSec`(缩放,夹在 10~1000;夹过之后按夹完的缩放重算可视时长,
  另一端才钉得住),双击复位。原生横条用 CSS 隐藏了(竖条保留),
  Ctrl+滚轮缩放行为不变。滑块两端常驻 12px 的把手帽(`.pc-tl-hbar-grip`,两道竖纹),拖动中 `data-drag` 标出在拖哪一部分。
- **层级**:片段层(`index.tsx` 的 `.pc-tl-rows`)和行头列里的行头都是 `isolation: isolate` 的独立层,
  里面的 z(选中片段 20、落点预览 30、插入缝 40、拖动中的行 40、锁定遮罩 50)只在层内比大小,整层压在吸顶的范围条 / 标尺 / 绿条(z-20)
  和左边行头列(z-30)下面 —— 竖向滚动时选中的片段钻到标尺下面,横向滚动时锁定遮罩不盖行头。
  所以时间轴右键菜单 `ContextMenu.tsx` portal 到 body(`data-pc="tl-ctxmenu"`,颜色取皮肤变量 `.pc-tl-ctxmenu`;
  Esc、任何滚动、窗口缩放、失焦都关掉它,靠窗口边缘时夹回视口),以后往片段层里加浮层也要 portal 出去,别指望调大 z-index。
  反过来,片段层外面盖在它上面的东西会挡住拖放:播放头(z-20)在 HTML5 拖放进行中(`useDragPayload()` 非空)设 `pointer-events: none`,
  不然 dragover 落到那 11px 竖条上,插入缝收到 dragleave 把预览清掉。
- **两根滚动条同粗**:底部横条 10px 条身、14px 槽位;右侧竖条(`[data-pc="timeline"] .pc-tl-scroll::-webkit-scrollbar:vertical`)
  14px 宽、2px 透明边框,画出来同样是 10px,圆角和颜色也一致。改其中一根要同步改另一根。

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
- 画布交互:`render/Stage.tsx` 给每个 clip 的包装 div 加了 `data-pc-clip`(**只加了这一个属性,接口没动**),
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

- `RightPanel` = 右侧宿主卡片(`DockHost side="right"`)+ 贴窗口右边的 rail(`dock/RailBar.tsx`),另外负责渲染 `DockPages`(所有页面的唯一渲染点)。
  默认布局右 rail 最上面「剧本」,每个 Agent 分页一项,最后气泡「+」;但剧本和 Agent 都能拖到左边,见「布局 → rail 自由布局」。
  `chat/RightRail.tsx` 只剩剧本图标 / Agent 头像字 / 标签截断 / 悬停说明这些画法小件;`pc.right.page` 已并进 `pc.rail.layout.v1`(读旧值做一次迁移)。
  所有 `AiPanel` 常驻挂载,不在前台、面板收起、换侧都不卸载。
- **rail 上 Agent 项的颜色与状态**:
  - Agent 头像用专属色 `--ui-agent`:和皮肤强调色**同明度、同纯度**(OKLCH 的 L、C)的黄,`skins/agentColor.ts` 由强调色算出,
    所以每套皮肤里都和强调色一样亮、一样浓;强调色本身是黄橙(琥珀、石墨)时换成紫色免得撞色,出 sRGB 色域就只降纯度。
  - 正在跑:头像背后一圈转动的锥形渐变光(`.is-busy .pc-rr-glyph::before`,转 transform;减少动态效果时不转),**不打点**。
  - 跑完且用户没在看这一页:**蓝点**(强调色);被停掉 / 出错(outcome 不是 completed,或者消息还挂着 pending 就停了 —— 比如跑着的时候回了首页被 abort)且没在看:**黄点**(警告色)。
    「在看」= 这一页是它那一侧 rail 的选中项、那一侧整列显示着、面板没收起。切到这一页或展开面板就清掉,再跑起来也清掉。
    标记只在内存(`dock/agentAttention.tsx`,`AgentAttentionTracker` 挂在 DockPages 里盯 `tab.busy` 的变化),刷新后不保留。
  - 按钮上 `data-pc-agent-state="idle | busy | done | interrupted"`,悬停说明末尾补一行状态。
- 收起按钮 `chat/CollapsePanelButton.tsx`(`data-pc="right-collapse"`)放在头部**左上角**(靠右侧的面板收起钮在左上、左侧抽屉的在右上),
  `ChatHeader`、剧本页头部、没装驱动时的占位头部都用它;剧本页头部和 AI 头部同高(48px),切页时按钮不跳。
- `AiPanel.tsx` 只做组合:`chat/ChatHeader`(左上收起钮;右侧只有「显示思考」可激活按钮、历史、设置)→ 登录横幅 → `chat/MessageList` → `chat/ThinkingStrip`
  → `chat/QueueList` → `chat/Composer`(独立的圆角输入框,默认占面板高度 1/3;底部工具条放附件、✦ 菜单〔分工模式 / 一键配特效 / 诊断 / 新对话〕、provider 与模型、⋯ 运行选项、发送 / 停止)。
- 输入框整块一个底色 `--ui-panel-2` + `--ui-border-strong` 描边,里面的 textarea / 附件行 / 工具条都不自带底色;
  下拉框、附件胶囊、停止钮这类需要跟底色区分的用 `--ui-float`。
- 输入框右上角有调高把手(`data-pc="ai-composer-resize"`,转 90° 的 L 形):往上拖变高,夹在 140px 与面板高 70% 之间,
  松手且真的拖过才写 `pc.ai.composerH`(所有分页共用),双击清掉回到默认 1/3。拖动时沿用 `body.dataset.pcResizing = "y"`。
- **气泡等距**:`.ai-message` 四边内边距一律 10px,子元素之间只用 `gap`,不许给子元素加单侧 margin(有一条兜底规则把直接子元素的上下 margin 清零);
  气泡里的小框(报告卡、原文、思考、队列行、回退确认……)也各自四边等距。
- 「详细模式」挪进 AI 设置对话框的「显示」小节;它和「显示思考」都是 `chat/viewPrefs.ts` 的模块级 store(键 `aiViewMode` / `aiShowThinking`,所有分页共享)。
- **Agent 的文字回复默认不显示**。一条 Agent 消息(`chat/AgentBubble.tsx`)按先后切段,每段一排图标(`chat/ToolIcons.tsx`):
  收到的其他 Agent 消息在最前(对话图标),中间是操作图标,段尾是小结图标(`report_progress`,折角文档里画 ✓ / !:绿 = 没问题,黄 = 报了问题,红 = 这一轮出错收尾;
  和操作失败的「红底大 !」区分;文档字形画在 14 格、背景 32px,量出来和「查看」的眼睛一样宽、左右居中;好坏不写字)。
  **气泡里所有详细内容都在一个「操作详细预览控件」里**(见下),图标行本身不摊开任何清单、不铺报告卡。
  没交小结就没有小结图标,不再额外写「这一轮没有提交小结」。
  **没交本轮小结的回复,下一轮接着累计在它的气泡里**(`MessageList` 分组,只在简洁模式):一组从一条 Agent 回复开始,后面的回复都并进来,
  直到某一轮交了 final 报告才收口;分工模式里不同角色不合并;**一组最多 10 轮、前几轮合计最多 120 次操作**(`MAX_GROUP_ROUNDS` / `MAX_GROUP_TOOLS`),
  够了下一条另起一组 —— 模型或驱动一直不交小结时,整段历史不会并成一个流式时整组重算的大气泡。中间用户说的话照常在原位置显示,并进去的回复自己不画气泡。
  - 气泡里每轮的段和图标分组按消息对象缓存(`roundCalc`),流式时只重算正在跑的那一轮;「思考与原文」按轮分节,只有正在跑的那一轮按流式解析。
  - 上一轮正常收尾、这一轮也没收到消息:这一轮第一段续在上一排最后那段里(那段没交小结的话),图标接着累计;
    上一轮出错 / 被停、或者这一轮收到了其他 Agent 消息:另起一排。前几轮自己的报错和「已停止」留在它那一排后面,最后一轮的放在气泡最下面。
  - 小结的颜色看它自己那一轮(那一轮最后一段的小结,那一轮出错收尾才是红)。整个组共用一个操作详细预览控件;转圈看正在跑的那一轮。「显示思考」打开时,气泡底部多一块「思考与原文」(文字一律走 `LiveMarkdown`,流式期间节流解析)。
- 操作图标是 `--pc-cube-s`(64px)的方块:相邻同类操作合成一个图标,**每个最多装 5 个**,第 6 个开新图标(纯函数 `chat/iconRuns.ts`,有测试)。
- **收到的 Agent 消息**:别的 Agent `send_message` 来的话由 AiPanel 当一条用户消息发出去(`agentBus.formatInbound`,模型照旧当用户消息读)。
  投递时 `send(text, undefined, { inbound })` 在用户消息上带结构化的 `inbound` 字段(`ChatMessage.inbound`,随会话历史保存);
  界面只认这个字段、不靠正文前缀(用户自己打的「【来自 Agent…】」照常是用户气泡):带字段的用户消息不画用户气泡,`MessageList` 挂给紧跟着的那条 Agent 回复,
  回复的图标行最前出一个对话图标(×N),内容在操作详细预览控件里;后面还没有回复的,原位一行小字。
- **操作详细预览控件**(`chat/OpDetailPreview.tsx`,`data-pc="op-detail-preview"`):一个气泡只放一个,放在所有图标行下面,按先后把每一项排成一页页。
  - 页的种类:收到的消息(只给内容);有画面的操作 —— 每张看过的图一页、每次有前后动图的修改一页、只有参数差异的一页(画面上方叠这次操作的头一行:类别、工具名、耗时;下方叠结果里的 `note`,半透明加深底;没有 note 就不叠);
    没画面的操作 —— 一页操作卡(查找 / 读取给参数和结果内容,对话类只给内容,失败只给错误);小结 —— 一页(绿 ✓ / 黄 ! / 红 ! + 已完成 / 待办 / 问题)。
    **不再用「✓ 工具名 耗时 {json}」那种条目式控件**(`ToolDetail` 只剩详细模式在用)。视觉记录由 `ToolVisual.tsx` 的 `loadVisualRecord` 按 id 缓存。
  - 顶部一行:这一页是什么 + 不在跟踪最新时的「⏭ 点击跟踪最新」(图标 + 文字,无底色,悬停出底色);底部一行:圆点 + 页数。
    支持拖动、点两侧、横向滚动、方向键翻页。圆点只显示当前页附近最多 5 个(窗口外还有页时最外侧的点缩小);其余页照样缓存,都翻得到。
  - **跟踪最新**:默认停在最新一项 —— 还在跑的消息一页页往后翻(下一页渲染好了才翻,两次至少隔 1.5 秒),跑完的消息直接停在最后一页。
    点了不是最新的图标、往前翻就不再跟,顶部出「点击跟踪最新」;点最新的图标、翻回最后一页、点那个按钮又接着跟。
  - **图标状态**:控件当前显示的那一项的图标 —— 用户在这个气泡里点过图标 / 翻过页之后是 `is-selected`(强调色描边 + 略放大 1.06);
    还没点过、消息在跑时是 `is-focus`(只发光);跑完的历史消息没点过就都不标。
  - 带控件的助手气泡占满可用宽度(85%),控件铺满气泡;画框固定 180px 高(文字页在框里滚),图片按原尺寸显示(只缩不放)、在画框里居中,修改页的前后动图成对居中。
  - **只能翻到渲染好的页**:图片加载完(或确定取不回来)、修改页的动图都出来(或失败,`Gif` 的 `onSettled`)才算好,文字页天生就好。
    往没好的页翻不会切过去,先让它开始渲染(一次只预先渲染一页),好了再自动切;当前页没好时画框盖「画面渲染中…」。
- 输入框工具条的附件钮是曲别针(`IconPaperclip`),顶栏的开关叫「显示思考」。
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
`list_cards`(含 controls 和 defaults)、`get_project`、`get_selection`、`add_clip`、`update_clip`(params/时段/换卡)、`remove_clip`、序列管理(`list_tracks` / `add_track` / `remove_track` / `update_track` / `move_track`,见 `src/mcp/tools/trackTools.ts`)、滤镜库(`list_filters` / `create_filter` / `update_filter` / `remove_filter` / `apply_filter`,数值和三条合成管线的翻译在 `src/kernel/filters.mjs`,门槛在 `src/editor/right/filterTools.ts`)、音频效果库(`list_audio_fx` / `create_audio_fx` / `update_audio_fx` / `remove_audio_fx` / `apply_audio_fx` / `measure_audio`,数值在 `src/kernel/audioFx.mjs`,预览和导出共用的 Web Audio 节点图在 `src/audio/fxChain.ts`,门槛在 `src/editor/right/audioFxTools.ts`;导出的混音在 Chrome 的 OfflineAudioContext 里渲,见 `src/audio/renderMix.ts` 和 `scripts/export-frames.mjs` 的 mixAudioInChrome)、`seek`、`play/pause`、`set_theme`。
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
