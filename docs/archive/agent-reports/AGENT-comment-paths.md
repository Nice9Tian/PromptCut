# AGENT 报告：comment-paths

分支 `claude/comment-paths`，起点 main `c9a4810c`。

任务：代码注释与文件头里归档前的报告路径 `docs/reports/AGENT-<名>.md` 改成 `docs/archive/agent-reports/AGENT-<名>.md`；快照键与捕获代码覆盖的文件（`server/frame-code.mjs` 的 `SNAPSHOT_FILES`、`CAPTURE_FILES`）不动。

## 做了什么

- `git grep -n "docs/reports/AGENT-" -- ':!*.md'` 改前共 65 处、51 个文件，全部在 `scripts/`、`server/`、`src/` 下（`desktop/scripts/`、`python/`、`src/cards/user/` 里没有）。
- 引用到的 23 份报告在 `docs/archive/agent-reports/` 里全部存在；`docs/reports/` 里没有现存的同名报告。
- 改了 **60 处、49 个文件**。只替换路径前缀，其余字节不动：把 diff 的删除行与新增行各自抹掉路径前缀后逐字节比较，完全相同；换行符未变（diff 只有 60 行增 60 行删）。

## 没改的（5 处，都在快照键 / 捕获代码覆盖的文件里）

`server/frame-code.mjs` 里 `SNAPSHOT_FILES` = `BAKERY_FILES`（chrome、bake、shards、media、ffmpeg、export、audio-mix）+ `capture-snapshot.mjs` + `src/render/createSnapshot.ts`、`src/render/snapshot/{inlineStyles.ts,rasterizeCanvas.ts,snapshotStyleProps.mjs,renameSceneIds.ts}`、`src/render/snapshotRename.ts`；`CAPTURE_FILES` = `BAKERY_FILES` + capture-frame、capture-snapshot、frame-media、frame-ready、png-integrity。改其中任何一个字符都会换指纹，所以原样留下：

| 文件 | 行 | 写的报告 |
|---|---|---|
| `server/bakery/ffmpeg.mjs` | 174 | `AGENT-perf-encode.md` |
| `server/bakery/ffmpeg.mjs` | 179 | `AGENT-perf-encode-2.md` |
| `server/bakery/ffmpeg.mjs` | 214 | `AGENT-perf-encode-2.md` |
| `server/bakery/ffmpeg.mjs` | 244 | `AGENT-perf-encode.md` |
| `src/render/snapshot/renameSceneIds.ts` | 6 | `AGENT-c10-probe.md` |

目标不存在而没改的：无。

## 验证

- `git grep -n "docs/reports/AGENT-" -- ':!*.md'`：改后只剩上表 5 处。
- 指纹 `snapshotCode` / `captureCode`：改前 `00a5264bf8a062ff6e0b5ed0516cccd1` / `86e443cb6fa838aef64788af6822fd68`；改后相同。
- `npx tsc -b --force`：退出码 0，0 错误。
- `npm test`（PATH 前置 ffmpeg 目录）：退出码 0；tests 3963，pass 3961，fail 0，skipped 2，cancelled 0。

## 建议

- 这 5 处要等下次这些文件因别的原因本来就要改（本来就会换快照键）时顺手改掉。

## 主会话审查（2026-09-30，笔记本主会话）

- 另核 diff：除本报告外，改动的行把 `docs/archive/agent-reports/` 换回 `docs/reports/` 后逐字相同；`SNAPSHOT_FILES` / `CAPTURE_FILES` 里的文件一个没碰。
- 合入 main `e3a09498`；留下的 5 处记进 `REPORT-post-M8.md` 第 2 轮遗留。
