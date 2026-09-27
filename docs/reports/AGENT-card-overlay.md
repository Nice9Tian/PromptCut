# AGENT-card-overlay 报告

分支 `claude/card-overlay`（从 main a038948 拉出），worktree `.worktrees/card-overlay`，端口 5610～5619。

## 任务

修用户卡与改动层的两处 M8 之前遗留：

1. `create_card` 带 overwrite 时新内容被改动层旧版盖住（`PAUSE-2026-09-26.md` 第 4 节、`REPORT-C6.6.md` 第 11 节）。
2. 主机本来没有的用户卡写进检出目录 `src/cards/user/`（`REPORT-C6.6.md` 第 5 节〔裁〕暂时接受、第 11 节记为遗留）：要求主机完全不写检出目录，用户卡加载器也扫改动层。

「改动层」指装机版（桌面、独立渲染主机）数据目录里的 `card-overrides/`，卡片改动写在那里、检出里的原文件当只读底版（`server/card-overrides.mjs` 文件头）。

## 根因

1. **create_card 覆盖被盖住**：`/api/cards/create` 直接 `fs.writeFileSync` 写检出里的 `src/cards/user/<id>.tsx`，没走 `writeCardFile`。这张卡在改动层里已有一份（`edit_card` 改过、卡片同步装过）时，加载钩子 `cardOverridesLoader` 交出的永远是改动层那一份，覆盖写进底版的新内容看不见；「已存在」也只查底版。
2. **主机写检出目录**：用户卡装载入口 `src/cards/user/index.ts` 用 `import.meta.glob` 按真实目录收卡，只看得见检出目录；改动层在数据目录里，glob 够不着。所以 `installBundledCards`（打开 .proc、内容库同步都走它）对「本机没有」的卡只能写底版（注释原话「glob 扫的是真实目录,只写改动层它看不见」），独立渲染主机的同步因此写进检出目录。按 id 找卡（`findCardFile`）、源码闭包（`localImports`）、全部卡片（`allCardFiles`）、代码身份的兜底扫描也只看底版目录。

## 修法

- `server/card-overrides.mjs`：新增 `effectiveIsFile`（底版或改动层有这个文件）、`userCardDirEntries`（用户卡目录两边取并集）、`overlayOnlyUserFiles`（改动层有、底版没有的用户卡目录文件）。
- `server/vite-plugin-cards.ts`：
  - create_card 的落盘部分抽成 `createUserCard`（便于单测）：「已存在」按生效的那一份判，写经 `writeCardFile`（改动层优先）。
  - `installBundledCards` 本机没有的卡也经 `writeCardFile` 写；删掉「写底版再顺手换掉改动层残留」那一支。`installSyncedFile` 因此对用户卡也只写改动层。
  - `findCardFile` / `localImports` / `allCardFiles` / `cardCodeIdentity` 认改动层里的用户卡。
  - `cardOverridesLoader`（pre 插件）新增 `resolveId`：底版没有、改动层有的卡片 / 部件文件，解析成**仓库里对应的路径**（文件不存在），load 钩子照旧交出改动层那一份。模块 id 与底版同形，所以热更新、作废、`?raw` 都照改动层已有文件的老路走。
  - 新增清单模块 `src/cards/userOverlay.ts`：磁盘上是空表（开发期、在线构建就是它）；有改动层时 load 钩子换成生成的清单（`userOverlayModuleCode`），列出改动层独有的用户卡，形状同 `index.ts` 的三个 glob。用户卡目录（底版或改动层）增删文件、或写卡写进了改动层时，清单正文变了就 `reloadModule`，热更新沿 `user/index.ts` 冒到 `src/cards/index.ts` 接住（不整页刷新）。
  - 归属表 `_scopes.json` 也走改动层（读 `readEffective`、写 `writeCardFile`）；改动层里还没有时读到检出那份，第一次写连同原条目写进改动层。
- `src/cards/user/index.ts`：三个 glob 各与清单模块合并（同键以 glob 为准；清单为空时原样返回 glob 结果，开发期行为逐字不变）。
- 桌面本机：有改动层，于是 create_card、打开 .proc 装的新卡也进改动层（此前写 `runtime/app/src/cards/user/`，补丁整个覆盖 runtime/app 时有丢失风险）。用户看到的行为不变：卡照样建出、热更新出现、能存进 .proc。已经在 `runtime/app/src/cards/user/` 里的旧卡照常被 glob 收到。
- 没有改动层（开发期、`npm run dev`）：一切照旧写检出目录（CO3 覆盖）。
- 全局代码版本（`frame-code.mjs`）：改动层不在 `src/` 下，本来就不进；新文件 `src/cards/userOverlay.ts` 按磁盘上的空表进全局代码版本（静态内容，不随用户卡变）。

