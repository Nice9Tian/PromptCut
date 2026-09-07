//! SKILL 模式下外壳的形态切换。
//!
//! 进了 SKILL 模式,项目交给无头实例上的 agent 去改,主窗口就没必要占着屏幕了 ——
//! 收起来变成右上角一枚悬浮图标,双击才重新展开。图标上顺带显示 agent 改到哪了。
//!
//! 状态从哪来:`~/Documents/PromptCut-Skill/skill-state.json`,由 Node 那边写
//! (server/skill-gate.mjs)。这里**轮询**它,不走前端事件:
//!   * 网页可能正在重载、可能还没加载完,事件会丢;文件一直在;
//!   * SKILL 模式本来就可能被另一个进程(无头实例)改掉,只有文件是三方共同的约定;
//!   * 一秒一次读一个几百字节的 JSON,代价可以忽略。
//! 一句话:**以文件为准**,窗口形态只是它的投影。
//!
//! 为什么不放 %LOCALAPPDATA%:PromptCut 有可能跑在 MSIX 容器里,那时对 %LOCALAPPDATA%
//! 的写入会被重定向进包私有目录,壳和 Node 看到的就不是同一个文件了。Documents 不会。

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tauri::webview::WebviewWindowBuilder;
use tauri::{Emitter, Listener, Manager, WebviewUrl};

/// 悬浮图标那个窗口的标签。capabilities/default.json 里要放行它,否则页面上
/// `window.__TAURI__` 是空的,双击事件发不出来。
pub const OVERLAY_LABEL: &str = "skill-overlay";

const OVERLAY_W: f64 = 232.0;
const OVERLAY_H: f64 = 72.0;
/// 离屏幕右上角的边距
const OVERLAY_MARGIN: f64 = 16.0;

fn skill_root() -> PathBuf {
    if let Ok(v) = std::env::var("PROMPTCUT_SKILL_DIR") {
        if !v.trim().is_empty() {
            return PathBuf::from(v);
        }
    }
    let home = std::env::var("USERPROFILE").unwrap_or_else(|_| "C:\\Users\\Default".into());
    PathBuf::from(home).join("Documents").join("PromptCut-Skill")
}

fn state_path() -> PathBuf {
    skill_root().join("skill-state.json")
}

/// 推给悬浮图标的一小段状态。字段名和网页里那份对齐,省得两边各起一套。
#[derive(Serialize, Clone, Default)]
pub struct OverlayInfo {
    pub active: bool,
    pub job_id: Option<String>,
    /// agent 改出来的卡片数
    pub clips: Option<u64>,
    /// project.proc 上次被写的时间,给「还在动吗」一个交代
    pub updated_at: Option<String>,
}

/// 读状态文件。读不到、坏了都按「关着」处理 —— 拿不准的时候别把用户的窗口藏起来。
fn read_state() -> (bool, Option<String>, Option<PathBuf>) {
    let Ok(text) = fs::read_to_string(state_path()) else {
        return (false, None, None);
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
        return (false, None, None);
    };
    let active = v.get("active").and_then(|x| x.as_bool()).unwrap_or(false);
    let job = v.get("jobId").and_then(|x| x.as_str()).map(str::to_string);
    let proc = v
        .get("procPath")
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);
    (active, job, proc)
}

/// 读 agent 那份 project.proc,数一下有几张卡、什么时候写的。
/// 它正被另一个进程写,读到半截 JSON 很正常 —— 解析失败就当这一轮没读到,下一秒再来。
fn read_proc_progress(proc: &PathBuf) -> (Option<u64>, Option<String>) {
    let Ok(meta) = fs::metadata(proc) else {
        return (None, None);
    };
    let updated = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs().to_string());
    let clips = fs::read_to_string(proc)
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| {
            v.get("project")
                .and_then(|p| p.get("tracks"))
                .and_then(|t| t.as_array())
                .map(|tracks| {
                    tracks
                        .iter()
                        .filter_map(|t| t.get("clips").and_then(|c| c.as_array()))
                        .map(|c| c.len() as u64)
                        .sum()
                })
        });
    (clips, updated)
}

/// 把悬浮图标摆到主显示器右上角。拿不到显示器信息就放个保守的位置,总比不显示强。
fn place_top_right(win: &tauri::WebviewWindow) {
    let (sw, scale) = win
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| (m.size().width as f64, m.scale_factor()))
        .unwrap_or((1920.0, 1.0));
    let logical_w = sw / scale;
    let x = (logical_w - OVERLAY_W - OVERLAY_MARGIN).max(0.0);
    let _ = win.set_position(tauri::LogicalPosition::new(x, OVERLAY_MARGIN));
}

