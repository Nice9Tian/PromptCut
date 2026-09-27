# AGENT-c10a-tests：C10a 契约测试（测试方）

分支 `claude/c10a-tests`（起点 C6.6 集成分支 `claude/c66-integ` 的 `851ffe9`），测试方：只照 `docs/plan/c10a-contract.md`（下称「契约」）与它引的 `docs/plan/auth-contract.md` 写，没看 `claude/c10a-web`、`claude/c10a-lowmem` 的实现。用例名前缀 `C10A-`，后面两个字母是组别：IV 邀请码、LM 低内存档判定、GT 能力闸、PS 预渲染小尺寸、MP4 封装器、API 在线构建与 `/api` 守卫。

## 1. 做了什么

| 文件 | 内容 |
|---|---|
| `server/test/c10a-kit.mjs` | 公共件。契约没写死的模块路径、函数名、回包形状全在这里（假设 K1～K7，见第 3 节），集成时对账只改这一个文件；另有各组的「接口在不在」探测、低内存档的浏览器桩、H.264 Annex B → AVCC / AAC ADTS → 原始帧的拆包、构建产物的 `/api/` 字面量扫描 |
| `server/test/c10a-invite.test.mjs` | 邀请码 C10A-IV-01～19（20 条，IV-12 分 resolve / redeem 两条）：真 HTTP + 真 WebSocket，服务端是 `auth-kit.mjs` 组装的共享项目文档服务 |
| `src/online/c10a-lowmem.test.mjs` | 低内存档判定 C10A-LM-01～08（`ONLINE: true`） |
| `src/online/c10a-lowmem-desktop.test.mjs` | C10A-LM-09：桌面运行环境恒为普通档（`ONLINE: false`，另一个进程） |
| `src/render/c10a-gates.test.mjs` | 能力闸 C10A-GT-01～04：`playbackUrl` / `chooseTier` 在低内存档恒给小尺寸、不探原尺寸 |
| `src/editor/c10a-swap-gate.test.mjs` | 能力闸 C10A-GT-05～06：低内存档下 `runSettleSwap` / `runPlayingSwap` 不排后台任务、不碰后台舞台、不互换 |
| `src/editor/c10a-single-stage.test.mjs` | C10A-GT-07：在线页面只开同源舞台 A、按 live 变体渲 |
| `server/test/c10a-small-prerender.test.mjs` | 预渲染小尺寸 C10A-PS-01～07 |
| `src/export/c10a-mp4.test.mjs` | MP4 封装器 C10A-MP4-01～04 |
| `server/test/c10a-online-build.test.mjs` | 在线构建 C10A-API-01～04（`mode.ts` 逐字节、`vite build --mode online`、产物静态检查、桌面构建不变） |
| `src/online/c10a-api-guard.test.mjs`、`c10a-api-guard-desktop.test.mjs` | `/api` 守卫 C10A-API-05～06 |
| `scripts/probes/c10a-online-probe.mjs` | 在线构建的真浏览器探针（Chrome 移动端仿真），S1～S5，见第 5 节 |

### 1.1 实现不在时怎么办（给集成方）

每组开头探测「实现有没有」，不在就用 `node:test` 的 `skip` 跳过，原因写「接口缺失：…（C10a 实现未集成，集成后自动转为真跑）」。探测只看实现在不在，不看对不对：接口一出现就真跑，名字或形状和假设对不上会直接**失败**，不会静默跳过；导出了名字却载不进 node 的（例如封装器、尺寸函数），另有一条 `-00` 用例报错。

| 组 | 探测条件（不满足就 skip） |
|---|---|
| IV | 对随机码 `POST shared/invite/resolve` 回 404 `invite-invalid`（现在的实现回 404 `not-found`） |
| LM、GT | `src/online/lowMemory.ts` 存在（契约第 11 节点名的文件，c10a-lowmem 建） |
| PS | 找得到尺寸规则函数（K4 列的文件与名字） |
| MP4 | `src/export/` 下找得到封装器（K5），且本机有 ffmpeg |
| API-01～04 | `src/online/mode.ts` 存在 |
| API-05～06 | `src/online/` 下有导出名含 guard 的函数（K6） |

