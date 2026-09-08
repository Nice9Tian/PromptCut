// 发布版不带控制台窗口:双击 bat 只出图形界面
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! PromptCut · 诊断报告收件箱
//!
//! 用户在软件里点「提交」之后,报告落在 Cloudflare Worker 的 KV 里
//! (收报告那端的代码在 tools/report-worker/)。这个小程序把它们收回来:
//! 列清单、看全文、存成文件、删掉。
//!
//! 和 api-share-gui 一样做成独立小程序而不是做进 PromptCut ——
//! 拿着管理密钥能读所有人的报告,这不该是产品里人人可点的按钮。

mod net;

use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Arc;
use std::thread;

use eframe::egui;
use net::{Item, Msg};

/*
 * 一次刷新最多拉多少条。
 *
 * 不是「只要近期的」,是给失控情况留个刹车 —— 真堆到这个数,界面里
 * 一条条翻本来也没意义了,该去查是不是有人在灌数据。
 */
const MAX_ITEMS: usize = 5000;

fn main() -> eframe::Result {
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([1040.0, 720.0])
            .with_min_inner_size([720.0, 480.0])
            .with_title("PromptCut · 诊断报告收件箱"),
        ..Default::default()
    };
    eframe::run_native(
        "PromptCut · 诊断报告收件箱",
        options,
        Box::new(|cc| {
            install_cjk_font(&cc.egui_ctx);
            Ok(Box::new(App::new()))
        }),
    )
}

/// egui 自带字体没有汉字,不换字体界面上全是豆腐块。
/// 只挑 Windows 自带的 TTF(ab_glyph 不认 .ttc 字体集合),一个都找不到就维持默认。
fn install_cjk_font(ctx: &egui::Context) {
    const CANDIDATES: [&str; 4] = [
        r"C:\Windows\Fonts\simhei.ttf",
        r"C:\Windows\Fonts\Deng.ttf",
        r"C:\Windows\Fonts\simkai.ttf",
        r"C:\Windows\Fonts\SimsunExtG.ttf",
    ];
    for path in CANDIDATES {
        let Ok(bytes) = std::fs::read(path) else { continue };
        let mut fonts = egui::FontDefinitions::default();
        fonts
            .font_data
            .insert("cjk".to_owned(), Arc::new(egui::FontData::from_owned(bytes)));
        for family in [egui::FontFamily::Proportional, egui::FontFamily::Monospace] {
            fonts.families.entry(family).or_default().insert(0, "cjk".to_owned());
        }
        ctx.set_fonts(fonts);
        return;
    }
}

/// 记住地址和密钥的地方。放 %LOCALAPPDATA%\promptcut\,和 ai.json 一处。
fn settings_path() -> std::path::PathBuf {
    let root = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| ".".into());
    std::path::Path::new(&root).join("promptcut").join("report-inbox.json")
}

/*
 * 仓库里的本机常量:`tools/report-inbox-gui/inbox.local.json`(已被 .gitignore 忽略,
 * 样例见同目录 `inbox.local.example.json`)。
 *
 * 为什么要有它:原来地址和 ADMIN_KEY 只活在 %LOCALAPPDATA% 那份 report-inbox.json 里 ——
 * 那是**界面自己写的缓存**,换台机器、重装、或者清一次 LOCALAPPDATA 就没了,
 * 打开收件箱是两个空框,不填就一条都看不到。仓库里放一份常量文件,克隆下来填一次,
 * 之后开箱即用。
 *
 * 找的顺序:环境变量指定的路径 → 编译时的 crate 目录(就是仓库里那份) → exe 旁边
 * (把 exe 单独拷去别处时用)。谁先命中用谁。
 */
fn local_config_paths() -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    if let Ok(p) = std::env::var("PROMPTCUT_REPORT_INBOX_CONFIG") {
        if !p.trim().is_empty() {
            out.push(std::path::PathBuf::from(p));
        }
    }
    out.push(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("inbox.local.json"));
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            out.push(dir.join("inbox.local.json"));
        }
    }
    out
}

