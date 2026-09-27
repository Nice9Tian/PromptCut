# AGENT 报告：bad-ports-concurrency

分支 `claude/bad-ports-concurrency`（从 main `7d90218` 起）。

## 任务

「坏端口」指 WHATWG fetch 规范拒绝连接的端口：Node 的 fetch 和 WebSocket 连都不连。`npm test` 的全局准备在测试期间占住其中 ≥ 1024 的 19 个，让测试文件 `listen(0)` 拿不到它们。

同一台机器上并行跑多份 `npm test` 时出现两个问题：

- 后起的那份占不到坏端口（先起的那份占着）。自检「本次自己占到的 ≥ 名单数 − 3」因此误报失败，主会话最近两次基线都挂在这一条。
- 先起的那份收尾时放掉端口，后起的那份不会再去占，这时它的测试文件有可能拿到坏端口。

## 做了什么

只改了 `server/test/global-setup.mjs` 与 `server/test/bad-ports.test.mjs`。

- `global-setup.mjs`
  - 占住的监听按「端口@地址」记在一张表里。启动时没占全，就起一个每秒一次的定时器，重试还没占到的（端口, 地址）对。同一时刻只跑一轮重试；全部占到后定时器自己停下。定时器 `unref`，不拖住进程。
  - `globalTeardown` 先停定时器，等正在跑的那轮重试结束，再关掉全部监听。
  - `PROMPTCUT_TEST_BAD_PORTS_HELD` 仍写启动时占到的端口，只作参考。
  - 文件头补了并行跑时的说明。
- `bad-ports.test.mjs` 第二条改成不变式：名单里的每个坏端口，在 127.0.0.1 上 `listen` 都得到 `EADDRINUSE`，不论是本次全局准备占的，还是另一份 `npm test` 或别的程序占的。去掉了「自己占到的 ≥ 名单数 − 3」。单独跑本文件（没有全局准备）时照旧跳过。

## 验证

- 接手探针（`scratchpad/bpc/probe-takeover.mjs`，没有入库）：探针先把 6665 的两个地址都占住，模拟先起的那份 `npm test`，再跑 `globalSetup`。
  - 启动时占到 18 个端口，不含 6665。
  - 探针放掉 6665 后马上 listen：`listening`，这就是原先的小窗口。
  - 1.5 s 后再 listen：`EADDRINUSE`，说明定时重试已经接手。
  - `globalTeardown` 后 6665 与 10080 都是 `listening`，端口都放掉了。
- `npx tsc -b --force`：退出码 0，零错误。
- 两份 `npm test` 同时跑，都在本 worktree，间隔 6 s 启动：
  - 第一轮：A 失败 2，B 失败 1。两份的坏端口自检都通过。失败的用例与坏端口无关，见下一节。
  - 第二轮：A 为 tests 3114 / pass 3112 / fail 0 / skipped 2，退出码 0；B 为 tests 3114 / pass 3112 / fail 0 / skipped 2，退出码 0。
- 单跑两次：每次都是 tests 3114 / pass 3112 / fail 0 / skipped 2，退出码 0。跳过的两条是 cards-layout 集成用例与 SKILL 闸门集成用例。
- 单独跑 `node --test server/test/bad-ports.test.mjs`：第一条通过，第二条跳过。
- 所有测试跑完后逐个 listen 这 19 个端口，全部空闲，没有残留占用。

## 没做成的及原因：并行时另有两处会互相踩（不在本任务的文件清单里）

第一轮并行的 3 个失败都不是坏端口的问题：

1. `server/test/sp-hosted.test.mjs` 的 SPC7-1、SPC7-2。它用 `sp-kit.mjs` 的固定端口 5490～5499 起 hosted 子进程。两份 `npm test` 的这个文件在时间上重叠时，会连到对方的实例：报告里出现「共享项目 from 2 / to 1」，以及 `ECONNRESET`。不论两份 `npm test` 在哪个 worktree 里，只要同时跑就会撞。
2. `server/test/queue-node-wiring.test.mjs` 的 J5。它有真实 I/O，每步只给 5 ms 真实时间，最多 400 步。两份同时跑、CPU 加倍时可能跑不完，报的是「超过 400 步仍未满足条件」。这是负载下的时间预算问题。

第二轮两份都 0 失败，说明这两处要看时间上是否重叠。

## 对任务书的更正建议

- 「并行两份 `npm test` 都 0 失败」目前没法稳定保证，因为有上面两处。建议另立任务：
  - `sp-hosted` 改成 `listen(0)`，或按进程挑空闲端口段；
  - J5 的真实时间预算放宽，或改成按条件等待。
- 本次修复只保证坏端口这一条在并行时不再误报，也不再漏占。
