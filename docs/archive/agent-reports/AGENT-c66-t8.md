# C6.6 T8 卡片同步偶发重测超时

## 根因与修复

后台舞台对 `direct` 卡逐帧调用 `setTime(..., { probe: true })`。每次同步提交 React、钉动画并等待 GL 严格帧之后，旧代码还等待一次浏览器的真实 `requestAnimationFrame` 才生成快照。后台 iframe 在无头 Chrome 中有时被节流到每秒一帧。失败样本 `muj4pcu5` 的 16 次真实 rAF 等待分别是 976.1～1000.4 ms，合计 15,880.1 ms；GL 诊断为 `beats=0`、`planes=0`，因此不是 GL 的 15 秒严格帧超时，也不是 RPC 或快照处理卡住。

`StageView.tsx` 的探针分支现在用 `MessageChannel` 跨一个真实任务边界，让异步 DOM 更新有机会落地，再生成快照。`createSnapshot` 读取 computed style 时会同步刷新样式；canvas 卡仍先等待严格 GL 帧。活渲耗时 `stepMs` 仍在这段等待之前取，成本口径不变。可见舞台及播放节拍的 rAF 路径未改。无需超时兜底或舞台重载。

`card-sync-probe.mjs` 启动的两个编辑器现在各用临时 `PROMPTCUT_DATA_DIR`，随探针临时目录清理。`PROBE_DEBUG=1` 时附带两个舞台的只读诊断，便于再查同步问题。

## 验证

十次连续运行 `node scripts/probes/card-sync-probe.mjs --doc-port 5586 --asset-port 5587 --a-port 5580 --b-port 5583 --out out/card-sync-t8`。原始 JSON 结果逐行保存在 `out/card-sync-t8/ten-results.jsonl`，对应退出码保存在 `out/card-sync-t8/ten-exit-codes.txt`（`out/` 为本机验证产物，不入库）。

| 次数 | runId | remeasureMs | 退出码 | fails | 可见舞台断画 ms | 舞台重载 |
|---|---|---:|---:|---:|---:|---:|
| 1 | muj4tcuc | 4616 | 0 | 0 | 0 | 0 |
| 2 | muj4u4tx | 1432 | 0 | 0 | 0 | 0 |
| 3 | muj4us0d | 1459 | 0 | 0 | 0 | 0 |
| 4 | muj4vfnf | 1489 | 0 | 0 | 0 | 0 |
| 5 | muj4wbr5 | 1526 | 0 | 0 | 0 | 0 |
| 6 | muj4wz6j | 1421 | 0 | 0 | 0 | 0 |
| 7 | muj4xmra | 1430 | 0 | 0 | 0 | 0 |
| 8 | muj4y9to | 1478 | 0 | 0 | 0 | 0 |
| 9 | muj4yx4z | 1401 | 0 | 0 | 0 | 0 |
| 10 | muj4zkj6 | 1435 | 0 | 0 | 0 | 0 |

第 1 次的页面热更新报到用了 4259 ms，后台重测到成本记录落地又用了约 357 ms，仍在 5 秒内。其余九次为 1401～1526 ms。

- `npx tsc -b --force`：退出码 0，零错误。
- `npm test`：退出码 0；3073 条、通过 3072、失败 0、跳过 1（需 5190 的既有用例）。
- `PC_FRAME_TEST_URL=http://127.0.0.1:5580 node scripts/verify-unified-frames.mjs`：退出码 0，快照重放、缓存及导出一致。
- `node scripts/verify-determinism.mjs --url 'http://127.0.0.1:5580/?export=1'`：退出码 0；1800/1800 帧逐像素相同。

以上渲染验证使用 5580～5582 的临时编辑器。验证后已停止自己启动的服务、删除临时数据目录，并确认 5580～5589 无监听。

## 次要用例

检查了 `server/test/c66-integ.test.mjs` 的 C66-I2-01（打开项目后补转素材小尺寸）与 C66-I3-02（缺素材时拦截导出）。两者都通过真实 HTTP 和 `listen(0)`，测试文件顺序执行；全量测试的全局准备会预先占住 Fetch 规范禁用的端口。本次 `npm test` 中两项分别以 420.081 ms、13.9927 ms 通过。先前两次快速失败没有原始回包，且集成方已复跑 40 多次未复现；现在的断言会附回包原文。现有证据不足以判定根因，因此没有改这两项测试或业务逻辑。
