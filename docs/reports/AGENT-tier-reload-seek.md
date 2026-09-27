# AGENT 报告：tier-reload-seek（暂停中原尺寸到齐后一直停在小尺寸）

分支 `claude/tier-reload-seek`，从 main `d70fce7` 建。端口段 5680～5689（dev server 5680，舞台 5681/5682；`tier-switch-probe` 的假远程素材服务 5685）。

## 1. 现象（任务书转述）

T9 跨机一轮（T9 = C6.6 的跨机验收：创建方、观察端、独立渲染主机分在不同机器上；run `ht9a0927`，2026-09-27T14:45～14:55Z）：观察端（笔记本上的桌面编辑器，成员身份进阿里云上的共享项目）播放头停在 2.5 s，小尺寸 7.7 s 出画面，原尺寸约 67 s 后到齐，之后 5 分钟一直是小尺寸（没有黑帧）。

## 2. 根因

### 2.1 主会话的推测：不成立（在这一轮里）

推测是「预热槽位先 `driveMedia` 下了 2.5 s、同一个 layout effect 里随后 `load()` 把位置清回 0，之后暂停中没有重渲染」。对照原始记录，这一轮里原尺寸那个槽位在到齐时**不是预热槽位**：

- 媒体日志 `observer-media-log.json`：77.398 s 原尺寸元素 `load()`（`VideoTrack.tsx:316`，`reloadOnComplete` 那条路径），**同一时刻**还有第二个 `loadstart`（77.459 s 两条）；87.435 s 的 `load()` 在 `playability.ts:181` 的 `finish` 里，紧跟着 `abort`、`emptied`。`playability.ts:181` 是可播性探测收尾时卸**离屏探测元素**的那一句，不是槽位元素；87.435 − 77.4 ≈ 10.0 s，正好是远端可播性探测的时限（`PROBE_TIMEOUT_REMOTE_MS`）。所以：77.4 s 可播性探测开始，10 s 内没等到首帧，**超时记「未知」**。
- 可播性还不知道时 `chooseTier` 给小尺寸（`mediaTier.ts` 规则 1 的「原片和小版都在、可播性还不知道：先给小版」），所以 `curV` 仍是小尺寸，没有预热槽位；原尺寸那个槽位是**闲着的**（`releaseMedia`，不跟播放头），日志里它 `currentTime` 一直是 0、没有 seeking，正是闲着的元素该有的样子。
- 「未知」之后 30 s（`RETRY_UNKNOWN_MS`）才准重探，而重探只发生在 `chooseTier` 再被调用的时候，也就是**下一次重渲染**。暂停中、素材服务的集合不再变（`useTierHashes` 集合不变不下发），舞台再没有重渲染 → 永远不重探 → `curV` 永远是小尺寸。5 分钟里日志只有一次探测，印证这一点。
- T9-X3 能过：那一次探测在 10 s 内等到了首帧，`rememberPlayable` → `changed()` → 画面层订阅着可播性（`useSyncExternalStore`）当场重渲染、换档。这一次链路只有 140～170 KB/s，而且**闲着的槽位同时被 `load()` 重载**、和探测元素一起拉原尺寸（77.459 s 的两条 `loadstart`），探测的带宽被分走一半，于是超时。

**根因一句话**：可播性探测超时（记「未知」）之后，重探要搭别的重渲染的车；暂停中没有别的重渲染，就永远不重探、永远停在小尺寸。闲着的槽位在到齐时被重载、和探测抢带宽，是它在慢链路上超时的诱因。

### 2.2 推测里的机制本身：探针的 Chrome 上不出现，照样补上

`load()` 之后默认起播位置留不留得住看浏览器：探针用的 Chrome 152 实测**留得住**（T5c、T5e 的元素事件里 `load()` 时 `currentTime` 读 2.5，元数据到了自己 seeking → seeked 到 2.5），所以 T5e（预热槽位真被重载的情形）修前也过。但驱动不该指望这一点，按任务书「换档不应依赖无关的重渲染」一并补上（第 4 节第 2、3 条）。

## 3. 复现

`scripts/probes/tier-switch-probe.mjs` 加两个场景（`--only` 选场景）：

