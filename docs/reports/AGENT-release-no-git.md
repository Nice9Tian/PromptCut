# AGENT-release-no-git:发版打包不再带 `.git`

分支 `claude/release-no-git`(起点 main `729ce7f6`)。状态:完成,待主会话审。

## 任务

`--from-head` 的临时 worktree 根目录下 `.git` 是指针**文件**,`prepare-runtime.mjs` 的 `shouldCopyApp` 只在 `isDir` 时才查 `SKIP_DIRS`,于是它被拷进 `runtime/app`,进了补丁清单。要求:文件和目录形态都跳过;核对 `make-patch.mjs`;加单测。

## 改了什么

- `desktop/scripts/prepare-runtime.mjs`
  - 新增 `SKIP_ANY_KIND = new Set([".git"])`,`shouldCopyApp` 第一行先按名字查它,**不看是文件还是目录**。
  - 导出 `shouldCopyApp`、`copyRecursive`(函数体不变),并把末尾无条件的 `main()` 改成「仅当本文件是 `process.argv[1]` 时才跑」,这样单测可以 import 而不触发装配。直接 `node scripts/prepare-runtime.mjs [...]` / `npm run prepare-runtime` 行为不变(单测里也用 `--check` 起了一次,确认 main 照跑)。
  - `computeAppSrcHash` 也走 `shouldCopyApp`,所以源码指纹随之忽略 `.git` 文件。副作用(好的一面):`--from-head`(worktree,`.git` 是文件)与普通工作区(`.git` 是目录,一直被跳过)算出的指纹以后一致,不再因为多一个 `.git` 条目而可能对不上。第一次重新组装之前,PC 上现存 runtime 的 `VERSIONS.json` 里记的是旧指纹(含 `.git`),`--check` 可能报一次「落后于源码」,重跑一次 prepare-runtime(出包本来就会)即可。
- `desktop/scripts/make-patch.mjs`:`listPayloadFiles` 是唯一收集补丁文件清单的地方,它走的是 `runtime/app`,不会读到运行时目录之外的 `.git`;但 `runtime/app` 本身可能是旧版本留下的(PC 现在那份就带着 `.git` 文件),而 `make-patch` 能吃现成的 `runtime/app`,所以在每一层加了 `if (ent.name === ".git") continue;`(一行加注释)。结果:即使 runtime 是旧的,补丁清单也不再有 `.git`。
- `desktop/test/prepare-runtime-filter.test.mjs`(新,4 条)。

## 为什么之前漏掉

`SKIP_DIRS` 里写了 `.git`,但过滤条件是 `if (isDir && SKIP_DIRS.has(name)) return false;`。普通检出里 `.git` 是目录,一直被挡住;`build-release --from-head` 开的临时 git worktree 里 `.git` 是 `gitdir: …` 指针文件,`isDir` 为假,整条 SKIP_DIRS 判断被跳过,又不匹配 `SKIP_FILE_PATTERNS`/`SKIP_PATH_PATTERNS`,于是被拷进 `runtime/app`,再被 `make-patch` 收进 manifest(0.7.13 的 manifest 第一个键就是 `".git"`)。

## SKIP_DIRS 里其它名字要不要同样处理

没有,不动。其它名字(`node_modules`、`out`、`dist`、`.vite`、`desktop`、`target`、`.cache`、`.pc-*`、`.claude`、`.wrangler`、`release`、`exports`、`work`、`__pycache__`)只在目录形态才是构建产物 / 本机状态,且都是普通词(`release`、`work`、`desktop`、`out`、`target`),同名**源码文件**应当照拷,按名字一刀切反而会误删。核对:`git ls-files` 里没有任何一个基名与这些名字相同的文件,所以现状也无遗漏。真会以文件形态出现的只有 `.git`(worktree 与子模块指针)。注释里已写明理由,以后往 `SKIP_ANY_KIND` 加名字前先想这一点。

## 单测怎么构造的

`mkdtemp` 临时目录里搭源码根,用真实的 `copyRecursive(src, dest, shouldCopyApp)` 拷,再断言目标里的文件清单:

1. `shouldCopyApp` 直接断言:`.git` 文件与目录都 false;`.gitignore`、`.github`、普通文件、`src` 目录 true;`node_modules` 目录 false;名为 `release` 的**文件** true(证明没有一刀切)。
2. 根上放 `.git` 指针文件 + `package.json`、`src/main.ts`、`server/a.mjs`、`.gitignore`、`node_modules/foo/index.js`:目标恰为 `.gitignore`、`package.json`、`server/a.mjs`、`src/main.ts`。
3. 根上 `.git` 目录(HEAD、objects)+ 嵌套 `vendor/sub/.git` 文件(子模块)+ `vendor/nested/.git/config` 目录 + 正常文件:目标里三种 `.git` 都不在,正常文件都在。
4. 以子进程直接执行脚本 `--check`,断言输出里有 `PromptCut prepare-runtime (--check)`,证明作为脚本时 main 照跑(只认「起来了」,不依赖本机有没有运行时,所以 PC 上也稳)。

回归验证:改动前的代码里第 1~3 条会失败(`.git` 文件被拷过去),这里没单独回退跑,是按代码路径推出来的。

## 验证

- `npx tsc -b --force`:退出码 0。
- `npm test`:tests 4244,pass 4242,fail 0,skipped 2,cancelled 0。
- `cd desktop && node --test test/*.test.mjs`:tests 20,pass 20,fail 0(原有 `make-extension.test.mjs` 实测 16 条,不是任务书写的 23;新增 4 条,合计 20。任务书的 23 大概是别处记的数字,无影响)。`desktop/` 的依赖没装也跑得起来:这两个测试文件只用 node 内置模块。
- `node desktop/scripts/prepare-runtime.mjs --check`:退出码 1,`Sidecar not found`——笔记本没有桌面运行时(binaries/ 不存在),这一步在改动之前就是这样,与本改动无关;不是回归。真正的出包验证按任务书由 PC 出包时核对 manifest 无 `.git`。
- 没跑 G0-R、探针(不涉及渲染)。

## 没做成 / 待主会话

- 没有真实 worktree 端到端出包验证(笔记本无运行时)。PC 下次出包请核对 `manifest-<版本>.json` 的 `files` 里没有 `.git`,且 `runtime/app/.git` 不存在。
- 对任务书的更正:原有测试数是 16 条,不是 23 条。