## 提交

| 提交 | 内容 |
|---|---|
| 22e7c3c | 报告骨架 |
| cda999a | 重构：create_card 落盘部分抽成 `createUserCard`（行为不变） |
| 2d17a53 | 测试：`server/test/card-overlay.test.mjs`，修前 4 条失败 |
| 71d94be | 修：两处根因（见上）；HC2/HC3 断言改成新语义 |
| ad68251 | 探针：`scripts/probes/card-overlay-probe.mjs` |
| d21e33a | 修：清单模块按生成正文比对（归属表这类非源码文件增删不触发重载） |
| (本提交) | 报告：补全验证 |

## 验证

- **修前失败**（提交 2d17a53，修之前）：`node --test server/test/card-overlay.test.mjs` → 5 条 1 过 4 挂：CO1「覆盖重写之后生效的是新内容」、CO1b、CO2（`installSyncedFile` 写到了检出目录）、CO2b（`findCardFile` 回 null）；CO3（开发期）过。
- **修后单测**：card-overlay、host-card-code、cards、card-sync、card-source、card-overrides 六个文件 87/87 过；CO4（清单模块与解析）也过。
- **类型检查**：`npx tsc -b --force` 退出码 0，零错误。
- **全量测试**：最终提交 d21e33a 上 `npm test` 退出码 0：3416 条，3414 过、0 挂、2 跳过（既有的集成用例 `/api/cards/layout`、SKILL 闸门，需 `PROMPTCUT_BASE`）。此前在 71d94be 上跑过一轮：3413 过、1 挂，挂的是 `server/test/artifact-push.test.mjs` 的 W4（推送队列的计时类用例，不碰卡片代码），单独重跑该文件 3 次均 7/7 过，判为机器忙时的偶发。
- **card-sync-probe**（`--doc-port 5616 --asset-port 5617 --a-port 5610 --b-port 5613`）：`ok: true`，installMs 662、hmrMs 710、remeasureMs 1139，底版仍 v1、A/B 改动层 v2，fails 为空。
- **card-overlay-probe**（新，端口 5610，三次均 `ok: true`）：起来时注册表里有改动层独有的卡 A（a1）和改过的卡 B（b1x）；create_card overwrite 把 B 改成 b2 后注册表 0.5～2.2 s 内变 b2、B 底版仍 b1；create_card 新卡 C 写进改动层、检出用户卡目录文件数 3→3、检出 `_scopes.json` 不变、改动层归属表有 C；注册表 0.3～0.4 s 认出 C；舞台 iframe（5611）画出 C 的记号；删掉改动层里的 A 后注册表里 A 消失；主框架整页刷新 0 次。看过的图：`out/card-overlay-probe/<run>-0-start.png`、`-2-after-create.png`（编辑器正常，改卡后无对话框、未重挂载）、`-3-stage.png`（加片段后的测量遮罩，属现有行为）。
- **G0-R 导出确定性**：worktree 起 vite（5610），`node scripts/verify-determinism.mjs --url "http://127.0.0.1:5610/?export=1"` 退出码 0，Total 1800、Identical 1800、Different 0。
- **像素对比**：`compare-frames.mjs <pc-g0r-base/out/verify-a/frames> out/verify-a/frames` → total 1800、identical 1800、different 0、missing 0、extra 0。
- 验证完已结束自己起的 dev server（5610 的进程树），5610～5612 无监听。

## 需要主会话定的事 / 更正建议

- 桌面本机的新用户卡从此写进改动层（数据目录），不再写 `runtime/app/src/cards/user/`。这是三级机制变化，用户看不出区别（且补丁不再冲掉新卡）；若主会话认为桌面应保持写 runtime/app，需要另议——但那样桌面本机仍写检出目录。
- 归属表 `_scopes.json` 在有改动层时也迁到改动层（第一次写时连同原条目迁过去）。
- `host-card-code.test.mjs` 的 HC2/HC3 原来断言「本机原来没有的用户卡照现有装卡路径写进用户卡目录」，这是被本任务推翻的那条〔裁〕，已改成新语义。
- `REPORT-C6.6.md` 第 5 节那条〔裁〕与第 11 节遗留、`PAUSE-2026-09-26.md` 第 4 节第 1 条可在合入后标为已修。
- `scripts/probes/c66-t9-probe.mjs` 文件头与收尾仍写着「主机同步把卡写进 `src/cards/user/`，收尾删掉」；修后主机不再写那里，收尾删不存在的文件无害，未改（不在本任务清单里），建议顺手更新注释。
- 语义文档 `docs/semantics/` 里没有写改动层与用户卡落点（只在 `docs/plan/c66-design.md` 第 5 节和代码注释里）；本任务没有改语义。
