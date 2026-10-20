# AGENT 报告：在线页面层表里剪辑段流的输入签名

分支 `claude/cutseg-layer-sig`，工作区 `.worktrees/cutseg-layer-sig`，基于 main `3267ce84`。
背景：`docs/archive/agent-reports/AGENT-cut-segment-prerender.md`「没做成的」第 2 条——在线页面从层表（托管方写给在线页面的「每条流在哪」的那张表，`server/artifact-transfer.mjs` 的 `layerMapOf`）拿流，剪辑段的那一行没带 `streamKind: 'cut'` 与输入签名，被引用剪辑刚改过、渲染节点还没换键的那一小段，父页可能贴上旧的剪辑段流。

## 状态

（见文末「验证」；写完后更新。）

## 做法（一句话版）

层表 `streams` 表里剪辑段级的流那一行另带 `streamKind: 'cut'`（签名 `inputSig` 本来就写着）；在线来源解析时保留它，就绪消息照桌面预渲染进程发的层的形状带上 `streamKind: 'cut'` 与 `inputSig`；父页 `cutStreamHeavy` 一行不改——它本来就按 store 里当前的项目比签名，对不上就不贴、照旧活渲。于是在线页面与桌面版同一个判据。

## 做了什么

1. **服务端写层表**（`server/artifact-transfer.mjs` 的 `layerStreamsOf`）：`planStreams` 给的流标着 `solo: 'cut'`、而且是单卡流的形状（`kind: 'card'`、`plane: 'local'`、只有一个成员）时，那一行加 `streamKind: 'cut'`。别的行不加这一项，所以没有剪辑段的项目层表一个字节不变。签名照旧由 `streamInputSig(project, { clipIds, kind })` 算，与桌面预渲染进程发层时带的（`frame-stream.mjs` 的 `belowLayerMark`）是同一个值；剪辑段的片段签名含被引用剪辑任意深度的内容，被引用剪辑一改就变。写层表的两处（本机推送队列、独立渲染主机）都经 `FramePipeline.layerMapStreamOptions` → `layerMapOf`，托管方渲染服务的工作进程也走这里，不用另改。
2. **在线来源**（`src/render/snapshotSource.ts`）：`OnlineStream` 加可选的 `streamKind: "cut"`；`parseLayerStreams` 只对「单卡、包裹层坐标」的行保留它；`streamMessage` 对这种行带上 `streamKind: "cut"` 与 `inputSig`。旧节点写的行（没有 `streamKind`）照旧：消息里不带这两项，父页照贴，与改动前相同。
3. **父页诊断**（`src/editor/snapshotFeed.ts` 的 `snapshotFeedDebug`，只加诊断、不改判据）：`ready` 里每层带上 `streamKind`（有才带）；另列 `staleCut`——就绪索引里有、签名对不上当前项目的剪辑段流。探针用它核对。
4. **测试**
   - `server/test/cutseg-layer-sig.test.mjs`（服务端，LS-1～LS-4）：真的卡片计划 + `planStreams` + `layerMapOf`。LS-1 剪辑段那一行带 `streamKind: 'cut'`，签名与桌面发层时的相同；LS-2 两层深的被引用剪辑改了，旧行签名对不上新项目，渲染节点换键重写后新行对得上；LS-3 **没有剪辑段的项目层表一个字节不变**：固定输入（`server/test/cutseg-layer-sig-fixture.mjs`：单卡流、组流、依赖下层的流、`solo: 'source'` 的流、两层快照层）的 `JSON.stringify(layerMapOf(...))` 的 SHA-256 写死为 `5840986d…a9c21c`（3733 字节），这个值是用主工作区 main `3267ce84` 未改动的 `artifact-transfer.mjs` 对同一份输入算出来的，改动后算出来相同；LS-4 形状不对的（舞台坐标、多成员）即使标了 `solo: 'cut'` 也不带。
   - `src/editor/snapshotFeedCutOnline.test.mjs`（页面，CO-1～CO-3）：真的在线来源（假内容库 + 假素材服务）接真的父页判重；层表那一行用服务端真的 `layerStreamsOf` 写。CO-1 就绪消息带 `streamKind: 'cut'` 与签名，签名对得上、流铺满 → 判重、抑制、发流平面；CO-2 改「里」那张卡（两层深）：store 里是新项目而在线来源还没收到时，父页当场不贴旧流（`cutStreamHeavy` 假、不抑制、不发流平面、诊断 `staleCut: ["S"]`），在线来源收到新项目后撤层，层表换成新行（新键、新签名）后贴新流；CO-3 旧节点写的行（没有 `streamKind` 与签名）照旧贴。
   - 反证：把 `src/render/snapshotSource.ts` 换回 main 的版本跑 CO 测试，CO-1、CO-2 失败（CO-2 恰在「旧流签名对不上:不贴」那一句），CO-3 通过——测试确实钉住了本次补的口子。
5. **端到端探针** `scripts/probes/cut-online-e2e-probe.mjs`（骨架照 `below-online-e2e-probe.mjs`：本机隔离的托管组合 + 在线构建 + 真的桌面预渲染进程当切分方）。结果见「验证」。

## 文件清单（相对 `3267ce84`）

修改：`server/artifact-transfer.mjs`、`src/render/snapshotSource.ts`、`src/editor/snapshotFeed.ts`（只加诊断）。
新增：`server/test/cutseg-layer-sig.test.mjs`、`server/test/cutseg-layer-sig-fixture.mjs`、`src/editor/snapshotFeedCutOnline.test.mjs`、`scripts/probes/cut-online-e2e-probe.mjs`、本报告、`docs/reports/assets/cutseg-layer-sig/**`。

## 验证

（待补）

## 部署要换什么

（待补）
