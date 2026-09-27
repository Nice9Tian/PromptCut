# AGENT 报告：c10-site（C10 浏览器探针的外网模式与独立主机角色）

分支 `claude/c10-site`，起点 `24c2c57`（claude/c10-integ）。端口段 5420～5429。

## 任务

1. `scripts/probes/c10-browser-probe.mjs` 加 `--site <源>`：对远端（阿里云）核 A1～A4。
2. 加独立主机角色 `--role host --run <id>`：跨机完成 A5（HT9）。
3. 本机替身一轮照旧全过；外网一轮等主会话通知部署后再跑。

## 进度

- 建报告（本提交）。
