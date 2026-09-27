# AGENT-eol-eperm 报告

分支 `claude/eol-eperm`，worktree `.worktrees/eol-eperm`，基于 main a038948。端口段 5630～5639（dev server 5630，舞台 5631 / 5632）。

## 任务

两处 M8（下一阶段）之前的遗留：

1. 页面侧卡片源码版本（`src/render/cardSourceVersion.mjs`）拼源码时不统一换行，Windows 的 CRLF 检出与 LF 检出算出的成本身份键不同，在线构建的分块哈希也不同。改成与服务端代码版本（`server/frame-code.mjs`）一致的 CRLF→LF。
2. 创建方写成本记录时 `card-costs.json.*.tmp → card-costs.json` 改名在 Windows 上偶发 EPERM（`AGENT-tier-reload-seek.md` 的 T9 第 2 轮，即「换档 + 重载 + 跳转」那组跨机用例的第 2 轮）。改名遇 EPERM / EBUSY / EACCES 时有限次退避重试。

## 做了什么

### 1 换行统一

查下来在线构建的分块哈希不同**不只是身份键的事**：Vite 自带的 `?raw` 加载把文件原文照字面塞进 `export default "..."`，CRLF 检出的原文带 `\r\n`，内嵌源码表的字符串本身就不同，分块内容跟着不同。所以分两层改：

- `src/render/cardSourceVersion.mjs`：新增并导出 `normalizeEol`，拼源码前每个文件先 CRLF→LF（口径同 `frame-code.mjs` 的 `textOf`）。不管源码表从哪来（内置 `?raw` 表、用户卡 `userCardDependencies`、`.proc` 带来的源码），算出的源码版本都与换行无关。
- 新增 `server/raw-eol.mjs`：`enforce: 'pre'` 的 Vite 插件，项目 `src/` 下的 `?raw` 一律交出 LF 原文（先于 Vite 的 `vite:asset`）。三份配置都挂：`vite.config.ts` 的桌面配置与在线配置、`vite.prerender.config.ts`。桌面与预渲染配置里排在 `vitePluginCards()` 之后，卡片改动层（`cardOverridesLoader`，也是 pre）先答它管的文件。
  - 用到 `?raw` 的三处都被覆盖：`src/render/cardSourceFiles.mjs`（内置卡片源码表）、`src/cards/user/index.ts`（用户卡源码与依赖，打包 .proc 和身份键用）、`src/ai/roles/index.ts`（角色 .md）。
  - 插件还把在线构建的 `index.html` 统一成 LF（`transformIndexHtml` 之后 Vite 拆入口 `<script>` 时还会在 `</body>` 前留一个 CR，所以在 `generateBundle` 的 post 阶段对 html 产物再统一一次）。
- `server/vite-plugin-cards.ts` 的改动层 `?raw` 分支也统一换行（一行）。
- 其它直接拿 `?raw` 原文算哈希的地方：没有。`?raw` 原文只流向 `cardSourceVersion`（身份键）和 `procCards.ts`（打包 .proc，只存不算）。服务端的卡片代码身份（`vite-plugin-cards.ts` 的 `cardCodeIdentity`）和代码版本（`frame-code.mjs`）本来就统一了换行。

单测：`src/render/cardSourceVersion.test.mjs` 加一条（同一组源码 CRLF 与 LF 算出同一个键，显式入口那条路也一样，内容真变仍换键）；新增 `server/test/raw-eol.test.mjs` 三条（只接 `src/` 下带 `?raw` 的绝对路径、CRLF/LF 交出同一段模块代码、插件 load 读盘并登记监听）。

### 2 改名重试

`server/costs-store.mjs` 的 `writeAtomic`（成本记录 `upsertCosts` 与系数覆盖 `saveTuning` 共用）：改名遇 EPERM / EBUSY / EACCES 时同步退避重试，最多重试 8 次，第 n 次等 25·n ms（合计上限约 0.9 s），用尽再抛原错误并删临时文件；其它错误不重试。写法与 `server/auth/store.mjs`、`server/docservice/store/index.mjs` 已有的同名函数一致。

单测（`server/test/costs.test.mjs` 加三条，用 `mock.method(fs, 'renameSync')` 注入）：三种错误码各失败 3 次后第 4 次写成、不留临时文件；一直失败时调用 9 次后抛 EPERM、旧存档不动、临时文件删掉；ENOENT 不重试。

## 影响

- **Windows 上已有的成本记录身份键会换一次**：Windows 上 CRLF 检出的工作区（本机 `core.autocrlf=true`），以及从这种工作区打出的装机版，此前页面侧算的源码版本含 `\r\n`；改后按 LF 算，这些机器上内置卡与用户卡的 `identityKey` 全部变化。旧记录不删，只是不再被命中；探针（`src/editor/probeRunner.ts`，「同一 `(identityKey, device)` 已有记录才跳过」）会按新键把用到的卡补测一遍，效果同第一次在这台机器上打开项目。`demoted` / `pinnedHeavy` 旗标挂在旧键上，也随之失效（被降级或钉死的卡要重新降级 / 钉死一次）。LF 检出的机器、托管端与在线构建产物键不变。
- 由此，同一提交在 CRLF 与 LF 两个工作区上算出的身份键相同，两台机器的成本记录可以互认（此前 PC 与 LF 检出的机器同一张卡的键不同）。
- 服务端的帧库键、代码版本、卡片代码身份不受影响（它们本来就统一了换行）；导出像素不受影响（`?raw` 原文只进身份键与 .proc，不进画面）。
- 角色 .md（`src/ai/roles/`）在 Windows 的开发服务上交给 Agent 的提示词从 CRLF 变成 LF，内容不变。

## 验证

（见下一节，跑完后补。）