/// 读仓库里那份常量。读不到、或者 JSON 坏了,就当没有 —— 界面还能手填,不该为此打不开。
fn load_local_config() -> Option<Settings> {
    for path in local_config_paths() {
        let Ok(text) = std::fs::read_to_string(&path) else { continue };
        match serde_json::from_str::<Settings>(&text) {
            Ok(cfg) if !cfg.url.trim().is_empty() || !cfg.key.trim().is_empty() => return Some(cfg),
            _ => continue,
        }
    }
    None
}

/// 存报告的地方。每次存都开在资源管理器里,省得用户自己找。
fn save_dir() -> std::path::PathBuf {
    let root = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| ".".into());
    std::path::Path::new(&root).join("promptcut").join("诊断报告收件箱")
}

#[derive(serde::Serialize, serde::Deserialize, Default)]
struct Settings {
    #[serde(default)]
    url: String,
    #[serde(default)]
    key: String,
}

struct App {
    url: String,
    key: String,
    /// 密钥默认打码显示。它能读所有人的报告,不该一直明晃晃摆在屏幕上
    show_key: bool,
    remember: bool,
    /// 启动时自动刷一次。第一帧才有 egui 的 ctx,所以只能在 ui() 里做,这里记个标记
    auto_refresh: bool,

    items: Vec<Item>,
    cursor: Option<String>,
    filter: String,
    selected: Option<String>,
    body: String,

    busy: bool,
    status: String,
    tx: Sender<Msg>,
    rx: Receiver<Msg>,
}

impl App {
    fn new() -> Self {
        let saved: Settings = std::fs::read_to_string(settings_path())
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        /*
         * 仓库里那份常量优先,**逐字段**优先:它写了地址就用它的地址,没写的字段
         * 才回落到界面上次记住的值。这样改常量文件立刻生效,不会被一份过期的缓存盖住;
         * 而常量文件里故意留空的字段(比如不想把 ADMIN_KEY 写进文件)也不会把已有的值抹掉。
         */
        let local = load_local_config().unwrap_or_default();
        let pick = |from_file: String, cached: String| {
            if from_file.trim().is_empty() { cached } else { from_file.trim().to_string() }
        };
        let url = pick(local.url, saved.url);
        let key = pick(local.key, saved.key);
        let remember = !key.is_empty();
        let (tx, rx) = channel();
        Self {
            // 两栏都齐了就自己拉一次:开箱第一眼该是报告列表,不是一个要人点「刷新」的空界面
            auto_refresh: !url.trim().is_empty() && !key.trim().is_empty(),
            url,
            key,
            show_key: false,
            remember,
            items: Vec::new(),
            cursor: None,
            filter: String::new(),
            selected: None,
            body: String::new(),
            busy: false,
            status: String::new(),
            tx,
            rx,
        }
    }

    fn save_settings(&self) {
        let path = settings_path();
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        // 不勾「记住密钥」就只存地址,密钥留空
        let data = Settings {
            url: self.url.clone(),
            key: if self.remember { self.key.clone() } else { String::new() },
        };
        let _ = std::fs::write(&path, serde_json::to_string_pretty(&data).unwrap_or_default());
    }

    /// 起一个后台线程干活,干完把结果丢进 channel 并请界面重画。
    /// 不能在 ui() 里直接发请求 —— 那会把整个窗口卡住。
    fn spawn<F>(&mut self, ctx: &egui::Context, work: F)
    where
        F: FnOnce() -> Msg + Send + 'static,
    {
        self.busy = true;
        let tx = self.tx.clone();
        let ctx = ctx.clone();
        thread::spawn(move || {
            let msg = work();
            let _ = tx.send(msg);
            ctx.request_repaint();
        });
    }

    fn refresh(&mut self, ctx: &egui::Context, more: bool) {
        if self.url.trim().is_empty() || self.key.trim().is_empty() {
            self.status = "先把服务地址和管理密钥填上".into();
            return;
        }
        let (url, key) = (self.url.clone(), self.key.clone());
        let cursor = if more { self.cursor.clone() } else { None };
        if !more {
            self.items.clear();
            self.cursor = None;
        }
        self.status = "正在拉取…".into();
        self.spawn(ctx, move || match net::list(&url, &key, cursor) {
            Ok((items, cursor)) => Msg::Listed(items, cursor),
            Err(e) => Msg::Failed(e),
        });
    }

