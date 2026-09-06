use std::collections::HashMap;
use std::env;
use std::fs;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Deserialize;
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::webview::WebviewWindowBuilder;
use tauri::{Manager, RunEvent, WebviewUrl};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::ShellExt;

const EDITOR_URL: &str = "http://127.0.0.1:5210/";

/// Holds the sidecar process ID so we can kill the whole tree on exit.
struct SidecarPid(Mutex<Option<u32>>);

/// Build a JS snippet that writes `message` into `#status`, polling until
/// the DOM element exists (the sidecar may crash before the wait page finishes
/// parsing, so `getElementById` could return null on the first attempt).
fn status_eval_script(message: &str) -> String {
    let literal =
        serde_json::to_string(message).unwrap_or_else(|_| "\"(internal error)\"".to_string());
    format!(
        "(function(){{var m={};function w(){{var e=document.getElementById('status');\
         if(e){{e.innerText=m;}}else{{setTimeout(w,100);}}}}w();}})()",
        literal
    )
}

/// Try a raw HTTP GET to `127.0.0.1:5210` and return the response body
/// (up to 64 KiB) if the connection succeeds within `timeout`.
fn probe_port(timeout: Duration) -> Result<String, String> {
    let mut stream =
        TcpStream::connect_timeout(&"127.0.0.1:5210".parse().unwrap(), timeout)
            .map_err(|e| e.to_string())?;
    stream
        .set_read_timeout(Some(timeout))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(timeout))
        .map_err(|e| e.to_string())?;
    stream
        .write_all(b"GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; 65536];
    let mut total = 0usize;
    loop {
        match stream.read(&mut buf[total..]) {
            Ok(0) => break,
            Ok(n) => {
                total += n;
                if total >= buf.len() {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    Ok(String::from_utf8_lossy(&buf[..total]).to_string())
}

/// Resolve the runtime directory: honour `PROMPTCUT_RUNTIME_DIR` if set,
/// otherwise fall back to `<resource_dir>/runtime`.
fn resolve_runtime_dir(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(v) = env::var("PROMPTCUT_RUNTIME_DIR") {
        if !v.is_empty() {
            return PathBuf::from(v);
        }
    }
    app.path()
        .resource_dir()
        .expect("failed to resolve resource dir")
        .join("runtime")
}

/// VERSIONS.json schema (all fields optional for robustness).
#[derive(Deserialize, Default)]
#[serde(default)]
struct Versions {
    node: Option<String>,
    chrome: Option<String>,
    ffmpeg: Option<String>,
    python: Option<String>,
    app: Option<String>,
}

pub fn run() {
    let builder = tauri::Builder::default();

    // -- Plugins ----------------------------------------------------------
    let builder = builder
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Second instance: bring the existing window to front.
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init());

    // -- Setup ------------------------------------------------------------
    builder
        .setup(|app| {
            let handle = app.handle().clone();

            // ── Port check ──────────────────────────────────────────
            let mut existing_instance = false;
            if let Ok(body) = probe_port(Duration::from_secs(2)) {
                if body.contains("PromptCut") {
                    // Another PromptCut is already serving on 5210.
                    existing_instance = true;
                } else {
                    // Port is occupied by something else.
                    rfd::MessageDialog::new()
                        .set_title("PromptCut")
                        .set_description("端口被占用\n\n端口 5210 被别的程序占用，请关掉它再启动。")
                        .set_level(rfd::MessageLevel::Error)
                        .show();
                    std::process::exit(1);
                }
            }

            // ── Runtime directory ───────────────────────────────────
            let runtime_dir = resolve_runtime_dir(&handle);

            // ── App data / log directories ──────────────────────────
            let app_data_dir = handle
                .path()
                .app_data_dir()
                .expect("failed to resolve app data dir");
            let app_log_dir = handle
                .path()
                .app_log_dir()
                .expect("failed to resolve app log dir");
            let pylibs_dir = app_data_dir.join("pylibs");
            let models_dir = app_data_dir.join("models");
            let export_dir = dirs_home().join("Videos").join("PromptCut");

            for d in [&app_data_dir, &app_log_dir, &pylibs_dir, &models_dir, &export_dir] {
                let _ = fs::create_dir_all(d);
            }

            // ── Native menu ─────────────────────────────────────────
            let menu = build_menu(&handle)?;
            handle.set_menu(menu)?;

            let export_dir_c = export_dir.clone();
            let app_data_dir_c = app_data_dir.clone();
            let pylibs_dir_c = pylibs_dir.clone();
            let models_dir_c = models_dir.clone();
            let app_log_dir_c = app_log_dir.clone();
            let runtime_dir_c = runtime_dir.clone();
            let handle_menu = handle.clone();

            handle.on_menu_event(move |_app, event| {
                handle_menu_event(
                    &handle_menu,
                    event.id().as_ref(),
                    &export_dir_c,
                    &app_data_dir_c,
                    &pylibs_dir_c,
                    &models_dir_c,
                    &app_log_dir_c,
                    &runtime_dir_c,
                );
            });

            // ── Build the main window ───────────────────────────────
            let opener_handle = handle.clone();
            let opener_handle2 = handle.clone();
            let win = WebviewWindowBuilder::new(&handle, "main", WebviewUrl::App("index.html".into()))
                .title("PromptCut")
                .inner_size(1600.0, 960.0)
                .min_inner_size(1200.0, 720.0)
                .center()
                .maximizable(true)
                .on_navigation(move |url| {
                    let host = url.host_str().unwrap_or("");
                    if host == "127.0.0.1"
                        || host == "localhost"
                        || host.ends_with(".localhost")
                    {
                        return true;
                    }
                    let scheme = url.scheme();
                    if scheme == "http" || scheme == "https" {
                        let _ = opener_handle.opener().open_url(url.as_str(), None::<&str>);
                    }
                    false
                })
                .on_new_window(move |url, _features| {
                    let scheme = url.scheme();
                    if scheme == "http" || scheme == "https" {
                        let _ = opener_handle2.opener().open_url(url.as_str(), None::<&str>);
                    }
                    tauri::webview::NewWindowResponse::Deny
                })
                .build()?;

            // If there is already an instance running, just navigate to it.
            if existing_instance {
                let _ = win.navigate(EDITOR_URL.parse().unwrap());
                return Ok(());
            }

            // ── Environment variables ───────────────────────────────
            let mut envs: HashMap<String, String> = env::vars().collect();

            // Find the original PATH key (Windows uses "Path" with capital P).
            let path_key = envs
                .keys()
                .find(|k| k.eq_ignore_ascii_case("PATH"))
                .cloned()
                .unwrap_or_else(|| "Path".to_string());
            let original_path = envs.get(&path_key).cloned().unwrap_or_default();

            // Current exe directory (sidecar lives next to the main exe).
            let exe_dir = env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(|pp| pp.to_path_buf()))
                .unwrap_or_default();

            let new_path = format!(
                "{};{};{};{};{}",
                runtime_dir.join("ffmpeg").display(),
                runtime_dir.join("python").display(),
                runtime_dir.join("python").join("Scripts").display(),
                exe_dir.display(),
                original_path,
            );
            envs.insert(path_key, new_path);
            envs.insert("PUPPETEER_CACHE_DIR".into(), runtime_dir.join("chrome").to_string_lossy().into_owned());
            envs.insert("BROWSER".into(), "none".into());
            envs.insert("PROMPTCUT_EXPORT_DIR".into(), export_dir.to_string_lossy().into_owned());
            envs.insert("PROMPTCUT_PYTHON".into(), runtime_dir.join("python").join("python.exe").to_string_lossy().into_owned());
            envs.insert("PROMPTCUT_PYLIBS".into(), pylibs_dir.to_string_lossy().into_owned());
            envs.insert("PROMPTCUT_MODELS".into(), models_dir.to_string_lossy().into_owned());
            envs.insert("PROMPTCUT_DATA_DIR".into(), app_data_dir.to_string_lossy().into_owned());

            // ── Spawn sidecar ───────────────────────────────────────
            let app_dir = runtime_dir.join("app");
            let sidecar_cmd = handle.shell().sidecar("node").map_err(|e| {
                let msg = format!("无法创建 sidecar 命令: {e}");
                rfd::MessageDialog::new()
                    .set_title("PromptCut")
                    .set_description(&msg)
                    .set_level(rfd::MessageLevel::Error)
                    .show();
                tauri::Error::Anyhow(e.into())
            })?;

            let sidecar_cmd = sidecar_cmd
                .args([
                    "node_modules/vite/bin/vite.js",
                    "--port", "5210",
                    "--strictPort",
                    "--host", "127.0.0.1",
                ])
                .current_dir(app_dir)
                .env_clear()
                .envs(envs);

            let (mut rx, child) = sidecar_cmd.spawn().map_err(|e| {
                let msg = format!("无法启动 Node 进程: {e}");
                rfd::MessageDialog::new()
                    .set_title("PromptCut")
                    .set_description(&msg)
                    .set_level(rfd::MessageLevel::Error)
                    .show();
                tauri::Error::Anyhow(e.into())
            })?;

            // Store sidecar PID for cleanup.
            let pid = child.pid();
            handle.manage(SidecarPid(Mutex::new(Some(pid))));

            // ── Logging + terminated detection ──────────────────────
            let sidecar_dead = Arc::new(AtomicBool::new(false));
            let sidecar_dead_log = sidecar_dead.clone();
            let log_path = app_log_dir.join("sidecar.log");
            let log_path_str = log_path.to_string_lossy().to_string();
            let win_log = win.clone();

            tauri::async_runtime::spawn(async move {
                use tauri_plugin_shell::process::CommandEvent;
                let mut log_file = fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&log_path)
                    .ok();

                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(line) => {
                            if let Some(f) = log_file.as_mut() {
                                let text = String::from_utf8_lossy(&line);
                                let _ = writeln!(f, "{text}");
                            }
                        }
                        CommandEvent::Stderr(line) => {
                            if let Some(f) = log_file.as_mut() {
                                let text = String::from_utf8_lossy(&line);
                                let _ = writeln!(f, "[stderr] {text}");
                            }
                        }
                        CommandEvent::Terminated(payload) => {
                            sidecar_dead_log.store(true, Ordering::SeqCst);
                            let code_str = payload
                                .code
                                .map(|c| c.to_string())
                                .unwrap_or_else(|| "unknown".into());
                            let msg = format!(
                                "Node 已退出（code={}），请查看日志:\n{}",
                                code_str, log_path_str
                            );
                            if let Some(f) = log_file.as_mut() {
                                let _ = writeln!(f, "[terminated] code={code_str}");
                            }
                            let _ = win_log.eval(&status_eval_script(&msg));
                            break;
                        }
                        _ => {}
                    }
                }
            });

            // ── Ready polling ───────────────────────────────────────
            let sidecar_dead_poll = sidecar_dead.clone();
            let win_poll = win.clone();
            let log_path_poll = app_log_dir.join("sidecar.log");

            std::thread::spawn(move || {
                let start = std::time::Instant::now();
                loop {
                    if sidecar_dead_poll.load(Ordering::SeqCst) {
                        // Sidecar already exited; the Terminated handler wrote the message.
                        break;
                    }
                    if start.elapsed() > Duration::from_secs(90) {
                        let msg = format!(
                            "启动超时，请查看日志:\n{}",
                            log_path_poll.to_string_lossy()
                        );
                        let _ = win_poll.eval(&status_eval_script(&msg));
                        break;
                    }
                    if let Ok(body) = probe_port(Duration::from_secs(2)) {
                        if body.starts_with("HTTP/1.1 200") || body.starts_with("HTTP/1.0 200") {
                            let _ = win_poll.navigate(EDITOR_URL.parse().unwrap());
                            break;
                        }
                    }
                    std::thread::sleep(Duration::from_millis(250));
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build tauri application")
        .run(|handle, event| match event {
            RunEvent::ExitRequested { .. } | RunEvent::Exit => {
                kill_sidecar_tree(handle);
            }
            _ => {}
        });
}

// ── Helpers ─────────────────────────────────────────────────────────────

/// Home directory via %USERPROFILE%.
fn dirs_home() -> PathBuf {
    PathBuf::from(env::var("USERPROFILE").unwrap_or_else(|_| "C:\\Users\\Default".into()))
}

/// Kill the sidecar process tree with `taskkill /F /T /PID`.
/// CREATE_NO_WINDOW (0x08000000) prevents a console flash.
fn kill_sidecar_tree(handle: &tauri::AppHandle) {
    let pid = handle
        .try_state::<SidecarPid>()
        .and_then(|s| s.0.lock().ok().and_then(|g| *g));
    if let Some(pid) = pid {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            let _ = std::process::Command::new("taskkill")
                .args(["/F", "/T", "/PID", &pid.to_string()])
                .creation_flags(0x08000000) // CREATE_NO_WINDOW
                .status();
        }
        #[cfg(not(windows))]
        {
            let _ = std::process::Command::new("kill")
                .args(["-9", &pid.to_string()])
                .status();
        }
    }
}

/// Build the application menu bar.
fn build_menu(
    handle: &tauri::AppHandle,
) -> Result<tauri::menu::Menu<tauri::Wry>, tauri::Error> {
    let file_menu = SubmenuBuilder::with_id(handle, "file-menu", "文件")
        .item(&MenuItemBuilder::with_id("open-export", "打开导出文件夹").build(handle)?)
        .item(&MenuItemBuilder::with_id("open-data", "打开数据目录").build(handle)?)
        .separator()
        .item(&MenuItemBuilder::with_id("quit", "退出").build(handle)?)
        .build()?;

    let tools_menu = SubmenuBuilder::with_id(handle, "tools-menu", "工具")
        .item(&MenuItemBuilder::with_id("open-pylibs", "语音识别引擎（库目录）").build(handle)?)
        .item(&MenuItemBuilder::with_id("open-models", "语音模型目录").build(handle)?)
        .separator()
        .item(&MenuItemBuilder::with_id("reset-pylibs", "重置 Python 库").build(handle)?)
        .build()?;

    let help_menu = SubmenuBuilder::with_id(handle, "help-menu", "帮助")
        .item(&MenuItemBuilder::with_id("open-logs", "查看运行日志").build(handle)?)
        .item(&MenuItemBuilder::with_id("about", "关于").build(handle)?)
        .build()?;

    MenuBuilder::new(handle)
        .item(&file_menu)
        .item(&tools_menu)
        .item(&help_menu)
        .build()
}

/// Handle a menu item click.
fn handle_menu_event(
    handle: &tauri::AppHandle,
    id: &str,
    export_dir: &PathBuf,
    app_data_dir: &PathBuf,
    pylibs_dir: &PathBuf,
    models_dir: &PathBuf,
    app_log_dir: &PathBuf,
    runtime_dir: &PathBuf,
) {
    match id {
        "open-export" => open_in_explorer(export_dir),
        "open-data" => open_in_explorer(app_data_dir),
        "open-pylibs" => open_in_explorer(pylibs_dir),
        "open-models" => open_in_explorer(models_dir),
        "open-logs" => open_in_explorer(app_log_dir),
        "quit" => {
            kill_sidecar_tree(handle);
            handle.exit(0);
        }
        "reset-pylibs" => {
            let path_display = pylibs_dir.to_string_lossy().to_string();
            let confirm = rfd::MessageDialog::new()
                .set_title("PromptCut — 重置 Python 库")
                .set_description(&format!(
                    "会删除 {path_display}，下次转写时需要重新下载引擎，继续吗？"
                ))
                .set_level(rfd::MessageLevel::Warning)
                .set_buttons(rfd::MessageButtons::OkCancel)
                .show();
            if confirm == rfd::MessageDialogResult::Ok {
                match fs::remove_dir_all(pylibs_dir) {
                    Ok(_) => {
                        rfd::MessageDialog::new()
                            .set_title("PromptCut")
                            .set_description("已删除，下次使用语音识别时会重新下载")
                            .set_level(rfd::MessageLevel::Info)
                            .show();
                    }
                    Err(e) => {
                        rfd::MessageDialog::new()
                            .set_title("PromptCut — 删除失败")
                            .set_description(&format!("删除失败: {e}"))
                            .set_level(rfd::MessageLevel::Error)
                            .show();
                    }
                }
            }
        }
        "about" => {
            show_about(handle, runtime_dir);
        }
        _ => {}
    }
}

/// Open a directory in Windows Explorer, creating it first if needed.
fn open_in_explorer(dir: &PathBuf) {
    let _ = fs::create_dir_all(dir);
    let _ = std::process::Command::new("explorer.exe")
        .arg(dir.as_os_str())
        .spawn();
}

/// Show an About dialog with versions from VERSIONS.json.
fn show_about(handle: &tauri::AppHandle, runtime_dir: &PathBuf) {
    let pkg = handle.package_info();
    let shell_version = format!("{}", pkg.version);

    let versions_path = runtime_dir.join("VERSIONS.json");
    let v: Versions = fs::read_to_string(&versions_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();

    let unknown = "未知".to_string();
    let not_installed = "未安装".to_string();

    let app_ver = v.app.as_deref().unwrap_or(&unknown);
    let node_ver = v.node.as_deref().unwrap_or(&unknown);
    let chrome_ver = v.chrome.as_deref().unwrap_or(&unknown);
    let ffmpeg_ver = v.ffmpeg.as_deref().unwrap_or(&unknown);
    let python_ver = v.python.as_deref().unwrap_or(&not_installed);

    let text = format!(
        "PromptCut\n\n\
         壳版本: {shell_version}\n\
         应用: {app_ver}\n\
         Node: {node_ver}\n\
         Chrome: {chrome_ver}\n\
         FFmpeg: {ffmpeg_ver}\n\
         Python: {python_ver}"
    );

    rfd::MessageDialog::new()
        .set_title("关于 PromptCut")
        .set_description(&text)
        .set_level(rfd::MessageLevel::Info)
        .show();
}
