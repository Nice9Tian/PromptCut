# 笔记本复核指令：四段连做的带耗时门槛的项

给主会话在笔记本上线时发出（格式照 `Master-Execution-Plan.md` 6.3 节：编号与目的、分支与提交哈希、环境变量名、逐条命令、每条的期望输出、回传物）。**自包含**：笔记本会话不需要读别的文档就能照做；下面凡出现 `<…>` 的地方由主会话在发出前填好。

## 1. 编号与目的

**LR-4S-1。** 四段连做（声音、在线执行用户卡与图卡、云节点渲染服务、云端 Agent）在集成分支最终提交上的完整验收里，带耗时门槛的项在 PC 上只作参考（`verification.md`「性能基准机」：PC 性能远超常人，这类项在笔记本上过才算过）。本指令让笔记本把这些项按过 / 不过判一遍。在笔记本上挂就是真挂，不得判为「机器差异」豁免；确实该改门槛的，改门槛要经用户确认。

## 2. 分支与提交哈希

- 分支：`<分支名，留空位：集成分支合入 main 之后是 main，合入前是 claude/four-stage>`
- 提交哈希：`<提交哈希，留空位>`
- 同步：对方 `git fetch && git checkout <分支> && git pull`，回报 `git rev-parse HEAD`，**与上面的哈希一致才继续**（6.3 节）。不一致或抓不到，停下报告，不要在别的提交上跑。
- 工作区：在一个干净的 worktree 里做（`git worktree add .worktrees/laptop-recheck <哈希>` 或别的专用目录），**不要碰笔记本上用户在用的编辑器、桌面版运行副本、用户数据目录**；依赖往上解析到主工作区的 `node_modules`，不建 junction、不 `npm ci`、不装新依赖。
- 端口：笔记本自己的段 `5580～5599`（下面都按它写；其中 `5580～5582` 是共享 dev server，`5583～5585` 是第二台）；不碰 `5190～5192`、`5203～5205`、`5210～5212`。文档服务与素材服务端口 `8760～8769`。

## 3. 环境变量名（只写名字）

- 一般不需要设任何变量。运行器与探针自己摘掉外部的 `PROMPTCUT_EXPORT_DIR`、`PROMPTCUT_DATA_DIR`，产物都落在临时目录或 `--out`。
- 可选：`PC_CHROME_ARGS`（只在需要给探针起的 Chrome 加启动参数时设；不要用它关 TLS 校验）。
- **不要设**任何令牌类变量（`PROMPTCUT_CLUSTER_TOKEN`、`PROBE_MAIL_TOKEN` 等）：本指令里的项都是本机替身，不连任何远端、不连阿里云、不连新节点。

## 4. 开跑之前：环境记录与「频率检查」（重要）

这台笔记本有过一段约两小时的时间：全核频率只有标称的 74%，读数慢了四成，原因不明。那种时段里量出的耗时**不作数**。所以：

1. **会话静置**：开跑后到结束，笔记本上不要做别的事（不开别的重活、不让屏保或杀毒扫描在跑、插着电源、电源计划选「高性能」或「平衡」且未省电模式）；本会话只等，不在跑的时候读写大文件。
2. **用后台脚本量，不用交互窗口盯着量**：先起采样脚本（隐藏窗口），再起运行器；两者都在后台。
   ```
   $out = "work\four-stage\laptop-recheck\<提交前 8 位>"
   New-Item -ItemType Directory -Force $out | Out-Null
   Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoProfile','-File','scripts\acceptance\sample-cpu-performance.ps1','-Out',"$out\cpu-perf.csv",'-StopFile',"$out\cpu-perf.stop"
   ```
   （脚本每 5 秒采一次 `\Processor Information(_Total)\% Processor Performance`；PC 上 turbo 时会高于 100%，正常。）
3. **采样期间 `% Processor Performance` 低于 100% 的，这一轮的计时项不作数**：结束后 `New-Item "$out\cpu-perf.stop" -ItemType File`，读 `"$out\cpu-perf.csv.summary.txt"`（一行 `SUMMARY {…}`：`minPct`、`avgPct`、`belowFullPct`、`verdict`）。`minPct < 100` 时，**不要把本轮结果当过 / 不过上报**，把采样汇总原样回传，说明「频率不足，计时项不作数」，等频率恢复后（再起一遍采样脚本，读数回到 100% 以上）重跑全部带门槛的项。允许因为瞬时抖动偶尔掉到 100% 以下一两个采样点的话由主会话判；默认标准就是整段 `minPct ≥ 100`。
4. 记环境（回传物要用）：`node -v`；Chrome 版本：`node -e "import('puppeteer').then(async p=>{const b=await p.default.launch({headless:true});console.log(await b.version());await b.close()})"`；环境指纹：取自第 5 步里 `ready-index-probe` 的结果 JSON 的 `environment.fingerprint`；`systeminfo` 里的 CPU 型号与内存、`powercfg /getactivescheme`。