**跳过数**：本分支 `npm test` 跳过 54 条 = C10A 的 53 条 + 需要 5190 的那 1 条。**集成后必须回到只跳过 5190 那 1 条**；多出来的就是某组实现没接上或探测没对上，集成方按第 3 节对账。

## 2. 用例与依赖的接口

| 编号 | 内容 | 依据（契约） | 依赖的接口 |
|---|---|---|---|
| IV-01 | 签发：43 位 base64url，缺省 7 天、次数不限；resolve 回 `{ ok, projectId, name, mode }`、no-store、不扣次数；原文只在签发回包里，status 不含 | 第 5 节「生成」「缺省」「HTTP 端点」 | K1 |
| IV-02 | 签发可改有效期与次数；再签发同时作废旧的 | 「只有一个有效邀请码」 | K1 |
| IV-03 | 作废后 resolve / redeem 都 `invite-invalid`，status 带 `revokedAt`；已经兑换的人凭 K 照常握手 | `invite-revoke`、「作废不影响已经进来的人」 | K1 |
| IV-04 | 限时：60 s 的码 30 s 时能用，61 s 后失效（注入时钟） | 「限时」 | K1 |
| IV-05 | 限量：maxUses 2，第三台失效；用满后 resolve 也失效 | 「扣次数」「一个口径」 | K1 |
| IV-06 | 同一 userId 兑换三次只扣一次；换用户名或换设备算新 userId | 「同一 userId 再兑换不重复扣」 | K1 |
| IV-07 | 未知、已作废、已过期、次数用完四种情况，resolve 与 redeem 各自的状态码与回包逐字节相同 | 「`invite-invalid` 一个口径」 | K1 |
| IV-08 | 自由进入回 `kdf` 与 `project: { salt, key }`，K = KDF(项目密码, 盐)，凭 K 握手 101；resolve 不给 K | 「自由进入回 K」 | K1 |
| IV-09 | 限定进入只回 `{ ok, projectId, name, mode }`，兑换时就扣次；之后按名单口令进入 | 「限定进入不回 K」 | K1 |
| IV-10 | 改项目密码不动邀请码：旧码照常可用、兑换回新 K，旧 K 401 | 「改项目密码、改名单：不动邀请码」 | K1 |
| IV-11 | 被踢的 (用户名, 设备) 兑换 401 `banned`；换设备不受影响；unban 后能兑换 | 「禁入表」 | K1 |
| IV-12 ×2 | 限速：同一来源失败 5 次后 resolve、redeem 都 429（码对也拒），另一来源不受影响，61 s 后恢复 | 「限速」、auth 契约第 9 节 | K1 |
| IV-13 | 回环来源的失败不计入限速 | auth 契约第 9 节 | K1 |
| IV-14 | 三个 op 在成员、不带证明、证明错时一律 `forbidden`，且都不生效 | 「创建者操作」 | K1 |
| IV-15 | 原文不落盘（数据目录逐文件查）、不进日志 | 「存储」「不进日志」 | K1 |
| IV-16 | 删项目后邀请码失效 | 「删项目」 | K1 |
| IV-17 | OPTIONS 预检、`Access-Control-Allow-Origin: *`、no-store | 「HTTP 端点」、auth 契约第 4 节 | K1 |
| IV-18 | 挂载模式（局域网主机）同一组端点：`/docservice/shared/invite/*` | 「放本机的项目」 | K1 |
| IV-19 | 两个项目的码互不相干 | — | K1 |
| LM-01 | deviceMemory ≤ 4 → 低内存档，> 4 → 普通档 | 第 8 节「判定」 | K2 |
| LM-02 | 没有 deviceMemory（iOS、Firefox）：粗指针 + 至少 2 个触点 + 长边 ≤ 1600 → 低内存档 | 同上 | K2 |
| LM-03 | 长边边界 1600 / 1601，横竖屏 | 同上 | K2 |
| LM-04 | 触点数 0、1 不算，2 算 | 同上 | K2 |
| LM-05 | `(pointer: coarse)` 或 `(any-pointer: coarse)` 任一匹配 | 同上 | K2 |
| LM-06 | 不看 UA；桌面 Safari 不再因为是 Safari 判低内存档 | 同上、「判据换成上面这条」 | K2 |
| LM-07 | 设备设置覆盖：低内存 / 普通两个方向 | 「override」 | K2 |
| LM-08 | 舞台 `detectHostCapabilities().lowMemory` 用同一条判据 | 「结果写进 `hostCapabilities.lowMemory`」 | K2、`src/render/stageRpc.ts` |
| LM-09 | 桌面运行环境恒为普通档，舞台的 `lowMemory` 恒为 false | 「只在在线模式里判」 | K2 |
| GT-01 | 低内存档：两档到齐、原尺寸能放也给小尺寸；可播性不知道时不探原尺寸 | 第 8 节「素材只拉小尺寸」 | K3 |
| GT-02 | 只有原尺寸到齐也不给原尺寸 | 同上 | K3 |
| GT-03 | 没有小尺寸的视频不拉原尺寸，`awaiting` 为 true | 同上「等待上传方」 | K3 |
| GT-04 | 小尺寸地址拼在在线素材服务的公网地址上 | 第 2 节「素材服务 = 公网地址」 | K3 |
| GT-05 | 暂停态：低内存档下 `runSettleSwap` 不排后台任务、不对后台舞台灌项目或 `render`、不互换 | 第 8 节「不追活渲」 | K3（`lowMemory.ts` 换桩） |
| GT-06 | 播放态：`runPlayingSwap` 同上 | 同上 | K3 |
| GT-07 | 在线页面 `dualStage()` 恒为 false，`stageSrc('A')` 同源、带 `preview=stage` | 第 8 节「不开后台舞台」、第 8.1 节 | K7 |
| PS-01 | 尺寸：1920×1080 → 800×450、1080×1920 → 337×600 等九例 | 第 9 节「尺寸」 | K4 |
| PS-02 | 不放大 | 同上 | K4 |
| PS-03 | 500 组随机尺寸的性质：整数、在框内、不放大、画幅误差不到 1 像素、缩了就有一边顶到框 | 同上 | K4 |
| PS-04 | 清单带 `small`：`pushResult` 原尺寸进 `snap`、小位图以 `webp` 进 `px` | 「入库与清单」 | K4 |
| PS-05 | 小尺寸有一块推失败，`pushResult` 抛错（这一段不算完成） | 「任务完成的条件：两档都推送成功」 | K4 |
| PS-06 | `blocksPresent`（去重）看两档：缺一张小位图就 false | 同上 | K4 |
| PS-07 | 就绪索引里小尺寸是单独一层，记了小尺寸不让原尺寸层就绪 | 「两档的就绪分开记」 | K4 |
| MP4-01 | 只有视频：`ftyp` 开头、box 铺满文件；ffprobe 读得出 H.264、尺寸、30 帧、1 秒、30 fps；解码无错；解出的画面与源码流逐帧 md5 相同 | 第 11 节〔裁〕、第 12 节「MP4 封装」 | K5 |
| MP4-02 | 视频 + AAC：两条轨，AAC LC 48 kHz 双声道，帧数一个不少，时长约 2 秒 | 第 11.1 节「音频」 | K5 |
| MP4-03 | 25 fps、GOP 10：关键帧落在第 0、10、20、30、40 帧，逐帧时间戳对 | — | K5 |
| MP4-04 | 60 fps 半秒：30 帧、0.5 秒 | — | K5 |
| API-01 | `src/online/mode.ts` 与契约第 2 节逐字节相同（换行符不计） | 第 2 节「判定模块」 | 文件本身 |
| API-02 | `vite build --mode online` 成功，index.html 只引 `/editor/…`，入口在 `/editor/assets/` | 第 2 节「在线构建」 | vite 配置 |
| API-03 | 在线构建产物里以 `/api/` 开头的地址字面量为 0 | 第 2 节、第 12 节 | K6（扫描口径） |
| API-04 | 桌面构建照旧（base `/`） | 第 2 节「桌面构建照旧」 | vite 配置 |
| API-05 | 在线模式：`fetch('/api/…')` 抛错且不落到真正的 fetch；别的地址放行 | 第 2 节「守卫」 | K6 |
| API-06 | 桌面：装了守卫也不拦 | 同上 | K6 |