- **T5c（暂停中、原尺寸慢到）**：和 T5a 同样的开头 —— 远程没连上时原尺寸地址先挂过、404 失败（等待上传方），然后小尺寸到齐、显示在 2.5 s；原尺寸报齐后假远程素材服务**回了头、把字节扣住 16 s**（`--hold-ms`，长过远端探测的 10 s 时限），之后探针不再碰页面任何状态。复现的是 `ht9a0927` 的形状：探测超时、之后没有重渲染。
- **T5e（暂停中、可播性早有结论、预热槽位被重载）**：同样的开头，但两个舞台里先记下「原尺寸放得了」；原尺寸报齐那一轮，之前挂失败过的槽位直接成了预热槽位、并被 `load()` 重载（主会话推测的那条路径）。

跑法（dev server 用自己的端口段）：

```
npx vite --port 5680 --strictPort --host 127.0.0.1
node scripts/probes/tier-switch-probe.mjs --origin http://127.0.0.1:5680 --remote-port 5685 --only T5a,T5c,T5e --out <目录>
```

修前（`c63bf4d`，只加了探针）：`ok: false`，只挂 T5c：

- `超时:T5c:换到原片(原片报齐之后没有任何别的状态变化)`（等了 46 s）
- T5c 元素事件：原尺寸槽位（闲着）1.8 s 被 `load()`，16.0 s 字节放行后 loadedmetadata → seeking → seeked(2.5) → loadeddata，此后什么都没有；`localStorage` 里没有可播性结论（`playable: []`）；显示的一直是小尺寸，帧号 75，采样 5,498 个、黑帧 0。
- T5a：换档 1,869 ms、帧号 75→75、黑帧 0，过；T5e：换档 2,131 ms、帧号 75→75、黑帧 0，过（见 2.2）。

单测也各有修前挂的用例（第 6 节）。

## 4. 修法

1. **`src/render/playability.ts`（根因）**：探测超时仍记「未知」、不写缓存，但离屏元素不卸，接着等到冷却（30 s）结束：
   - 这期间首帧到了 → 按迟到的结论记下（`rememberPlayable`），记下即通知订阅方 → 暂停中的画面层当场换档；
   - 冷却结束仍没有结论 → 卸掉元素、清掉冷却、**主动通知订阅方**重判 → 画面层重渲染、`chooseTier` 重探。重探不再搭别的重渲染的车。
2. **`src/render/VideoTrack.tsx` + `src/render/mediaSync.ts`（诱因）**：到齐时只重载**在用**的槽位（播当前段、换档预热、备下一段）；闲着的槽位不重载、也不记成「判过」，轮到它播或预热时再判、再重载。`reloadOnComplete` 加可选参数 `inUse`（缺省 true，老调用不变）。重载挪到驱动**之前**：`load()` 之后再下的定位才算数；备用槽位重载后照换段时一样停回下一段的起点。
3. **`src/render/mediaDrive.ts`（推测的那条机制）**：被驱动的元素在 `loadedmetadata` 时拿最新目标再判一次（和已有的 `seeked` 同一个做法）。重载或换 src 之后、元数据到了，元素自己回到目标时刻，不等重渲染；浏览器已按默认起播位置 seek 过去时读到 seeking / 已对齐，什么都不做。不再驱动的元素（`releaseMedia` 过的）不动。

顺带查过的其它 `load()` / 换 src 的地方：`VideoTrack` 里只有第 2 条那一处 `load()`；换 src 由 React 在 layout effect 之前做，之后同一轮 `driveMedia`（readyState 0 时记成默认起播位置，元数据到了浏览器 seek 过去，现在另有第 3 条兜底）；备用槽位换段时 `releaseMedia` 后直接设 `currentTime`（同上）。桌面与在线两种页面走同一份 `VideoTrack` / `mediaDrive` / `playability`，行为一致。

## 5. 提交

| 提交 | 内容 |
|---|---|
| `5f7c7fd` | 建本报告 |
| `c63bf4d` | 探针：`tier-switch-probe` 加 T5c、T5e 与 `--only`（修前版本，用来复现） |
| `92a5053` | 修：`playability.ts` 超时后迟到的结论照记、冷却结束主动通知；单测 T6-probe-4b/4c |
| `3a335a9` | 修：`reloadOnComplete` 的 `inUse`、`VideoTrack` 重载挪到驱动之前、`mediaDrive` 在 `loadedmetadata` 再对齐；单测 `mediaDrive.test.mjs`（新）与 `mediaSync.test.mjs` 一条 |
| `743ca6a` 起 | 报告 |

