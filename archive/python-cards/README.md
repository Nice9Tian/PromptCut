# 归档：Python 卡运行时

## 为什么归档

Python 卡（`cardDefinitions` 里 `language: 'python'` 的定义 + `cardNodes` 里
`adapter: 'python'` 的节点）由 **JS 图卡**接替：一张普通的 `CardDef`，源码是
`src/cards/user/<id>.tsx` 文件，写 `card()`（视觉）或 `audio()`（音频）而不写
`Component`，输入来自 `sources[name]`，GLSL 走同一个 `CardGpuExecutor`。

Python 这条路独有的能力只有两样——多输入图（`source['A'].time(t)`）和
NumPy 像素 / 音频块——两样图卡都有；GLSL 那条路的像素工作本来就全在浏览器里跑。
留着这套运行时的代价却不小：

- 一整条 Rust LPAC runner + 内置 Python + NumPy/Pillow 的打包链路，只在 Windows 上成立；
- `/api/card-runtime` 每帧一次 HTTP 往返，播放和拖动都要等它；
- 89 张内置卡里**没有一张**是 Python 卡，实际用量为零。

所以整套运行时（Rust runner、Python SDK、Node 服务、浏览器端 `PythonCard`、
文档、验证脚本）一次性移到这里，不再参与构建、测试和打包。仓库里不再有
`/api/card-runtime`、`PythonCard`、`adapter: 'python'`。

**旧 `.proc` 不向前兼容**（用户决定，滤镜、转场、音效在内）：打开项目时
`cardDefinitions` 整个字段被丢弃、`adapter: 'python'` 的节点被丢弃、引用它们的
片段清掉 `nodeId`，通知栏提示一次「N 张 Python 卡已停用，不再显示」。
不做占位卡、不做 `list_cards` 提示、不自动翻译。

## 最后可用的提交

```
0ba58cbb16ce772c558b4418a527e88fa39cfced
```

这个提交（本次归档的父提交）是 Python 卡运行时最后一次完整可用的状态：
`tools/card-runtime` 能 `cargo build --release`，`/api/card-runtime` 四个端点齐全，
`scripts/verify-python-cards.mjs` 等九个验证脚本都还在原位并指向真实路径。

## 怎么恢复

1. 把这棵树按原路径搬回去（相对布局在这里原样保留）：

   ```
   archive/python-cards/python/promptcut_cards/   → python/promptcut_cards/
   archive/python-cards/python/tests/test_cards.py→ python/tests/test_cards.py
   archive/python-cards/tools/card-runtime/       → tools/card-runtime/
   archive/python-cards/server/*.mjs|*.ts         → server/
   archive/python-cards/server/test/*.test.mjs    → server/test/
   archive/python-cards/scripts/*                 → scripts/
   archive/python-cards/docs/*                    → docs/
   archive/python-cards/python-card-pipeline-agent-prompt.md → 仓库根
   archive/python-cards/src/render/cards/PythonCard.tsx      → src/render/cards/
   ```

   （`tools/card-runtime/target/` 从来不进 git，恢复后重新 `cargo build --release`。）

2. 把下面这些接回去——它们在归档时被删掉，git 历史里照着上面那个提交找：
   - `vite.config.ts` / `vite.prerender.config.ts` 的 `cardRuntimePlugin` import 和插件数组项；
   - `desktop/scripts/prepare-runtime.mjs` 的 `stepCardRuntime`（Step 6）、它在主流程里的调用、
     以及 Python 步骤里 `cardSource` / `cardDest` / `digest` 的断言与复制；
   - `desktop/scripts/prepare-python.mjs` 里 `import promptcut_cards, numpy, PIL` 那条健康探针；
   - `src/render/FrameScene.tsx` 里挂 `<PythonCard>` 的那一支；
   - `src/kernel/cardGraph.mjs` / `cardAuthoring.mjs` 的 `'python'` adapter 分支、
     `project.cardDefinitions` 字段、`saveCardDefinition` / `patchCardDefinition`；
   - `src/audio/cardAudio.ts` 的 `/api/card-runtime/audio` 取块路径；
   - `server/mcp-tools.mjs` 的 `create_card` python 字段和 `edit_card.metadata`。

3. `.proc` 的丢弃分支在 `src/editor/io/proc.ts` 的 `dropPythonCards`——恢复运行时的话
   先把它拿掉，否则旧项目里的 python 定义仍然会在加载时被丢掉。
