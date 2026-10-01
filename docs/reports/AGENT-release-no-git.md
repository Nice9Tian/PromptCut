# AGENT-release-no-git:发版打包不再带 `.git`

分支 `claude/release-no-git`(起点 main `729ce7f6`)。状态:进行中。

## 任务

`--from-head` 的临时 worktree 根目录下 `.git` 是指针**文件**,`prepare-runtime.mjs` 的 `shouldCopyApp` 只在 `isDir` 时才查 `SKIP_DIRS`,于是它被拷进 `runtime/app`,进了补丁清单。要求:文件和目录形态都跳过;核对 `make-patch.mjs`;加单测。

## 进展

(开工,尚未改动)
