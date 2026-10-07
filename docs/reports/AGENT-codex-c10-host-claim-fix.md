# C10 独立渲染主机认领修复报告

2026-10-08。独立包 `codex/c10-host-claim-fix`，基点 `913e6884`。A5 指 C10 在线普通档完整版中由独立渲染主机认领清单计划、切分并完成新版本，而不是页面自己完成。

## 范围与初始证据

先只读定位，允许初始源码为 `scripts/probes/c10-browser-probe.mjs`、`scripts/render-host.mjs` 及专属主机测试。真实缺口如在其它文件，先向协调者给证据和精准范围申请，不擅改。不得降低 A5 功能断言，不做新调度/故障策略。原账号基础与调度文档工作区保留；不合并、推送、main、部署或清理其它进程。

已完整读取根原始 `P-c10-browser-full.log`：候选 `913e6884`，A1～A4通过，A5等待923588毫秒，整项1105203毫秒退出1。主机ready=true且连接会话open，计划@2为open；无主机claimant/cut/external，页面自身新层120帧。因此不能把页面可见新画面算主机成功，也不能仅凭本轮新代码判定回归。日志主机capabilities包含userCards=true、graphCards/transcode/streams=false；真实ffmpeg PATH存在。

已读入口规则；独占worktree没有docs/local.md，检索该文件报不存在，将按主会话已提供环境与只读主工作区文档核对。后续补实际根因、最小修改、复现/验证原始尝试和证据。
