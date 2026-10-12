# AGENT-rr-grid-guard 报告

分支 `claude/rr-grid-guard`（基于 main 的 9fb65425），工作区 `.worktrees/rr-grid-guard`。出处：`docs/plan/prerender-products-contract.md` 第 13.2 节「网格」「守门」两行。名词：「网格」指契约第 2.1 节的「这一套有哪几帧」（每 15 帧一张加锚帧）；「守门」指钉住三张内置有声卡的源码版本，防止卡片声音被判过期。

## 做了什么

### 网格

- 新增 `src/render/snapshotGrid.mjs` 和 `snapshotGrid.d.mts`：`SNAPSHOT_STRIDE = 15` 只写在这一处；`gridLocalFrames({ count, firstFrame, anchors })`、`gridWants({ localFrame, ... })`、`gridComplete({ ranges, count, firstFrame, anchors, from, to })`。纯函数，不引任何模块。
  - 就绪区间形状同 `snapshotPick.mjs` 的 `ReadyRange`（本地帧闭区间）；`gridComplete` 不要求区间已合并或有序，坏区间丢掉；`from`/`to` 给一段本地帧起止（夹到 `[0, count-1]`），这一段里没有这一套的帧就算齐；`count` 不是正整数时没有这一套，算齐。
- `snapshotTier` 的页面一侧入口：只新增 `server/snapshot-tier.d.mts`（类型声明）。`snapshotTier` 本身一个字没动。验证了 `src/` 下的 ts 文件可以直接 `import { snapshotTier } from "../../server/snapshot-tier.mjs"`：临时文件 `tsc -b` 通过（返回类型是 `'none' | 'shared' | 'local'`，`@ts-expect-error` 生效），用 vite 的库模式把该文件打包也通过（打完已删临时文件）。没改任何调用方。
- 单测 `src/render/snapshotGrid.test.mjs`（20 条）：count 非 15 整倍数、count 为 1、非法 count、锚帧在格上和格间、锚帧在范围外、firstFrame 不为 0、区间有洞、乱序/重叠/坏区间、只问一段；另有「用格加锚帧的区间跑 C4 选帧，每帧都选得出且只隔不到一格」以及「只按 15 排则锚帧后选不出」的对照。
- 守门：仓库里 `SNAPSHOT_STRIDE` 只在一个文件里定义（扫 src、server、scripts、desktop、tools 下的代码，跳过 `.d.mts` 和本测试）。临时在 `src/render/` 放一个也定义它的文件，守门变红（确认过），已删。

### 守门

- 新增 `src/render/audioCardSourceVersion.test.mjs`（7 条）：用 `loadBuiltinCards` 读内置卡声明，用产品里同一个函数和同一张源码表（`cardSourceVersion(card, builtinCardSourceFiles)`）算 av-pulse、sound-notification、sound-keyboard 的源码版本，钉 sha256；同时用 Proxy 记下闭包里读过的文件，钉清单。
  - 钉住值：av-pulse `c3404bf589753a29…`，两张音效卡（共用入口 `sound-effects.ts`）`7e159196fa213ea4…`。
  - 闭包清单：av-pulse 10 个文件，两张音效卡各 9 个（比 av-pulse 少它自己），合起来正好是契约第 9.2 节「甲组 6 个 + 乙组 4 个」，一个不多一个不少。
  - 另钉闭包里每个文件的全文哈希，只用来在版本变红时指出是哪个文件变了。
  - 失败信息写明：这个值进卡片声音身份，变了会让用户已生成的卡片声音被判「已过期，请重新生成」，要改先问用户，出处第 9.2 节。
- 还额外断言：源码表里声明这三个 id 的文件只有钉住的那一个（产品里按 id 找入口取第一个匹配，不唯一会让取法不稳）。

## 验证

| 项 | 命令 | 结果 |
|---|---|---|
| 网格单测 | `node --test src/render/snapshotGrid.test.mjs` | 退出码 0，20 条通过，0 失败 |
| 守门单测 | `node --test src/render/audioCardSourceVersion.test.mjs` | 退出码 0，7 条通过，0 失败 |
| 类型检查 | `npx tsc -b --force` | 退出码 0，零错误 |
| 全量测试（第 1 次） | `npm test`（设了两个账号环境变量） | 5569 条，5562 通过，4 跳过，3 失败：`server/test/cloud-agent-runs.test.mjs` 的 CA-RENDER-01 / 02 及其父项（等超时，机器忙时偶发，不是我的改动） |
| 该文件单独重跑 | `npm test -- server/test/cloud-agent-runs.test.mjs` | 29 条全过，「npm test 最终结果：零失败」 |
| 源码版本比对 | `node scripts/probes/card-source-version-compare.mjs --base main` | 退出码 0；base main@faf03d4c；88 个入口，changed 0、added 0、removed 0；61 张内置卡代码身份，identityChanged 0 |

说明：全量那一次的 3 条失败是上表的 cloud-agent-runs 里的计时用例，不在任务书点名的偶发清单里，但单独重跑全过，且它和我新增的文件无关（我没动任何产品代码）。没有把测试改松或跳过。第 2 次没有再整套重跑。

### 守门会红的证明

1. 在 `src/kernel/frameMode.mjs` 末尾加一行注释 `// guard-red-probe`，跑 `node --test src/render/audioCardSourceVersion.test.mjs`：退出码 1，4 通过 3 失败。三条「source version is pinned」红，闭包清单三条不红（成员没变，只是内容变了）。av-pulse 的信息：
   「av-pulse 的源码版本变了(钉住 c3404bf589753a29,现在 deb3f8abc30acf9d);内容变了的闭包文件:/src/kernel/frameMode.mjs。这个值进卡片声音的身份(cardAudioIdentity)。变了会让用户已生成的卡片声音被判「已过期,请重新生成」,用户没有同意过。要改这个值或改动闭包里的文件,先问过用户(出处 docs/plan/prerender-products-contract.md 第 9.2 节)。」
   两张音效卡的信息同款（钉住 7e159196fa213ea4,现在 a1d629df789781d3）。
2. `git checkout src/kernel/frameMode.mjs` 还原，重跑：退出码 0，7 通过 0 失败；`git status --short` 为空。
3. 另试了「新文件进闭包」：在 `src/kernel/typingEvents.ts` 末尾加 `import "./clock";`，三张卡的闭包清单测试和版本测试全红（6 失败）；`git checkout` 还原，`git status` 为空。

## 没做成的

无。

## 对任务书或契约的更正建议

- 契约第 9.2 节「甲、乙两组文件清单」与实测一致（av-pulse 的闭包就是那 10 个），不用改。
- 守门测试把「改了闭包里任何文件」都当红：连「合法地」改 `cardGraph.mjs` 之类也红，这是故意的（要先问用户）。以后用户同意集中改一次时，更新测试里的钉住值（`AUDIO_CARDS`、`FILE_HASHES`）。
- 契约第 1.1 节说页面一侧用 `snapshotTier`「不另写一份」。本块只备好了类型声明；`src/editor/snapshotFeed.ts`、`probeRunner.ts` 里现在是否另有一份判档逻辑，我没查（任务要求不改调用方），留给用这个入口的块核对。
- 工作区和 main 的差：main 已前进到 faf03d4c（静默起子进程的合入），本分支基于 9fb65425；合并时没有文件冲突（我只新增文件）。