## 5. 逐条命令与期望输出

所有命令在 worktree 根目录执行，**后台静默运行**（Node 起子进程带 `windowsHide`，运行器已处理；你自己起命令用 `Start-Process -WindowStyle Hidden` 或让运行器去起）。用运行器一次串行跑完（**重的项串行，不要并行**）：

```
node scripts/acceptance/four-stage-acceptance.mjs --authoritative --port-shift -110 --dev-port 5580 --dev-main-port 5583 ^
  --only GR-6,GR-7,GR-8,GR-9,GR-10,P-c10-browser-a4,P-c10-browser-full,P-c10-user-card,P-online-stage-watch,P-online-stage-handshake,P-m7-browser,P-tier-switch,S1-4,S3-1 ^
  --out work\four-stage\laptop-recheck\<提交前 8 位>\run --flaky-rerun 1
```

- `--authoritative`：带耗时门槛的项按**过 / 不过**判（PC 上它们记 `ref-pass` / `ref-fail`）。
- `--port-shift -110 --dev-port 5580 --dev-main-port 5583`：把清单里 `5690` 段的端口平移到笔记本的 `5580` 段（文档与素材服务的 `8760` 段不动）。
- `--flaky-rerun 1`：不过的项再重跑一次，看是不是偶发；**两次都不过才是真挂**，一过一不过记「不稳定」并如实回传，不要只报过的那一次。
- 在线构建由运行器自动做（`vite build --mode online` 到 `--out` 下的 `dist-online/`）。
- 被中断可 `--resume --out <同一目录>` 续跑（哈希没变）。`S3-1` 在清单里要求本检出有 `scripts/probes/hosted-render-probe.mjs`，没有就记「缺」，不是失败。

下面逐项写清命令、期望和门槛（运行器按同样的命令跑；若运行器出问题，可手工照下面的命令跑，端口已是笔记本的段，`<dist>` 是在线构建目录，先 `node node_modules/vite/bin/vite.js build --mode online --outDir <dist>`——worktree 里没有 `node_modules/vite`，用 `node -e "console.log(require.resolve('vite'))"` 找到 vite，或直接用运行器）：