样本都现场生成：MP4 组用 ffmpeg 出 H.264 Annex B（无 B 帧、一帧一个 slice、固定 GOP）与 AAC ADTS，测试自己拆成 WebCodecs 交给封装器的形状（AVCC 长度前缀的访问单元 + avcC；去掉 ADTS 头的 AAC 帧 + AudioSpecificConfig），检查一律用测试自己的办法（ffprobe、`-f framemd5`、自写的顶层 box 解析）。

## 3. 假设的接口（集成时对账，只改 `server/test/c10a-kit.mjs`）

| 编号 | 假设 |
|---|---|
| K1 | 邀请码挂在现有共享项目 HTTP 端点旁：独立模式 `shared/invite/resolve|redeem`，挂载模式 `<WS 路径>/shared/invite/…`，服务端就是 `createSharedDocService`。`invite-create` / `invite-revoke` / `invite-status` 的回包字段平铺在 `shared.admin.ok` 上（同 C6.5 `list-bans` 回 `bans`），`invite-status` 也接受包在 `status` 里。`expiresAt`、`revokedAt` 是毫秒时间戳。签发与过期按文档服务注入的时钟算 |
| K2 | `src/online/lowMemory.ts` 导出判定函数，名字取 `decideLowMemory` / `detectLowMemory` / `computeLowMemory` / `judgeLowMemory` / `lowMemoryFor` / `isLowMemoryDevice` / `resolveLowMemory` 之一；调用 `fn(env)`，同时把同样的桩装到 `globalThis.navigator` / `screen` / `matchMedia` 上（从参数读、从全局读两种写法都认）；回布尔或 `{ lowMemory }`；设备设置经 `env.override`（`'low' | 'normal' | undefined`）给 |
| K3 | `chooseTier` / `playbackUrl` 的 `opts.lowMemory === true` 表示低内存档；没有小尺寸 → `tier: 'none'`（或地址为空）、`awaiting: true`。`stageSwap.ts` 从 `src/online/lowMemory.ts` 取档位，测试把整个模块换成桩（`lowMemoryStubExports` 列的各种名字都说「是」） |
| K4 | 尺寸规则是纯函数 `(width, height) → { width, height }`（或 `[w, h]`），在 `server/artifact-transfer.mjs`、`server/frame-pipeline.mjs`、`server/artifact-push.mjs`、`server/bakery/*.mjs` 等之一，名字取 `smallPrerenderSize` / `prerenderSmallSize` / `smallSize` 等之一；快照清单另带 `small: [[帧, 哈希, 字节数], …]`，块以 `ext: 'webp'` 推到 `px`；就绪索引 `READY_KINDS` 里有名字含 `small` 的一档 |
| K5 | `src/export/` 下导出类或工厂 `Mp4Muxer` / `MP4Muxer` / `Muxer` / `createMp4Muxer` / `createMuxer` / `mp4Muxer`；构造参数 `{ video: { codec: 'avc', width, height, frameRate }, audio?: { codec: 'aac', sampleRate, numberOfChannels }, fastStart? }`；方法 `addVideoChunk(chunk, meta?)`、`addAudioChunk(chunk, meta?)`、`finalize()`；块是 WebCodecs 的 `EncodedVideoChunk` / `EncodedAudioChunk` 形状，`meta.decoderConfig.description` 是 avcC / AudioSpecificConfig；产物取 `finalize()` 的返回值（Uint8Array / ArrayBuffer / Blob），没有就取 `muxer.target.buffer` |
| K6 | `src/online/` 下导出名含 guard 的函数，调用即装上；`ONLINE` 时 `fetch('/api/…')` 同步抛或 reject；别的地址转给原来的 `fetch`。静态检查的口径：引号或反引号后紧跟 `/api/` 再紧跟地址字符才算请求，守卫判前缀用的 `"/api/"` 不算 |
| K7 | 仍由 `src/editor/previewMode.ts` 定开几个舞台：`ONLINE` 时 `dualStage()` 恒为 false，`stageSrc('A')` 同源、带 `preview=stage` |