fn overlay(handle: &tauri::AppHandle) -> Option<tauri::WebviewWindow> {
    handle.get_webview_window(OVERLAY_LABEL)
}

/// 进 SKILL 模式:主窗收起来,右上角浮一枚图标。
pub fn enter(handle: &tauri::AppHandle) {
    if let Some(main) = handle.get_webview_window("main") {
        let _ = main.hide();
    }
    if let Some(w) = overlay(handle) {
        let _ = w.show();
        place_top_right(&w);
        return;
    }
    match WebviewWindowBuilder::new(handle, OVERLAY_LABEL, WebviewUrl::App("overlay.html".into()))
        .title("PromptCut · SKILL")
        .inner_size(OVERLAY_W, OVERLAY_H)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        // 不进任务栏:它是个挂件,不是一个「窗口」。Alt+Tab 里多一项反而让人迷惑
        .skip_taskbar(true)
        .shadow(false)
        .build()
    {
        Ok(w) => place_top_right(&w),
        Err(e) => {
            // 悬浮窗建不出来就别把主窗留在隐藏状态 —— 那等于软件凭空消失了
            eprintln!("[skill] 悬浮图标创建失败,恢复主窗口: {e}");
            if let Some(main) = handle.get_webview_window("main") {
                let _ = main.show();
                let _ = main.set_focus();
            }
        }
    }
}

/// 出 SKILL 模式:图标收掉,主窗回来。
pub fn leave(handle: &tauri::AppHandle) {
    if let Some(w) = overlay(handle) {
        let _ = w.close();
    }
    if let Some(main) = handle.get_webview_window("main") {
        let _ = main.show();
        let _ = main.unminimize();
        let _ = main.set_focus();
    }
}

/// 双击图标:把软件叫回来,但**不退出 SKILL 模式** —— 那是 AI 面板里那个按钮的事。
/// 用户这时候看到的是一个锁着 AI 面板的正常界面,可以照常翻时间轴、看素材。
pub fn restore_window(handle: &tauri::AppHandle) {
    if let Some(w) = overlay(handle) {
        let _ = w.hide();
    }
    if let Some(main) = handle.get_webview_window("main") {
        let _ = main.show();
        let _ = main.unminimize();
        let _ = main.set_focus();
    }
}

/// SKILL 模式还开着,但用户把主窗关掉/最小化了 —— 缩回悬浮图标,别真退出。
pub fn back_to_overlay(handle: &tauri::AppHandle) {
    if let Some(main) = handle.get_webview_window("main") {
        let _ = main.hide();
    }
    if let Some(w) = overlay(handle) {
        let _ = w.show();
        place_top_right(&w);
    } else {
        enter(handle);
    }
}

/// 现在是不是 SKILL 模式。给 lib.rs 里「关窗要不要拦」用。
pub fn is_active(flag: &Arc<AtomicBool>) -> bool {
    flag.load(Ordering::SeqCst)
}

/// 起一个后台线程盯住状态文件,顺带把进度推给悬浮图标。
///
/// 返回一个共享的开关,别处(比如关窗拦截)要判断当前模式时读它,不用再去读文件。
pub fn spawn_watcher(handle: tauri::AppHandle) -> Arc<AtomicBool> {
    let active = Arc::new(AtomicBool::new(false));
    let flag = active.clone();

    // 双击图标 → 叫回主窗。页面用 window.__TAURI__.event.emit 发过来
    let h = handle.clone();
    handle.listen_any("pc-skill-restore", move |_| restore_window(&h));

    std::thread::spawn(move || {
        let mut last_active = false;
        let mut last_info = String::new();
        loop {
            let (is_on, job_id, proc) = read_state();

            if is_on != last_active {
                last_active = is_on;
                flag.store(is_on, Ordering::SeqCst);
                if is_on {
                    enter(&handle);
                } else {
                    leave(&handle);
                }
                // 网页那边也想知道(AI 面板的锁其实自己在轮询,这条只是让它更跟手)
                let _ = handle.emit("pc-skill-mode-changed", is_on);
            }

            if is_on {
                let (clips, updated_at) = proc.as_ref().map(read_proc_progress).unwrap_or((None, None));
                let info = OverlayInfo { active: true, job_id, clips, updated_at };
                // 没变就不推:悬浮窗每秒重渲染一次纯属浪费,数字还会闪
                let digest = format!("{:?}|{:?}|{:?}", info.job_id, info.clips, info.updated_at);
                if digest != last_info {
                    last_info = digest;
                    let _ = handle.emit_to(OVERLAY_LABEL, "pc-skill-overlay", info);
                }
            } else {
                last_info.clear();
            }

            std::thread::sleep(Duration::from_millis(1000));
        }
    });

    active
}
