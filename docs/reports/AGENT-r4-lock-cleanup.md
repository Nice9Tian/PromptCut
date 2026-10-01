# R4：正常退出后清掉草稿旁路锁

主会话在 `claude/r4-lock-cleanup`、`.worktrees/r4-lock-cleanup` 自己执行，起点 `d391883f`。没有调用顾问或子 Agent。

## 现象与尺子

2026-10-02 04:10，安装版 0.7.14 / 外壳 0.2.7 打开测试草稿后收起，运行交接的 `quit-test.cmd`。1.35 s 时应用进程全退、`fallback used: False`，但 `20261002-a45tst.proc.lock`（64 字节）仍在。外壳先放内核句柄，随后 `taskkill /F /T`，Node 的 `process.on('exit', releaseAll)` 没有机会执行。

尺子：`rustc --test desktop/src-tauri/src/proc_lock.rs -o out/proc-lock-tests.exe; out/proc-lock-tests.exe`，以及修复后的完整安装包重复 R4：退出后进程 0、旁路锁文件不存在、重开位置保持。

## 卡点 1 解法表

| # | 轮 | 层 | 父 | 候选 | 改善机制 | g | h | f | 验证 | 状态 | 结果 / 学到 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1 | 三级 | — | Windows 独占句柄加删除权限与 delete-on-close | 内核在关闭最后一个句柄时删除锁文件；不依赖 Node 回调，也不留先放句柄再按路径删的竞争窗口 | 1，局部改锁打开参数 | 1，直接消掉残留文件 | 2 | Rust 真实文件与子进程测试；R4 真机 | 开放 | Microsoft CreateFile 文档支持该生命周期 |
| 2 | 1 | 三级 | — | 外壳退出时请求 Node 放锁并等待应答 | 在强杀之前执行锁清理回调 | 3，多一条退出接口与有界等待 | 2，HTTP 故障仍要兜底 | 5 | 同上 | 开放 | 第一行失败才尝试 |
| 3 | 1 | 三级 | — | 松句柄后按路径删除 | 删掉旁路文件 | 1 | 3，存在新持有者竞争窗口 | 4 | 并发抢锁 | 关闭·剪（方向已关） | 不能保证删的仍是自己的锁 |

官方依据：[CreateFile 的 FILE_FLAG_DELETE_ON_CLOSE](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew)。本次只修实现，不改语义。

## 验证

2026-10-02：`npx tsc -b --force` 退出码 0；`npm test` 共 4217，过 4216、失败 0、跳过 1，80.09 s。日志在本 worktree 的 `out/a45-validation/`。

上述 Rust 测试先在未修代码上确认 3 项都失败；修复后 3 项通过、失败 0，另 1 项是被父测试调用的忽略子进程入口。覆盖单锁释放、全量释放和重新获取、持有进程被强杀后由内核删除锁文件；测试草稿正文保持。真实安装包 R4 复测待集成构建后补齐。
