# PromptCut 编辑器 · 契约(第二阶段)

第一阶段(DESIGN.md)验证了内核:Motion 动画 + Chrome 虚拟时间逐帧导出。第二阶段把它长成一个能用的编辑器。
**先读 DESIGN.md,再读本文。** 内核目录 `src/kernel/` 的接口仍然冻结。

## 布局(src/Editor.tsx,已写好)

```
┌ TopBar:项目名 · 播放/重播 · 撤销/重做 · 主题选择 · 导入视频/打开项目/保存项目/导出视频 ┐
├ 左栏 300px      │ 中央 Preview(视频层 + 动效舞台,自适应缩放)   │ 右栏 360px          │
│ LeftPanel       │                                              │ RightPanel(AI 助手)│
├ 底部 224px:TimelineView(多轨时间轴)                                                  ┤
```

四个插槽各由一个任务负责,**只暴露一个固定导出名**:`LeftPanel`、`RightPanel`、`TimelineView`,以及 `src/editor/io/index.ts` 的四个函数。Editor.tsx / TopBar.tsx / Preview.tsx 是壳,不要改;要壳配合的地方在回报里提。

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
`Track { id, name, kind: "overlay" | "video", hidden, locked, clips: TrackClip[] }`,
`TrackClip { id, cardId, start, end, params, mediaId?, mediaOffset?, label? }`。
轨道数组靠后的画在上面。`flattenOverlay(p)` 压平给 Stage;`videoClipAt(p, t)` 找当前视频段。

## 拖放契约(左栏 → 时间轴)

- 拖卡片:`dataTransfer.setData("application/x-promptcut-card", cardId)`
- 拖媒体:`dataTransfer.setData("application/x-promptcut-media", mediaId)`
- 时间轴 drop:按落点算 start 和 track,调 `actions.addCardClip` / `actions.addMediaClip`(kind 不匹配的轨要拒绝并提示)。

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
| `src/editor/left/` | 左栏 |
| `src/editor/right/`、`src/ai/`、`server/`、`vite.config.ts`(加 AI 桥插件) | AI 助手 |
| `src/editor/io/`、`scripts/`、`src/ExportView.tsx`、`vite.config.ts` 里的 `/api/export` 中间件(和 AI 任务协调:各自写成独立 vite 插件文件 `server/vite-plugin-*.ts`,vite.config.ts 只加一行 import) | 导入导出 |

公共文件(`src/Editor.tsx`、`src/store/project.ts`、`src/kernel/*`、`src/main.tsx`、`package.json`)由壳的负责人改;要改就在回报里写清楚。装新包也要在回报里说明并给出理由。

## 参考来源

外部参考材料的清单和阅读范围见工作目录下的 `AGY-TASK-sources.md`(过程文件,不入库)。入库的文件内容和提交信息里不引用外部项目。