    fn open(&mut self, ctx: &egui::Context, id: String) {
        self.selected = Some(id.clone());
        self.body.clear();
        let (url, key) = (self.url.clone(), self.key.clone());
        self.status = "正在取全文…".into();
        self.spawn(ctx, move || match net::body(&url, &key, &id) {
            Ok(text) => Msg::Body(id, text),
            Err(e) => Msg::Failed(e),
        });
    }

    fn delete(&mut self, ctx: &egui::Context, id: String) {
        let (url, key) = (self.url.clone(), self.key.clone());
        self.status = "正在删除…".into();
        self.spawn(ctx, move || match net::delete(&url, &key, &id) {
            Ok(()) => Msg::Deleted(id),
            Err(e) => Msg::Failed(e),
        });
    }

    /// 存成文件并打开所在文件夹。报告是 JSON,存成 .json 好用编辑器折叠着看。
    fn save_to_file(&mut self) {
        let Some(id) = self.selected.clone() else { return };
        if self.body.is_empty() {
            self.status = "还没取到全文".into();
            return;
        }
        let dir = save_dir();
        if let Err(e) = std::fs::create_dir_all(&dir) {
            self.status = format!("建目录失败:{e}");
            return;
        }
        let file = dir.join(format!("{id}.json"));
        // 带 BOM:Windows 记事本没有它会把中文按 ANSI 读成乱码
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(self.body.as_bytes());
        match std::fs::write(&file, bytes) {
            Ok(()) => {
                self.status = format!("已存到 {}", file.display());
                let _ = std::process::Command::new("explorer.exe").arg(&dir).spawn();
            }
            Err(e) => self.status = format!("写文件失败:{e}"),
        }
    }

    fn drain(&mut self, ctx: &egui::Context) {
        while let Ok(msg) = self.rx.try_recv() {
            self.busy = false;
            match msg {
                Msg::Listed(items, cursor) => {
                    self.items.extend(items);
                    self.cursor = cursor;
                    /*
                     * 没翻完就自己接着翻。
                     *
                     * 原来这里停下来等用户点「加载更多」,等于默认只给最近一页 ——
                     * 「只有近期的报告有用」不该由界面替人决定。一次拉全,
                     * 边拉边显示,用户不用管有几页。
                     */
                    if self.cursor.is_some() && self.items.len() < MAX_ITEMS {
                        self.status = format!("已拿到 {} 条,继续…", self.items.len());
                        self.refresh(ctx, true);
                    } else if self.cursor.is_some() {
                        self.status = format!(
                            "已拿到 {} 条,到了本次上限 {MAX_ITEMS} 条。删掉一些或者提高 MAX_ITEMS",
                            self.items.len()
                        );
                    } else {
                        self.status = format!("共 {} 条,全部拉完", self.items.len());
                    }
                }
                Msg::Body(id, text) => {
                    // 取的过程中用户可能已经点了别的,别把内容贴错行
                    if self.selected.as_deref() == Some(id.as_str()) {
                        self.body = text;
                        self.status = format!("{} 字符", self.body.chars().count());
                    }
                }
                Msg::Deleted(id) => {
                    self.items.retain(|x| x.id != id);
                    if self.selected.as_deref() == Some(id.as_str()) {
                        self.selected = None;
                        self.body.clear();
                    }
                    self.status = "已删除".into();
                }
                Msg::Failed(why) => self.status = why,
            }
        }
    }
}

impl eframe::App for App {
    // eframe 0.36 起 App 直接拿到 Ui,中央面板由框架给好,不用自己开 CentralPanel
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        self.drain(&ui.ctx().clone());
        let ctx = ui.ctx().clone();

        if self.auto_refresh {
            self.auto_refresh = false;
            self.refresh(&ctx, false);
        }

        // ---- 顶上:连哪儿、拿什么钥匙 ----
        ui.horizontal(|ui| {
            ui.label("服务地址");
            ui.add(
                egui::TextEdit::singleline(&mut self.url)
                    .desired_width(300.0)
                    .hint_text("https://promptcut-reports.xxx.workers.dev"),
            );
            ui.label("管理密钥");
            ui.add(
                egui::TextEdit::singleline(&mut self.key)
                    .desired_width(220.0)
                    .password(!self.show_key),
            );
            ui.checkbox(&mut self.show_key, "显示");
            if ui.checkbox(&mut self.remember, "记住").changed() {
                self.save_settings();
            }
            if ui.add_enabled(!self.busy, egui::Button::new("刷新")).clicked() {
                self.save_settings();
                self.refresh(&ctx, false);
            }
        });

