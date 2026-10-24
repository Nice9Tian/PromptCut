# 验证记录：时间轴上的叠加带

对应改动：把挂在片段上的东西（滤镜、像素映射、音频效果、素材效果卡）收成「叠加卡」，
在时间轴上画成片段里的一条带，并接上右键菜单那一支。

改到的是编辑界面（`src/editor/timeline/`），不是渲染管线、舞台、快照或导出取帧，
所以按 `docs/semantics/guide_files/verification.md`「按改动范围验证」不跑渲染附加项（G0-R）。

## 基线三项

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 通过（零错误） |
| 构建 | `npm run build` | 成功 |
| 影响范围内的测试 | `npm test -- src/editor/timeline/overlays.test.mjs src/editor/timeline/snapTime.test.mjs src/editor/timeline/durationSync.test.mjs src/editor/timeline/cutTabsState.test.mjs src/mobile/agentView.test.mjs src/editor/readOnlyRender.test.mjs src/editor/onlineCardsL.test.mjs src/layering.test.mjs src/pageNodeImports.test.mjs src/tailwind-scan.test.mjs` | 58 项零失败 |

新增单测 `src/editor/timeline/overlays.test.mjs`（17 项）覆盖：清单的顺序（像素映射按 `source.stage`
排在滤镜前后）、悬空引用不列、摘要算不出来不抛错、带里摆不下时收成 `+N`、选中项被挤出时换到最后一格、
以及片段短下去的四档。

## 浏览器里核对（dev server 5203，本 worktree）

没有对应的历史探针可跑（编辑界面这一块本来就没有探针）。按 verification.md「画面」那一项用看的，
逐条记下看到的结果：

| 看什么 | 怎么造的 | 看到的 |
|---|---|---|
| 带画出来了 | 示例项目 10 张卡片段，经 `window.__pcStore` 给 3 个片段挂上滤镜 / 像素映射 / 音频效果 | 挂了东西的片段上半格出现深色带，卡片按处理顺序排：`▾抠绿 ▾压暗 ▾人声清晰` |
| 名字基线对齐 | 同上，同一行里有挂东西的也有没挂的 | 「数字滚动」「模糊浮现」「环形进度」「打字机」落在同一条基线上（没挂东西的片段那一格透明但留着） |
| 名字和时长同一行 | 同上 | `数字滚动 · 已完成目标`，一行 |
| 窄片段 | 把一段改成 0.6 秒（60px） | 带照画、里面只有 `+1`，正文只剩名字、不写时长 |
| 中间那一档 | 把一段改成 1.4 秒（140px） | 一张卡片 + 完整正文 |
| 小行高 | 行高切到「小」 | 不画带；`+2` 排在名字后面靠右；60px 那一段只剩 `+1`、名字不画 |
| 点卡片出菜单 | 点带里的「抠绿」 | 出这一张的菜单：填底的头「抠绿 / 数字滚动」（底色取那一段的轨道色）+「改参数… g>0.6」+「摘掉」 |
| 摘掉真生效 | 点「摘掉」 | `clip.pixelMap` 没了，带重算成 `▾压暗 ▾人声清晰`，菜单关掉 |
| 右键片段的三级 | 右键片段 → 停在「叠加卡」→ 停在「压暗」 | 一级：`叠加卡 2 张 › / 复制 / 在播放头处分割 / 置顶 / 置底 / 删除`，头是不填底的「数字滚动」；二级：`▾ 压暗 亮度 0.72 ›`、`▾ 人声清晰 增益 ›`；三级：`改参数… 亮度 0.72`、`摘掉` |
| 剪辑段的齿孔不穿过带 | 给一个片段加上 `data-pc-cut-segment` 看算出来的样式 | 齿孔的 `repeating-linear-gradient` 落在 `.pc-clip-body` 上；带的 `background-image` 是 `none`；片段自己的底色里也没有齿孔 |

截图（三级菜单同屏）留在会话记录里；这几条都是当场读 DOM / 读算出来的样式确认的，不是看图估的。

## 没做的

- **停用（先关掉看看）**：要在挂载上存一个新字段，属于 `product/project-model.md` 的语义改动，单独一步。
- **上游型（相机）**：还没有这种叠加卡，界面上 `▴` 的位置留着。
- **手机版**：角标 + 「调整」表单里那一节、子导航的「叠加层」，另开一个 PR。
- **传统式的「引用到输入框」**：`quoteOverlay` 的通道已经接到时间轴上，但只有氛围式的详细编辑传它
  （和今天的 `quoteClip` 一样）。传统式要用，得先把右边 AI 面板的输入框接上，另开一个 PR。
- **素材效果卡的「摘掉」**：置灰并写明去编辑分区的节点图里摘（节点要连着输入输出，不是把一个字段置空）。
