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
/// 「上一步动作」预览块的高度:预览(232 宽按 16:9 是 130)+ 说明一行 + 内边距
const PREVIEW_BLOCK_H: f64 = 130.0 + 22.0;
/// 启动进度块的高度:四步 + 一行状态
const STEPS_BLOCK_H: f64 = 108.0;
const BLOCK_GAP: f64 = 8.0;
/// 启动完成之后进度块再留这么久才收起来,让用户看见「实例就绪」亮起来
const STEPS_LINGER: Duration = Duration::from_secs(4);

/// 悬浮窗高度 = 卡片 + 正在显示的块。位置不动(还是右上角),只往下长。
fn overlay_height(steps: bool, preview: bool) -> f64 {
    let mut h = OVERLAY_H;
    if steps {
        h += BLOCK_GAP + STEPS_BLOCK_H;
    }
    if preview {
        h += BLOCK_GAP + PREVIEW_BLOCK_H;
    }
    h
}

/// 启动进度:任务目录里 job.json 的 phase / launch。用户点「开始」的那一刻主窗就收成
/// 悬浮窗了,快照 → 起实例 → 拉桌面 app → 就绪这几步就在悬浮窗上走,
/// 不再是 Skill 对话框里的内容(见 src/editor/SkillDialog.tsx)。
#[derive(Serialize, Clone, Default, PartialEq)]
pub struct ProgressInfo {
    pub phase: Option<String>,
    pub error: Option<String>,
    pub launch_status: Option<String>,
    pub launch_detail: Option<String>,
    /// 启动流程走完了(成功或失败),悬浮页据此决定进度块要不要收
    pub done: bool,
    pub failed: bool,
}

/// 读任务目录(project.proc 所在目录)里的 job.json。读不到就 None:老任务、目录被删都算正常。
fn read_progress(proc: &PathBuf) -> Option<ProgressInfo> {
    let dir = proc.parent()?;
    let text = fs::read_to_string(dir.join("job.json")).ok()?;
    let v = serde_json::from_str::<serde_json::Value>(&text).ok()?;
    let str_of = |x: Option<&serde_json::Value>| x.and_then(|s| s.as_str()).map(str::to_string);
    let phase = str_of(v.get("phase"));
    let error = str_of(v.get("error"));
    let launch = v.get("launch");
    let launch_status = str_of(launch.and_then(|l| l.get("status")));
    let launch_detail = str_of(launch.and_then(|l| l.get("detail")));
    let failed = phase.as_deref() == Some("failed") || launch_status.as_deref() == Some("failed");
    let done = failed
        || phase.as_deref() == Some("stopped")
        || (phase.as_deref() == Some("ready") && launch_status.as_deref() != Some("launching"));
    Some(ProgressInfo { phase, error, launch_status, launch_detail, done, failed })
}

/// 悬浮窗下面那张预览图。agent 每做成一次时间轴动作,无头实例就把那一刻的画面渲染出来
/// 写到 skillRoot 下的 last-action.png / .json(见 server/vite-plugin-skill-state.ts),
/// 这里盯着 json 的修改时间,变了就把图读进来推给悬浮页。
#[derive(Serialize, Clone, Default)]
pub struct PreviewInfo {
    pub tool: Option<String>,
    pub clip_id: Option<String>,
    pub t: Option<f64>,
    pub at: Option<String>,
    /// data:image/png;base64,… 直接给 <img> 用
    pub data_url: Option<String>,
}

fn last_action_json() -> PathBuf {
    skill_root().join("last-action.json")
}

fn last_action_png() -> PathBuf {
    skill_root().join("last-action.png")
}

/// 读预览。返回 (json 的修改时间戳, 内容);读不到就 None —— 没预览是常态,不是错。
fn read_preview() -> Option<(u128, PreviewInfo)> {
    use base64::Engine;
    let meta = fs::metadata(last_action_json()).ok()?;
    let stamp = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis())?;
    let v = serde_json::from_str::<serde_json::Value>(&fs::read_to_string(last_action_json()).ok()?).ok()?;
    let png = fs::read(last_action_png()).ok()?;
    // 正在被写到一半的 png 会解不出来;Node 那边是先写临时文件再改名,所以读到的要么整要么没有
    if png.len() < 8 || &png[..8] != b"\x89PNG\r\n\x1a\n" {
        return None;
    }
    let data_url = format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&png)
    );
    Some((
        stamp,
        PreviewInfo {
            tool: v.get("tool").and_then(|x| x.as_str()).map(str::to_string),
            clip_id: v.get("clipId").and_then(|x| x.as_str()).map(str::to_string),
            t: v.get("t").and_then(|x| x.as_f64()),
            at: v.get("at").and_then(|x| x.as_str()).map(str::to_string),
            data_url: Some(data_url),
        },
    ))
}
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
        let mut last_preview: u128 = 0;
        let mut last_progress: Option<ProgressInfo> = None;
        // 进度块什么时候走完的:走完之后再留 STEPS_LINGER 才收
        let mut done_at: Option<std::time::Instant> = None;
        let mut steps_shown = false;
        let mut size_key = (false, false);
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
                // 启动进度:job.json 变了才推。走完之后再留几秒,然后把进度块收掉
                let progress = proc.as_ref().and_then(read_progress);
                if progress != last_progress {
                    if let Some(pg) = &progress {
                        if pg.done {
                            if done_at.is_none() {
                                done_at = Some(std::time::Instant::now());
                            }
                        } else {
                            done_at = None;
                        }
                        let _ = handle.emit_to(OVERLAY_LABEL, "pc-skill-progress", pg.clone());
                    }
                    last_progress = progress.clone();
                }
                let show_steps = match (&progress, done_at) {
                    (Some(_), None) => true,
                    (Some(_), Some(t)) => t.elapsed() < STEPS_LINGER,
                    (None, _) => false,
                };
                if show_steps != steps_shown {
                    steps_shown = show_steps;
                    let _ = handle.emit_to(OVERLAY_LABEL, "pc-skill-steps", show_steps);
                }
                // 「上一步动作」的预览图:json 的修改时间变了才读、才推
                if let Some((stamp, preview)) = read_preview() {
                    if stamp != last_preview {
                        last_preview = stamp;
                        let _ = handle.emit_to(OVERLAY_LABEL, "pc-skill-preview", preview);
                    }
                }
                // 窗口高度跟着正在显示的块走(位置不动,还是右上角)
                let key = (show_steps, last_preview != 0);
                if key != size_key {
                    size_key = key;
                    if let Some(w) = overlay(&handle) {
                        let _ = w.set_size(tauri::LogicalSize::new(OVERLAY_W, overlay_height(key.0, key.1)));
                    }
                }
            } else {
                last_info.clear();
                last_preview = 0;
                last_progress = None;
                done_at = None;
                steps_shown = false;
                size_key = (false, false);
            }

            std::thread::sleep(Duration::from_millis(1000));
        }
    });

    active
}