        ui.horizontal(|ui| {
            ui.label("筛选");
            ui.add(
                egui::TextEdit::singleline(&mut self.filter)
                    .desired_width(240.0)
                    .hint_text("按标签或 id"),
            );
            if !self.status.is_empty() {
                ui.separator();
                ui.label(&self.status);
            }
        });
        ui.separator();

        // ---- 左清单 / 右正文 ----
        let filter = self.filter.trim().to_lowercase();
        let visible: Vec<Item> = self
            .items
            .iter()
            .filter(|x| {
                filter.is_empty()
                    || x.label.to_lowercase().contains(&filter)
                    || x.id.to_lowercase().contains(&filter)
            })
            .cloned()
            .collect();

        let mut open_id: Option<String> = None;
        let mut delete_id: Option<String> = None;

        ui.columns(2, |cols| {
            // 左:清单
            egui::ScrollArea::vertical()
                .id_salt("list")
                .auto_shrink([false, false])
                .show(&mut cols[0], |ui| {
                    /*
                     * 空清单分三种,得说清楚是哪一种。
                     * 原来一律说「填好上面两栏点刷新」—— 两栏明明填好了、也刷过了、
                     * 服务端就是一条都没有的时候,这句话把人往错的方向带。
                     */
                    if visible.is_empty() {
                        if !filter.is_empty() {
                            ui.weak("没有匹配「筛选」的报告。清空筛选看全部。");
                        } else if self.items.is_empty() && !self.status.is_empty() && !self.busy {
                            ui.weak("服务端一条报告也没有。等有人在软件里点「提交」之后再刷新。");
                        } else if self.url.trim().is_empty() || self.key.trim().is_empty() {
                            ui.weak("还没有报告。填好上面两栏点「刷新」。");
                        }
                    }
                    for item in &visible {
                        let picked = self.selected.as_deref() == Some(item.id.as_str());
                        let title = format!(
                            "{}  ·  {}KB\n{}  ·  {}",
                            if item.label.is_empty() { "诊断报告" } else { &item.label },
                            (item.size as f64 / 1024.0).round() as u64,
                            item.at.replace('T', " ").split('.').next().unwrap_or(&item.at),
                            item.id,
                        );
                        if ui.selectable_label(picked, title).clicked() {
                            open_id = Some(item.id.clone());
                        }
                    }
                    if self.busy && self.cursor.is_some() {
                        ui.weak("还在拉后面几页…");
                    }
                });

            // 右:正文
            let right = &mut cols[1];
            right.horizontal(|ui| {
                let has = self.selected.is_some() && !self.body.is_empty();
                if ui.add_enabled(has, egui::Button::new("保存为文件")).clicked() {
                    ui.data_mut(|d| d.insert_temp("save".into(), true));
                }
                if ui.add_enabled(has, egui::Button::new("复制")).clicked() {
                    ui.ctx().copy_text(self.body.clone());
                }
                if ui
                    .add_enabled(self.selected.is_some() && !self.busy, egui::Button::new("删除"))
                    .clicked()
                {
                    delete_id = self.selected.clone();
                }
            });
            right.separator();
            egui::ScrollArea::both()
                .id_salt("body")
                .auto_shrink([false, false])
                .show(right, |ui| {
                    if self.body.is_empty() {
                        ui.weak("左边点一条看全文。");
                    } else {
                        // 只读多行框:能选中、能滚,但改不了
                        ui.add(
                            egui::TextEdit::multiline(&mut self.body.as_str())
                                .font(egui::TextStyle::Monospace)
                                .desired_width(f32::INFINITY)
                                .code_editor(),
                        );
                    }
                });
        });

        // 上面借用结束了,这里才动 self

        if ctx.data_mut(|d| d.remove_temp::<bool>("save".into()).is_some()) {
            self.save_to_file();
        }
        if let Some(id) = open_id {
            self.open(&ctx, id);
        }
        if let Some(id) = delete_id {
            self.delete(&ctx, id);
        }
    }
}
