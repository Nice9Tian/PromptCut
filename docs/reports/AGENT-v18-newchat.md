# AGENT-v18-newchat：新开的云端对话一直显示「正在重新连接」

分支 `claude/v18-newchat`，起点 main `f87e297a`。端口段 28850～28889。

几个词：**事件流**是页面向 Agent 服务读一个对话里发生的事（`GET /agent/v1/conversations/<id>/events`）；**读取通道**是 Agent 服务经文档服务核对"这个账号能不能读这个对话"的那条通道（`server/agent/service/conversation-transports.mjs`）；**边缘代理**是生产里站在浏览器和各服务之间的那层反向代理（探针夹具里也有一层，上游连接被掐时它回 502）。

## 状态

开工，下面逐块补。

## 对任务书或语义的更正建议

（待补）
