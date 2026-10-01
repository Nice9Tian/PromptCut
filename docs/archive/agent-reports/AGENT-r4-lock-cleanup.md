# R4：正常退出后清掉草稿旁路锁

主会话在 `claude/r4-lock-cleanup`、`.worktrees/r4-lock-cleanup` 自己执行，起点 `d391883f`。没有调用顾问或子 Agent。

## 现象与尺子

2026-10-02 04:10，安装版 0.7.14 / 外壳 0.2.7 打开测试草稿后收起，运行交接的 `quit-test.cmd`。1.35 s 时应用进程全退、`fallback used: False`，但 `20261002-a45tst.proc.lock`（64 字节）仍在。外壳先放内核句柄，随后 `taskkill /F /T`，Node 的 `process.on('exit', releaseAll)` 没有机会执行。

尺子：`rustc --test desktop/src-tauri/src/proc_lock.rs -o out/proc-lock-tests.exe; out/proc-lock-tests.exe`，以及修复后的完整安装包重复 R4：退出后进程 0、旁路锁文件不存在、重开位置保持。

## 卡点 1 解法表

| # | 轮 | 层 | 父 | 候选 | 改善机制 | g | h | f | 验证 | 状态 | 结果 / 学到 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1 | 三级 | — | Windows 独占句柄加删除权限与 delete-on-close | 内核在关闭最后一个句柄时删除锁文件；不依赖 Node 回调，也不留先放句柄再按路径删的竞争窗口 | 1，局部改锁打开参数 | 1，直接消掉残留文件 | 2 | Rust 真实文件与子进程测试；R4 真机 | 已试·成功 | Rust 正常/强杀真实文件测试通过；修复后的实际安装版镜像关闭归零、锁删除、重开位置相同 |
| 2 | 1 | 三级 | — | 外壳退出时请求 Node 放锁并等待应答 | 在强杀之前执行锁清理回调 | 3，多一条退出接口与有界等待 | 2，HTTP 故障仍要兜底 | 5 | 同上 | 开放 | 第一行失败才尝试 |
| 3 | 1 | 三级 | — | 松句柄后按路径删除 | 删掉旁路文件 | 1 | 3，存在新持有者竞争窗口 | 4 | 并发抢锁 | 关闭·剪（方向已关） | 不能保证删的仍是自己的锁 |

官方依据：[CreateFile 的 FILE_FLAG_DELETE_ON_CLOSE](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew)。本次只修实现，不改语义。

## 验证

2026-10-02：`npx tsc -b --force` 退出码 0；`npm test` 共 4217，过 4216、失败 0、跳过 1，80.09 s。日志在本 worktree 的 `out/a45-validation/`。

上述 Rust 测试先在未修代码上确认 3 项都失败；修复后 3 项通过、失败 0，另 1 项是被父测试调用的忽略子进程入口。覆盖单锁释放、全量释放和重新获取、持有进程被强杀后由内核删除锁文件；测试草稿正文保持。真实安装包 R4 复测待集成构建后补齐。

集成 `cargo test` 发现测试夹具的 `--exact tests::r4_child_holds_lock` 只适用于直接编译本文件：Cargo 下全名是 `proc_lock::tests::r4_child_holds_lock`，子进程选中了 0 条测试。改用唯一的函数名筛选，生产实现不变；用带 `mod proc_lock` 的独立 Rust harness 复现 Cargo 命名后，3 项通过、1 个子入口忽略。再次 `npx tsc -b --force` 退出 0、`npm test` 4217 / 4216 / 0 / 1（91.88 s）。

2026-10-02 07:52，本机测试安装包 0.7.14 / 外壳 0.2.7 实际复验。打开 A（20261002-a45tst），旁路锁 64 字节；展开 Rect=240,54 2422x1453，点页面窗口 × 收起，原生 PrintWindow 截下悬浮窗。镜像调用方计数已按 claude/ps1-process-count 修正为数组，退出顺序不变：0.39 s 发 --quit，1.35 s after wait=0，3.48 s final=0、fallback=False。完整 proc-table 安装目录名下为 0；A/B 正文 4554/4555 字节保留、两份锁不存在。经 explorer 重开后 Rect 仍为 240,54 2422x1453。随后实际「文件→退出」，再次确认进程 0、两侧登记恢复布尔值 false/false/true/true。

证据在集成 worktree `desktop/.cache/a45-install/`：r4-final-open-a.png、r4-final-overlay.png、r4-final-quit-test.log、r4-final-reopen.png、r8-final-file-menu.png。本轮最后复验时 Windows 输入桌面在 Screen-saver，物理桌面抓图失败；使用真实 WebView 截图与原生窗口 PrintWindow，没有伪造桌面截图。退出后网页截图返回 TargetCloseError 是目标实际关闭，再用外部进程表核对。R4 的镜像通过仍不代替 R5 真补丁安装。