## 6. 验证

全部在笔记本（性能基准机）上跑；同时有另外三个 C10 子 Agent 在跑，机器偏忙。

### 6.1 修前挂、修后过

| 项 | 修前 | 修后 |
|---|---|---|
| `tier-switch-probe --only T5a,T5c,T5e` | `ok: false`，T5c「换到原片」超时（46 s）、帧号只有小尺寸 75（见第 3 节） | `ok: true`：T5a 换档 1,945 ms；**T5c 16,475 ms**（字节扣 16 s，放行后约 0.4 s 换上：迟到的探测结论直接触发换档，没等 30 s 冷却）；T5e 2,146 ms；三者帧号 75→75、换档那一帧帧回调误差 0 帧、黑帧 0（采样 259 / 1,987 / 286 个） |
| 单测 `tierSwitch.test.mjs` T6-probe-4b、4c | 2 条挂（`git show HEAD:playability.ts` 换回修前跑） | 21/21 过 |
| 单测 `mediaDrive.test.mjs`（新，4 条） | 2 条挂（「暂停中重载后回到目标时刻」「播放中重载后对齐并起播」；另两条是不该动的情形，修前本来就对） | 4/4 过 |
| 单测 `mediaSync.test.mjs`「闲着的槽位到齐时不重载」 | （新参数，修前没有） | 过 |

T5c 修后的元素事件：闲着的原尺寸槽位在原尺寸报齐时**不再**被重载；16.1 s 字节放行、探测出结论后它才成了预热槽位、才 `load()`，随即 loadedmetadata → seeking → seeked(2.5) → loadeddata，换档。截图 `t5c-original.png` 看过：原尺寸画面，顶上帧号条纹读 75。

### 6.2 `tier-switch-probe` 全量（修后，`3a335a9`）

`ok: true`、`fails: []`。T5a 1,891 ms、黑帧 0、帧号 [75]；T5b 播放中换档帧误差 −0.22 帧、换档后 300 ms 无黑帧、解得出的帧无黑帧；T5c 16,463 ms、黑帧 0、[75]；T5e 2,168 ms、黑帧 0、[75]；T6 ProRes 缓存记 0、一直停在小版；T7 导出拒绝「等待上传方」、导出请求 0。

### 6.3 G0 与 G0-R（`743ca6a`，与 `3a335a9` 代码相同，只差报告）

跑法：主会话的 `run-g0-g0r.sh` 换成本段端口（dev server 5686，舞台 5687/5688；ready-index 5683）。

| 项 | 结果 |
|---|---|
| `npx tsc -b --force` | exit 0（17 s） |
| `npm test` | exit 0（117 s）：tests 3400、pass 3398、fail 0、skipped 2（`/api/cards/layout` 集成、SKILL 闸门集成，照旧） |
| `npm run build` | exit 0 |
| `npx vite build --mode online` | exit 0 |
| 导出确定性 `verify-determinism` | exit 0：1800 帧、相同 1800、不同 0 |
| 与 main 基准帧逐像素比较 | exit 0：1800/1800 相同，缺 0、多 0 |
| `verify-unified-frames` | exit 0，PASS |
| `ready-index-probe` | exit 0 |
| `stream-produce-probe --group` | exit 0，PASS |
| `stream-produce-probe`（不带 `--group`） | exit 1，只挂「1080p 全幅流 15 帧分段编码 ≤ 300 ms」（main 上本来就挂的已知性能缺陷），这一轮 p50 907 ms |
| `preview-fallback-probe` / `--page-preload` | 都 exit 0，PASS |

`stream-produce-probe` 不带 `--group` 与 main 同一时段对照（同一个 worktree、同一台 dev server 端口，只把四个改动文件在 `d70fce7` 与本分支之间来回换，交替跑两轮，00:55～01:00）：

| 轮 | main `d70fce7` 编码 ms / p50 | 本分支 编码 ms / p50 |
|---|---|---|
| 1 | [483, 552, 595] / 552 | [471, 482, 541] / 482 |
| 2 | [869, 1060, 1098] / 1060 | [469, 479, 509] / 479 |