`src/online/mode.ts` 读 `import.meta.env`，node 里没有，凡是会载到它的用例都用 `mock.module` 换成 `{ ONLINE: true | false }`。

## 4. 验证

### 4.1 基线（本分支，没有实现）

- `npx tsc -b --force`：退出码 0，零错误。
- `npm test`：退出码 0；`tests 3126, pass 3072, fail 0, skipped 54`。54 条跳过里 53 条是 C10A（每条原因写「接口缺失：…」），另 1 条是需要 5190 的「集成:/api/cards/layout 对真实项目返回整数框」。

### 4.2 测试本身对不对：一次性参考实现

为了确认用例没写错，每组都在 worktree 里临时放了一份最小的参考实现（照契约写），跑通后删掉或 `git checkout` 还原，**都没有提交**（每次跑完 `git status` 只剩测试文件）：

| 组 | 临时改动 | 结果 |
|---|---|---|
| IV | `server/auth/http.mjs` 加 resolve / redeem 两个端点，`server/docservice/modules/shared.mjs` 加三个 op（摘要 = HMAC(serverSecret, code)，记录里存 `invite`） | 20 / 20 过 |
| LM | 临时 `src/online/mode.ts`（契约原文）、`src/online/lowMemory.ts`（按判定式），`stageRpc.ts` 的 `lowMemory` 改用它 | 9 / 9 过 |
| GT-01～06 | 只放临时 `lowMemory.ts` 时 6 条全失败（现有 `mediaTier` / `stageSwap` 没有闸，说明场面搭对了：普通档下确实会补跑）；再给 `chooseTier` 加 `opts.lowMemory`、给两个 swap 入口加 `isLowMemory()` 闸 | 6 / 6 过 |
| GT-07 | 现有 `previewMode.ts` 失败（`/editor/?stage=1&id=A` 不带 `preview=stage`）；加 `ONLINE` 分支后 | 1 / 1 过 |
| PS | `artifact-transfer.mjs` 的 `resultBlocks` 收 `small`、加尺寸函数（向下取整）；`READY_KINDS` 加 `small` | 7 / 7 过（第一次跑发现 PS-02 自己的错：360×640 超框，改例子） |
| MP4 | scratchpad 里手写的约 90 行 MP4 封装器（ftyp + moov + mdat，stts / stss / stsc / stsz / stco，avcC / esds） | 4 / 4 过，含逐帧 md5 相同 |
| API-01～04 | 只放契约原文的 `mode.ts` | API-01、04 过；API-02 失败（index.html 引 `/assets/…`，vite 配置还没有在线模式），API-03 失败（产物里满是 `/api/` 地址）——符合现状 |
| API-05～06 | 临时 `src/online/apiGuard.ts` | 2 / 2 过 |

