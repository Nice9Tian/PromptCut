# AGENT 报告：cloud-see-frames-fix

## 任务概述
修复云端 Agent `see_frames` 在 `account-runner.mjs`、`account-task-worker-config.mjs` 与 `account-master-assembly.mjs` 中的 403 `run-authority-denied`（`assignmentDigest` 丢失）与请求过早取消（`req.on('close')` 误触发）问题，并避免无本地页面桥时多余的 `selection.query` 请求。

## 状态
进行中
