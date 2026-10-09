# 执行器目标测试端口隔离

root 的固定 `ff51441c` 全量首次 5455 项、5449 通过、2 失败、4 跳过：account-executor-assembly-mtls 与 account-executor-visible-wire 并发使用 6640。该首次失败保留于 root 原全量记录，未作为产品权限断言失败。独立定向过不能证明全量并发无冲突。

本块只改两份目标及 visible fixture：前两者 doc/public/control 均请求 OS 端口 0，并回读实际 server.address/assembly.controlPort；visible fixture 默认 6640/6641/6642 不变，浏览器探针仍有独占固定段。没有改 runner、协议、权限断言、suite concurrency 或超时。fixture 返回实际端口和收口信息。

验证待固定源码后，两份 npm targets 同一命令实际并行执行；不跑全量、浏览器或业务模型。
