//! `.proc` 的独占锁,由外壳持有。
//!
//! # 为什么锁在这儿而不在 Node
//!
//! Node 的 fs 没有任何锁原语 —— 实测:一个进程 `open(file,'r+')` 拿着,另一个进程照写不误。
//! 它能做的只有「原子创建一个 .lock 文件」(`open(path,'wx')` 是原子的,实测 20 个进程
//! 并发抢只有 1 个赢)。但这种锁有个治不好的毛病:**持有者被强杀,锁文件留在原地**。
//! 于是只能往锁里写 pid、下次读到锁先判活 —— 而 pid 会被系统回收,死进程的号被新进程占了
//! 就误判成「还有人占着」,用户永远打不开自己的项目。
//!
//! Windows 的文件共享模式没有这个问题:句柄由内核管,**进程一死内核就收走**(实测:强杀
//! 持有者之后,另一个进程立刻就能打开)。这件事只有拿得到原生句柄的一侧能做,所以放在外壳。
//! 而且不用加任何依赖 —— `std::os::windows::fs::OpenOptionsExt::share_mode` 是标准库的。
//!
//! # 锁的是 .lock,不是 .proc 本身
//!
//! 这一条是实测逼出来的:用 share_mode(0) 锁住 .proc **本体**之后,Node 连读都读不了
//! (EBUSY),写和删也一样。而 .proc 恰恰是 Node sidecar 要读写的那个文件 —— 锁上它等于
//! 把自己人挡在门外。所以锁一个**空的旁路文件** `<name>.proc.lock`:
//!   * 谁都不需要写它,只需要「能不能打开」这一个信号;
//!   * Node 那边 `open(lock,'r+')` 拿到 EBUSY 就知道有人持有,而且这个信号来自内核,
//!     不需要判活、不会误判;
//!   * 实测持有期间别的进程连**删都删不掉**,想偷锁都偷不走。
//!
//! # SKILL 模式下不加锁
//!
//! 那时候无头实例在写任务目录里的 project.proc,外壳和用户那份都要读它更新状态。
//! 独占会把读也挡掉。那段时间的安全由「只有 agent 一个人在写」保证 —— 用户那份的
//! AI 面板是锁住的。

use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// 本进程持有的锁。句柄活着锁就在;从这里移除(Drop)就等于放锁。
pub struct ProcLocks(Mutex<HashMap<PathBuf, File>>);

impl ProcLocks {
    pub fn new() -> Self {
        ProcLocks(Mutex::new(HashMap::new()))
    }
}

impl Default for ProcLocks {
    fn default() -> Self {
        Self::new()
    }
}

fn lock_path(proc_path: &Path) -> PathBuf {
    let mut s = proc_path.as_os_str().to_os_string();
    s.push(".lock");
    PathBuf::from(s)
}

/// 打开旁路锁文件并**独占**它。拿到 Ok 就是锁到手了,句柄一直握着别 drop。
#[cfg(windows)]
fn open_exclusive(path: &Path) -> std::io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        // 0 = 谁都别想再打开这个文件,读写删全挡。这就是「独占」的全部实现,
        // 不需要 LockFileEx,也不需要任何第三方 crate。
        .share_mode(0)
        .open(path)
}

/// 非 Windows 上没有共享模式这套东西。桌面壳只发 Windows 包,这里只是让代码编得过;
/// 真要支持别的平台,该走 flock(2),但那是另一件事,不在这里假装做到了。
#[cfg(not(windows))]
fn open_exclusive(path: &Path) -> std::io::Result<File> {
    OpenOptions::new().read(true).write(true).create(true).open(path)
}

/// 抢锁。已经是自己持有的直接返回成功(重复打开同一个项目不该失败)。
pub fn acquire(locks: &ProcLocks, proc_path: &str) -> Result<(), String> {
    let target = PathBuf::from(proc_path);
    let mut held = locks.0.lock().map_err(|e| e.to_string())?;
    if held.contains_key(&target) {
        return Ok(());
    }
    match open_exclusive(&lock_path(&target)) {
        Ok(f) => {
            held.insert(target, f);
            Ok(())
        }
        // 拿不到就是有人正持有。内核说的,不用再去判活
        Err(e) => Err(format!("这个项目文件正被另一个 PromptCut 打开({e})")),
    }
}

/// 放锁。句柄 drop 掉,内核那一刻就把文件放开了。
pub fn release(locks: &ProcLocks, proc_path: &str) {
    if let Ok(mut held) = locks.0.lock() {
        held.remove(&PathBuf::from(proc_path));
    }
}

/// 全放掉(退出 / 进 SKILL 模式时)。
pub fn release_all(locks: &ProcLocks) {
    if let Ok(mut held) = locks.0.lock() {
        held.clear();
    }
}

/// 现在有没有别人占着。给 Node 那边查询用 —— 它自己查不到这个信号。
pub fn is_locked_by_other(locks: &ProcLocks, proc_path: &str) -> bool {
    let target = PathBuf::from(proc_path);
    if let Ok(held) = locks.0.lock() {
        if held.contains_key(&target) {
            return false; // 自己持有的不算「别人」
        }
    }
    // 试着独占一下:开得了就说明没人占,随即 drop 放掉
    open_exclusive(&lock_path(&target)).is_err()
}
