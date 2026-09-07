# 诊断报告收集端

一个 Cloudflare Worker：接住 PromptCut「诊断」子窗口里点「提交」发来的报告，存进 KV，
再往飞书群发一行摘要 + 取报告的链接。取回来看的界面是 `tools/report-inbox-gui/`
（根目录双击 `report-inbox.bat`）。

跑在 Workers 免费计划上：每天 10 万次请求、KV 1GB / 每天 1000 次写。收诊断报告用不完。
**不用绑卡**——这也是这里用 KV 而不是 R2 的原因，R2 即使只用免费额度也要求账号先绑卡。

## 当前部署

| | |
|---|---|
| 地址 | `https://promptcut-reports.promptcut.workers.dev` |
| 账号 | miaomiaoyum@outlook.com（`561a7d6d1d6ed81c19bdcc963bffc716`） |
| KV | `REPORTS` = `7a697d9718d74daeaabdcff73db1f8eb` |
| 已设密钥 | `ADMIN_KEY`、`SUBMIT_TOKEN` |
| 还没设 | `FEISHU_WEBHOOK`（不设就只存不通知） |

改完代码重新部署：`npx wrangler deploy`。

## 接口

| | |
|---|---|
| `POST /` | 收报告。body 是 `text/plain` 装着的 JSON，要带 `token` |
| `GET /r/<id>?k=<ADMIN_KEY>` | 取全文 |
| `DELETE /r/<id>?k=<ADMIN_KEY>` | 删一份 |
| `GET /list?k=<ADMIN_KEY>[&cursor=][&limit=]` | 列清单，一页最多 1000 条 |

key 不对一律回 **404 而不是 403**：不告诉扫描的人这里有东西。

**报告不设过期时间。** 原来挂了 90 天 TTL，那等于替人认定「只有近期的报告有用」——
隔半年回头对一个老问题，东西已经自己删没了。该不该删由收件箱里的删除按钮决定。
KV 免费额度 1GB，真堆满了再谈清理。

收件箱刷新时会**拿着游标一路翻到底**，不是只给第一页。`limit` 参数主要给自检用
（压小页大小验证翻页），正常不用传。

注意 KV 的 list 是**最终一致**的：刚写完立刻列可能是空的，删完也要等十几二十秒
才从清单里消失。这不是 bug，自检脚本里为此留了等待。

## 从零部署一遍

```bash
npx wrangler login --device --scopes account:read user:read workers:write workers_kv:write workers_scripts:write workers_tail:read
```

用 `--device` 而不是默认的 localhost 回调：默认那个只等两分钟，人来不及操作就超时。
`--scopes` 把权限砍到这五项，默认会连 DNS、邮件发送、`connectivity:admin` 一起要走。

```bash
npx wrangler kv namespace create REPORTS
```

把打印出来的 id 填进 `wrangler.jsonc` 的 `kv_namespaces[0].id`。

```bash
npx wrangler secret put ADMIN_KEY
npx wrangler secret put SUBMIT_TOKEN
npx wrangler secret put FEISHU_WEBHOOK
```

| 名字 | 填什么 |
|---|---|
| `ADMIN_KEY` | 长随机串。取报告、列清单、删除都要带它 |
| `SUBMIT_TOKEN` | 另一串。前端提交时带上，挡住地址被扫到后随手灌数据 |
| `FEISHU_WEBHOOK` | 飞书群自定义机器人的 webhook 地址 |

```bash
npx wrangler deploy
```

账号第一次部署还要有 workers.dev 子域名。wrangler 4 没有对应命令，
要么在后台点一下 Workers & Pages 页面（会自动创建），要么打 API：
`PUT /accounts/<id>/workers/subdomain`，body `{"subdomain":"名字"}`。
新子域名的证书要几分钟才签发好，这期间访问会是 TLS 握手失败，等就行。

## 接到前端

项目根目录 `.env.local`（已被 .gitignore 忽略）：

```
VITE_DIAG_SUBMIT_URL=https://promptcut-reports.promptcut.workers.dev
VITE_DIAG_SUBMIT_TOKEN=<和 SUBMIT_TOKEN 一样的那串>
```

重启 `npm run dev`，诊断子窗口里那个灰着的「提交」按钮就亮了。

## 飞书链接里带着 ADMIN_KEY

`notifyFeishu` 发出去的链接是把 `k` 拼好的，也就是**群里的人都能点开报告全文**。
这是有意的取舍：省掉一套登录。不想这样就把 `link` 改成只发 `id`，自己用收件箱界面取。

## 想更防滥用

`SUBMIT_TOKEN` 跟着前端打包发出去，拦不住铁了心的人。真要防，在 Cloudflare 后台给这条
Worker 路由加一条 **Rate limiting** 规则（按 IP 限速，在边缘上算，不吃 Worker 配额）。