| 编号 | 目的与门槛 | 命令（笔记本端口） | 期望输出 |
|---|---|---|---|
| GR-6 | 就绪索引端到端（上一轮列为笔记本复核项；探针内的等待时限随机器负载） | `node scripts/probes/ready-index-probe.mjs --port 5580` | 退出码 0，结果 JSON `fails` 为 `[]`；`environment.fingerprint` 是 16 位十六进制 |
| GR-7 | 轨道流生产：一条 1080p 全幅流 15 帧分段编码 **p50 ≤ 300 ms**（前提：没有别的编码器争 CPU） | 先起 `node node_modules/vite/bin/vite.js --port 5580 --strictPort --host 127.0.0.1`，再 `node scripts/probes/stream-produce-probe.mjs --origin http://127.0.0.1:5580` | 退出码 0，末行 `PASS`，JSON `fails` 为 `[]`，`bench` 里的 `p50` ≤ 300 |
| GR-8 | 组流（把解码器预算压到 1），同样的编码 p50 门槛 | 同上加 `--group` | 同上，且组流的分段里恰好是组内那几张卡 |
| GR-9 | 普通预览兜底顺序：`transparent` 拍数为 0（逐拍记录，主线程开销随负载） | `node scripts/probes/preview-fallback-probe.mjs --origin http://127.0.0.1:5580` | 退出码 0，末行 `PASS`，`fails` 为 `[]` |
| GR-10 | 同上，由页面自己触发预渲染（`--page-preload`） | 同上加 `--page-preload` | 同上 |
| P-c10-browser-a4 | C10 在线普通档 A1～A4：A1「播放 10 秒主文档长任务 0」 | `node scripts/probes/c10-browser-probe.mjs --only-a4 --no-video --base-port 5580 --dist <dist>` | 退出码 0，末行 JSON `ok:true`、`fails:[]`；A1 长任务数 0 |
| P-c10-browser-full | C10 完整版 A1～A5（A5：独立渲染主机认领清单计划） | `node scripts/probes/c10-browser-probe.mjs --base-port 5580 --dist <dist>` | 退出码 0，`fails:[]`。**已知：main 上 A5 超时**——两次都超时就如实回传，不要放宽等待上限 |
| P-c10-user-card | 用户卡端到端（A1 长任务 0；用户卡那一步在 PC 上约 5 分钟） | `node scripts/probes/c10-browser-probe.mjs --user-card --only-a4 --no-video --base-port 5580 --dist <dist>` | 退出码 0，`fails:[]` |
| P-online-stage-watch | 舞台「握手后又断」的看守：断开判定 15 s + 心跳 5 s + 重载时限 20 s | `node scripts/probes/online-stage-watch-probe.mjs --dist <dist> --base-port 5580 --out <截图目录>` | 退出码 0 |
| P-online-stage-handshake | 首次握手计时：S4「挂上到第一次画出 ≤ 24 秒」、每台 iframe 的 20 s 计时 | `node scripts/probes/online-stage-handshake-probe.mjs --dist <dist> --base-port 5580 --out <截图目录>` | 退出码 0 |
| P-m7-browser | M7 纯浏览器节点：A4 最慢锚点段 **≤ 30 s**、A5 让路后恢复、A12 长任务 0；`--timing-authoritative` 表示按笔记本的门槛判 | `node scripts/probes/m7-browser-probe.mjs --role all --timing-authoritative --base-port 5580 --out <目录>` | 退出码 **0 或 3**（3 = 只剩 W7 真跨机项待复核，算过）；输出里 A4 最慢锚点段数字、A5 毫秒数、A12 长任务数都要回传。**已知：A10 抢卡一步历史上贴着 300 s 等待上限**，两次都挂如实回传 |
| P-tier-switch | 两档素材换档的时间断言：T5 黑帧 0、播放换档误差 0 帧、T7 超时提示 | 先起 dev server（同 GR-7），再 `node scripts/probes/tier-switch-probe.mjs --origin http://127.0.0.1:5580 --remote-port 5586 --out <目录>` | 退出码 0，`fails` 为 `[]` |
| S1-4 | 声音预览（桌面、在线、重开、在线合成）：对齐阈值 `ALIGN_SEC` 0.15 s 占比 ≥ 90%、暂停后 ≤ 300 ms 停声 | `node scripts/probes/sound-preview-probe.mjs --mode both --base-port 5580 --doc-port 8762 --asset-port 8763 --dist <dist> --out <目录>` | 退出码 0，`{"ok":true,…,"fails":[]}` |
| S3-1 | 渲染服务本机整套演练，其中 `load` 步：渲染进行中与空闲时文档服务 `/healthz` 往返时延对比 | `node scripts/probes/hosted-render-probe.mjs --base-port 5580 --doc-port 8760 --asset-port 8761` | 退出码 0，`ok:true`、`fails:[]`；`load` 一步的两个时延数字回传（本机数字只作参考，不设数值门槛，但不得出现渲染把文档服务拖到超时） |

「期望」里写「退出码 0」的，运行器同时核对结果行的 `fails`（非空即不过）。**每一项如实记过 / 不过 / 不稳定（重跑几次几过）/ 跑不了（缺什么）**。

## 6. 回传物

按 6.3 节：

1. 运行器的 `results.json`、`summary.txt`、`logs/` 整个目录（压缩成一个文件回传，或在对话里贴 `summary.txt` 全文并给出路径）；
2. 每一项**完整的标准输出**（`logs/<编号>.log`，不过的项必须带）与探针的 **JSON 结果行**（运行器的 `resultLine` 已摘出，但原文以日志为准）；
3. `node -v`、Chrome 版本、环境指纹、CPU 型号与内存、电源计划；
4. 采样脚本的 `cpu-perf.csv` 与 `cpu-perf.csv.summary.txt`（`minPct`、`avgPct`、`belowFullPct`、`verdict`）——**这是判这一轮作不作数的依据**；
5. `git rev-parse HEAD`（与指令里的哈希对）；
6. 一句话结论：全部过 / 哪些不过（标已知项）/ 频率不足本轮不作数。

**回执**：本指令要回执；回执里带你核对过的提交哈希。送达不等于已读，沉默不算同意。超时没回执，主会话在对话里报告、不重发第二遍，由用户决定（笔记本 offline 不算超时）。

## 7. 不要做的

- 不推送、不合并、不改仓库里任何文件；不装补丁；不碰笔记本上用户的编辑器与数据目录；不结束不是自己起的进程；
- 不连任何远端（新节点 149.88.94.84、阿里云都不碰）；
- 不改门槛、不放宽探针里的等待上限来「让它过」；
- 测试期间不向扬声器出声（声音探针 Chrome 带 `--mute-audio`，探针已处理，别另开有声的东西）。
