# AGENT-lan-asset 报告

分支 `claude/lan-asset`，worktree `.worktrees/lan-asset`。任务：放本机（局域网）项目里成员页面找不到主机的素材服务、视频不出。

代号：**M8-X1** = 放本机版 T9 跨机探针（PC 当局域网主机，别的机器经局域网加入，观察端页面要画出视频），由 `claude/m8-e2e` 查出本缺陷。

## 1. 根因

语义（`product/document-service.md`「部署组合」、`product/asset-service.md`「是什么」）：放本机时文档服务和素材服务都在创建者本机，成员拿到它的地址后直接收发字节。代码三处的现状：

- **主机登记**：`server/vite-plugin-media.ts` 只在设了 `PROMPTCUT_DOCSERVICE_URL` 时向 `service.endpoints` 登记素材服务；局域网主机编辑器不设，于是不登记。
- **发现包**：`server/lan/discovery.mjs` 的通告里有 `asset: http://<主机>/api/asset`，`server/auth/route.mjs` 也把它带进候选；但页面的 `Candidate` 类型（`src/editor/sync/sharedApi.ts`）没有这个字段，`syncManager` 也不用它。
- **页面选端点**：`src/editor/media/assetTiers.ts` 的 `connectSharedAssets` 只看登记（`pickAssetEndpoint`），挑不到就留在本地素材服务。独立渲染主机有兜底（`server/vite-plugin-frames.ts` 的 `hostAssetClient` 按文档服务地址推 `/api/asset`），页面没有。

结果：成员页面一直问自己的本地素材服务，视频素材解不出画面。这是代码没跟上语义，没改语义。

## 2. 改法（提交 `d847571`）

- `assetTiers.ts` 新增 `lanAssetBaseOf(candidate)`：只对 `where === "lan"` 给后备地址，先用发现通告的 `asset`，没有（手填地址、邀请链接）就按文档服务地址推 `<协议>//<主机>/api/asset`，推法与 `hostAssetClient` 相同。放云端给 null。
- `connectSharedAssets` 加选项 `fallback`，存进上下文；`receiveSharedAssetEndpoints` 和重试也带上它。优先级是「登记 > 发现通告 > 推出的地址」。后备指向本页面自己（`location.host`，本机就是主机）时不算远程，留在本地，和 `pickAssetEndpoint` 的排除规则一致。
- `syncManager.ts` 两处调用传 `fallback: lanAssetBaseOf(candidate)`；`sharedApi.ts` 的 `Candidate` 补 `asset?`。
- 放云端不受影响：`where` 为 `hosted` 时没有后备，行为与原来逐行相同。
- 主机端没改，局域网主机仍不登记素材服务。理由：语义只要求成员得到地址，没要求非走登记不可。发现通告已经带着这个地址，推法也和渲染主机一致。登记这条路要让主机编辑器拿集群令牌连自己的文档服务，改动面更大。是否也登记由主会话定，见第 4 节。

单测在 `src/editor/media/assetTiers.test.mjs`，新增两条：
- M8-X1-a：后备地址的推法（发现通告优先、按文档服务地址推、`https`、放云端给 null、地址不合法给 null）；
- M8-X1-b：登记为空时用后备；后续全量通知仍为空时不退回本地；有登记时登记优先；后备指向本页面自己时留在本地。

修之前这两条都失败（`lanAssetBaseOf` 不存在、`fallback` 被忽略），修之后本文件 14/14 通过。

## 3. 验证

- `npx tsc -b --force`：退出码 0。
- `npm test`：退出码 0；tests 3643，pass 3641，fail 0，skipped 2。
- `npx vite build --mode online`：退出码 0。`npm run build`：退出码 0。
- 渲染路径没动，只改了页面选素材服务的逻辑，所以没跑 G0-R（导出像素基线）和 verify-determinism。
- M8-X1 本机替身：先用本机临时令牌起协调口 `node scripts/probes/probe-coord.mjs serve --host 127.0.0.1 --port 5879`，再跑 `node scripts/probes/c66-t9-probe.mjs --role all --place lan --coord http://127.0.0.1:5879 --port 5870 --out <scratchpad>`。退出码 0，`"ok":true`，`"fails":[]`。结果行摘录：
  ```
  creator: assetUrl "http://192.168.50.96:5870/api/asset" … "fails":[],"ok":true
  observer: discovery {"found":true,"via":"discover","base":"http://192.168.50.96:5870/docservice/"} joinMs 879
            firstShown {"tier":"small","idx":75,"w":800}  original {"idx":75,"w":1920}
            tierSequence none@1873ms → small@5054ms → original@5090ms；swapSamples black 0
            installMs 204、remeasureMs 1434；"fails":[],"ok":true
  host:     assetBase "http://192.168.50.96:5870/api/asset" claimed 4 completed 4；plan tasks 8 done 8；artifacts manifests 8 missingBlocks []；"ok":true
  all:      "ms":218698,"fails":[],"ok":true
  ```
  看过观察端截图 `observer-2-original.png`：预览区画出了探针视频（噪点底加帧号条），播放头停在 2.50 s，时间轴上有视频片段和 T9 用户卡。修之前这一步 `firstShown: null`。
- 跑完核对：我起的协调口进程已结束；命令行含 `lan-asset` 的 node、chrome 进程 0 个；5870～5879 上的监听 0 个。worktree 里没有残留文件。

## 4. 没做的与建议

- 跨机（笔记本经真实局域网加入）没跑，本次只在本机替身上验证。按 `claude/m8-e2e` 报告第 3.4 节的命令跨机复跑即可。
- 要不要让局域网主机也向 `service.endpoints` 登记自己的素材服务，由主会话定。登记之后页面会优先用登记的地址，本分支的后备仍然保留，用于手填地址和离线等情况。
- `c66-t9-probe.mjs` 文件头「放本机」一节写着「页面挑不到别处的素材服务，留在本地」，修好后已经不成立。成员页面现在会从主机素材服务取素材。探针判据没变，本次照样全过。这个文件不在本分支清单里，没改，建议合并后顺手更正那段注释。