用时：C10A 全部文件在 `npm test` 里并行，本分支（全跳过）不增加可感知的时间；参考实现下邀请码一组约 5 s，MP4 一组约 1 s，在线构建一组约 3 s（vite 构建两次）。

### 4.3 探针

`scripts/probes/c10a-online-probe.mjs` 在本分支上：

- 不带 `--force`：退出码 2，`{"summary":{"ok":false,"missing":"接口缺失：src/online/mode.ts 不在…"}}`。
- 查探针自己的管路：用现在的桌面构建加 `base: '/editor/'` 当产物（`--force --dist <它>`），15 项里 8 项过、7 项失败，失败的都是预期（桌面应用在开始页发了 `/api/cards/scopes`、`/api/voice/config` 等 8 个请求；不读 `#invite=`；没有表 A 的失效提示）。截图 `s1-start.png` 看过：390×844 移动视口下开始页正常渲出（「开始创作」、拓展功能列表），说明静态服务、移动端仿真、网络与控制台记录、截图都通。一轮约 28 s。

## 5. 没做成的与原因

1. **「不认领」「不起后台舞台」的运行期证据**：页面现在根本不连渲染队列（`node.hello` 只在渲染节点与预渲染进程里发），「不认领」在单测层面没有可调的接口；「只有一个舞台 iframe」要进到编辑器里才看得到，而进编辑器要真的托管端、建好的项目与素材。单测只覆盖了 `stageSwap` 的两条补跑路（GT-05、06）和 `previewMode` 的单舞台（GT-07）。交给主会话的「本机替身跑 demo」（契约第 12 节）时建议一并看：CDP 的 WebSocket 帧里没有 `node.hello` / 认领类消息；页面里只有一个舞台 iframe；网络记录里只有素材小尺寸与预渲染小尺寸（`px/<hash>` 的 WebP）。
2. **在线页面进入项目之后**（低内存档提示、只拉小尺寸、改一处后小尺寸回到页面、作废后旧链接被拒）：同上，属于契约第 12 节的本机替身 demo，由主会话做；探针只做到开始页与邀请码读取。
3. **运行中改按低内存档**（`webglcontextlost`、连续 3 次解码失败）：契约没给可调的接口，没写。
4. **预渲染小尺寸的生成**（渲染节点的受控舞台截 WebP、PNG 快照缩成 WebP）与**在线页面按清单拉取、前后 2 秒预取**：契约没给接口，只测了尺寸规则、清单与推送、就绪分开记。
5. **逐帧导出的能力探测、导出前核对、`encodeQueueSize ≤ 3`、写出**：浏览器 API，单测只覆盖封装器本身。
6. 开始页三条路径与「我是创建者」、项目设置「多用户协作」、二维码：契约第 12 节「契约测试」没列，c10a-web 自己的验证里有探针；本分支没写。