四次都只挂这一条；本分支不比 main 差（改动不在编码路径上，差别是机器负载的起伏）。

### 6.4 `tiers-probe`

`node scripts/probes/tiers-probe.mjs --port-a 5680 --port-r 5683`：导入、重封装、小尺寸、上传队列顺序、远程六个哈希都过，唯一挂的是 **T4「后台上传期间页面主线程没有 > 50 ms 的长任务」**（长任务 72、59 ms）。和 main 同一时段交替对照（四个改动文件在 `d70fce7` 与本分支之间换，01:24～01:32）：

| 轮 | main | 本分支 |
|---|---|---|
| 1 | 只挂 T4（长任务 69、77、54、56 ms） | 只挂 T4（80、68、54、69 ms） |
| 2 | 页面没起来（「页面与舞台起来、测量遮罩」超时），T4 没法测 | 只挂 T4（11 个 51～88 ms） |

main 上同样挂，T4 量的是编辑器主文档在导入与上传期间的长任务，本分支的改动（舞台里的画面层、可播性探测、媒体驱动）不在那条路上；是机器满载（CPU 约 60%，同时三个 C10 子 Agent 在跑）下的性能门槛，不是本改动引入的。按「性能基准机」规则它在笔记本上挂就是真挂，但不属本任务，记为待定（第 7 节）。

### 6.5 T9 本机替身

跑法（脚本 `scratchpad/trs-t9/run.sh`，令牌只在环境变量里）：临时托管组合只绑 127.0.0.1（文档服务 5689、素材服务 15689，`PROMPTCUT_TRUST_LOOPBACK=0` 带集群令牌），临时协调口 15690（带信箱令牌），`node scripts/probes/c66-t9-probe.mjs --role all --port 5680 --hosted http://127.0.0.1:5689 --coord http://127.0.0.1:15690 --observer-throttle <字节/秒>`（三个编辑器 5680 / 5683 / 5686，各带两个舞台端口）。

| 轮 | 限速 | 观察端换档（本任务的对象） | 整体 |
|---|---|---|---|
| 1 | 160,000 B/s（≈ 跨机那次的 140～170 KB/s） | 先小后大：首帧小尺寸（帧号 75、800 宽），当时原尺寸 1/6 片、未 complete、创建方未续传；**换档等了 58.3 s 换上原尺寸**（帧号 75、1920 宽）；`covered`，采样 6,867 个、换档前小尺寸 6,474 个、**黑帧 0**；readyState 低的 389 个样本都此前出过帧、截图亮度 130；媒体日志：可播性探测卸元素（`playability.ts:183 close`）后紧接着预热槽位 `load()`（`VideoTrack.tsx:292`，在用槽位的重载），对齐 2.5 / 2.5 | `ok: false`，只挂观察端「改卡后 5 s 内重测」：`remeasure-over-5s(7112)`；主机全过 |
| 2 | 1,048,576 B/s | 换档 13.0 s，帧号 75→75、1920 宽，黑帧 0（采样 1,547）；**观察端 `ok: true`**（重测 3,948 ms） | `ok: false`：创建方「写入重卡片段的钉死记录」`EPERM: rename card-costs.json.*.tmp → card-costs.json`（Windows 上临时文件改名被占用），随后「预渲染进程收到钉死记录」超时；观察端、主机全过 |
| 3 | 160,000 B/s | 换档 85.4 s，帧号 75→75、1920 宽，黑帧 0（采样 9,878）；媒体日志两次探测收尾、随后预热槽位重载、对齐 2.5 / 2.5 | `ok: false`，只挂 `remeasure-over-5s(5231)`；主机全过；plan 落定用了 461 s（C6.6 时 136 s），机器满载 |

结论：三轮里本任务管的那一段（限速下原尺寸到齐后换上原尺寸、帧误差 0、无黑帧）**全过**；限速 160 KB/s 的两轮换上了（修前同样场景在跨机时 5 分钟没换上）。整轮没有一次全过，挂的是与换档无关的两步：卡片改动后的重测超过 5 s（5.2、7.1 s，满载下的耗时门槛）、创建方写成本记录时的 Windows 改名冲突。第 4 轮见下。

## 7. 偏离与待定

（进行中）
