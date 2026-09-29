# AGENT 报告：post-m8-r2

分支 `claude/post-m8-r2`。任务：主会话把 `server/bakery/ffmpeg.mjs` 还原成 main（提交 `e24eafb8`）后，`server/test/storage-leftovers.test.mjs` 里测「`streamPngVideo().abort()` 删输出文件」的用例挂了，要处理掉，并确认没有别处依赖这个行为。

进行中。