## 6. 对契约的更正建议

1. **图片、音频没有小尺寸**（第 8 节「素材只拉小尺寸」）：C6.6 只给视频做素材小尺寸（`c66-design.md` 第 2 节），照字面「没有小尺寸的素材……不拉原尺寸（导出除外）」，低内存档里图片层永远是占位、声音层永远没声。建议补一句：图片与音频不受「只拉小尺寸」限制（或给图片另定小尺寸）。GT 组只用了视频素材，没替这一点做决定。
2. **限速的秒数**：表 A「尝试次数太多，请 {秒数} 秒后再试（秒数取服务端返回的值）」，但第 5 节端点表只写 429 `rate-limited`，没定秒数放在哪（回包字段还是 `Retry-After` 头）。建议在第 5 节定下来；测试没断言它。
3. **`expiresAt` 的单位、`invite-status` 的回包形状**：没写。测试按毫秒时间戳、字段平铺（K1）；建议契约写明。
4. **限定进入的兑换扣次数**：第 5 节说「限定进入在兑换时就扣」，但兑换时不核对口令，也没说要不要核对用户名在名单里。于是任何拿到链接的人换着设备名兑换，就能把 `maxUses` 耗光。建议：限定进入的兑换只在用户名在名单里时扣（不在名单也回同样的 200，不泄露名单），或者改成第一次凭证明握手成功时才扣。测试（IV-09）只用了名单里的用户名，两种改法都过。
5. **格式不对的邀请码**（长度不是 43、字符集不对）送到端点：回 400 还是 `invite-invalid` 没写。测试没覆盖，建议并入「一个口径」。
6. **`/api` 守卫只在开发期？**第 2 节说「开发期加一个守卫」，而在线构建是生产模式。如果守卫只在 `import.meta.env.DEV` 下装，在线构建里的漏网调用只能靠静态检查（API-03）与探针（S1、S5）发现。API-05 直接调用守卫函数，若实现按 `DEV` 判断，node 里会不生效而失败，集成时需要约定（例如守卫函数接受一个强制开关）。
7. **`src/online/` 在分层里的位置**：契约要 `stageRpc.ts`（render 层）的 `hostCapabilities.lowMemory` 用 `src/online/lowMemory.ts` 的判定。约束「kernel ← render ← editor」没提 `src/online/`；如果守门测试把它算作上层，render 就不能引它。建议契约点明 `src/online/` 的层级（判定是纯函数，放在 render 可引的层）。
8. **预渲染小尺寸的清单字段、就绪的 `kind` 名、PNG 快照的小尺寸放在哪**（`pngs[]` 里还是另起）：契约只说「带小尺寸那一份的哈希表」「两档的就绪分开记」，测试按 K4 假设。另外「任务完成的条件：两档都推送成功」与「已有产物补小尺寸：C10a 只给新产出的区间生成」合起来，意味着老清单（没有 `small`）照旧算完成、去重照旧命中；PS-06 只要求「清单列了小尺寸就要两档都在」，与这一点不冲突。

## 7. 提交

见分支 `claude/c10a-tests` 的提交记录（每完成一组提交一次）。
