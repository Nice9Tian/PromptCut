# A0 两条验收补核（Opus，2026-09-19）——两条都过

> Agent 写 `report.md` 时被工具规则挡下，这份由主 Agent 从它的最终回复整理存档。原始数据、截图、脚本（`audit-caps.mjs`、`caps-table.md`、`caps-with-usercards.json` 等）在同目录。

## 验收一：89 张里 `unknown` 为 0；粒子卡全部 `canvasHeavy` —— 过

做法：5197 上开 `/?nosetup=1`，页面里动态 import `/src/cards/index.ts`、`/src/kernel/registry.ts`、`/src/render/frameMode.mjs`、`capabilities.json`，对 `allCards()` 每张调真实的 `cardCapabilities(def)`。

| 项 | 实测 | 口径 |
|---|---:|---|
| 注册卡总数 | 89 | `docs/default-animation-card-inventory.md:5` |
| `unknown` | 0 | 清单为空 |
| independent / belowDependent / sourceDependent | 77 / 12 / 0 | `capabilities.md:40-42` |
| `canvasHeavy: true` | 55 | 54 张粒子 + `scene-3d` |
| 粒子卡非 `canvasHeavy` | 0 张 | |
| `direct` / `stateful` | 1（`caption-track`）/ 88 | |

来源分布 magicui 5 + native 24 + assets 58 + probe 1 + user 1 = 89；审阅表命中 = 精确 35 + 通配 `particles-*` 53 + 不进表 1（`composite`）。89 张源码里没有一张自己写 `compositing` / `canvasHeavy`，89 张全写了 `frameMode`。

- 17 张带 `timing()` 的卡里只有 `mu-typing` 在某些参数下动态推导会翻成 `direct`，被固化成 `stateful`（`src/cards/magicui/typing-animation.card.tsx:28-32` 写明理由，方向更保守）。
- 组合卡：`derivedCompositing` 逻辑本身对；但传**真实的 `clip.parts` 形态**（`PartInstance` 只有 `partId`）得 `unknown`，因为 `cardGraph.mjs:136` 传的就是它（`src/cards/capabilities.md:144-151` 记为有意为之）。
- `server/test/cards.test.mjs` 50/50 全过（新增 `independent` 被拒 ×3 路、只改文案通过、`author` 缺 `frameMode` 被拒 / `install` 照收）。

## 验收二：打开旧 `.proc` 不被拦 —— 过

静态：`checkCardSource` / `checkSourceEdit` 生产调用点只有 `vite-plugin-cards.ts:897`（install 档）、`:1192`、`:1456`；加载路径唯一碰到的是 `installBundledCards`，`procCards.ts:97-99` 对被拒的卡只 `console.warn` 不抛错。

真机（`/?nosetup=1&open=<绝对路径>`，puppeteer）：

| 样本 | 特点 | 片段数 文件/store/DOM | 未捕获异常 | 结果 |
|---|---|---|---|---|
| `PromptCut-Skill\20260907-225849-lyfe\project.proc` | 最老有内容样本 | 11/11/11 | 0 | 开得起来 |
| `runtime\app\.pc-projects\20260910-wu2hng.proc` | 6 张 tokyo7-* 定制卡（源码没写 frameMode） | 15/15/15 | 0 | 开得起来 |
| `runtime\app\.pc-projects\20260913-0npnrp.proc` | 3.8 MB，6 张打包卡 + snapshots | 73/73/73 | 0 | 开得起来 |
| `out\ui-freeze-20260913\recovered-unsaved.proc` | 裸 Project（无 format 外壳） | 74/74/74 | 0 | 开得起来 |
| 合成 `legacy-python.proc` | 2 个 python 节点 + cardDefinitions | 12/12/12 | 0 | 开得起来 |

Python 样本：`cardDefinitions` 整字段没了、python 节点 0、素材段清掉 `nodeId` 保留 `mediaId`、提示「2 张 Python 卡已停用，不再显示」只出现一次。5 份素材全部无 `hash`：按 `path` 走 `/api/media/file`，全 200/206，「(缺失)」0 个。

## 三条要记在案的口径

1. **「unknown 为 0」只对仓库默认注册表成立**：装上真实项目的 10 张定制卡后 99 张里 10 张 `unknown`（项目内嵌卡按 A0.5 判 `unknown`）。
2. **真实带部件的组合卡片段一律 `unknown`**。
3. `wa-texture` 真有 `backdrop-filter` 却算 `unknown`；`capabilityGuard.ts:46` 只查「说自己 independent」的卡，所以不触发——别把「兜底没报警」当成「它是独立卡」。

临时拷进 `src/cards/user/` 的 11 个文件已删净，`src/` 和 `server/` 零改动；5197 已关。
