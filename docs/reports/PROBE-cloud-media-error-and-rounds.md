# 验证证据：取素材报错人话化 + 常规轮次上限 24 → 48

分支 `claude/cloud-media-error`。机器：本机 PC（Windows 11）。日期 2026-10-24。

## 这次改了什么

1. `server/agent/service/hosted-media-frames.mjs`：新增 `mediaFetchError()`，图片直读和视频抽帧两条路都用它翻译 `assets.openRead` 的报错。原先图片那条路没有 try/catch，`project-assets-read-failed` 这种代号原样抛给模型。
2. 常规（非「深度自主」）轮次上限 24 → 48，一轮墙钟上限 30 分钟 → 60 分钟：
   `server/runners/api.mjs`、`server/agent/service/create-agent-service.mjs`、`server/ai-config.mjs`（注释）、`docs/semantics/mechanism/agent.md`。

## 为什么改

云端会话 `cc-mvm5fqj9-y7bk`（项目 `sp_gxmnxgw5j6qgstffwglr2tlyih`，2026-10-24 08:40–09:03 UTC）：

- 第 2、3 轮两次 `see_frames({source:'media'})` 都回 `{"error":"project-assets-read-failed"}`。模型看不出该不该重试，原样重试了一遍。根因在生产节点（`PROMPTCUT_ASSET_RUN_ENABLED=0`，素材服务 run-assets 路由直接 503），但报错本身该说人话。
- 这一轮 22.6 分钟里工具只跑了 35 秒，其余全是模型写代码；24 轮里有 18 轮花在 `code_cache_*` 上，`create_card` 一次都没调到，撞上限停住，时间线是空的。

## 测试

| 命令 | 结果 |
|---|---|
| `npm test -- server/test/cloud-tools-p1-media-frames.test.mjs` | 5/5 通过（含新增 P1-MF-05） |
| `npm test -- server/test/deep-auto.test.mjs server/test/cloud-agent-runs.test.mjs server/test/agent-user-message.test.mjs server/test/agent-summary-shape.test.mjs` | 51/51 通过 |

影响范围怎么算：改到的两个文件本身的测试（`cloud-tools-p1-media-frames`、`cloud-agent-runs`），加上读轮次上限那几条行为的测试（`deep-auto`、`agent-user-message`、`agent-summary-shape`）。

## 构建与类型检查

| 命令 | 结果 |
|---|---|
| `npx tsc -b --force` | 退出码 0，零错误 |
| `npm run build` | 成功 |

## 探针

| 探针 | 命令 | 结果 |
|---|---|---|
| 云端 Agent 工具表接线 | `node scripts/probes/cloud-tools-wire-probe.mjs`（带 `PROMPTCUT_ACCOUNT_PROVIDER_ROOT`、`PROMPTCUT_PASSWORD_ORDER_MODULE`） | `PROBE-RESULT pass {"total":40,"ok":40,"fail":0,"skip":0}` |

这次没改到画面，按 `docs/semantics/guide_files/verification.md`「按改动范围验证」不跑渲染附加项（导出确定性、快照重放、与 main 的像素比对、预渲染探针）。

`see_frames` 的素材直读这一支没有独立探针，由新增的 P1-MF-05 单测覆盖三种报错分支（通道关着、字节没了、没见过的代号）。

## 没做的

- 生产节点上的 `PROMPTCUT_ASSET_RUN_ENABLED=0` 没有动，这次只改仓库代码。
- 墙钟上限一起放宽到 60 分钟是跟着轮次改的配套项：24 轮已经用掉 22 分钟，只放宽轮次不放宽墙钟等于白放。要是不想让一轮跑到一小时，把 `create-agent-service.mjs` 的 `runMs` 改回去即可。
