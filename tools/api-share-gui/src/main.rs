// 发布版不带控制台窗口:双击 bat 只出图形界面
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! PromptCut · 生成 API 分发密文
//!
//! 分发方在自己机器上用它:填好配置 + 对方的本机识别码,产出一段密文发过去。
//! 对方在 PromptCut 的「AI 设置 → API 直连 → 导入分发来的配置」里粘贴即可。
//!
//! 制作侧刻意只有这个独立小程序,不做进 PromptCut——谁能分发密钥不该是人人可点的按钮。

mod share;

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use eframe::egui;
use share::{SharedApiConfig, DEFAULT_ITERATIONS};

const VENDORS: [&str; 3] = ["anthropic", "openai", "gemini"];

fn main() -> eframe::Result {
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([760.0, 700.0])
            .with_min_inner_size([560.0, 480.0])
            .with_title("PromptCut · 生成 API 分发密文"),
        ..Default::default()
    };
    eframe::run_native(
        "PromptCut · 生成 API 分发密文",
        options,
        Box::new(|cc| {
            install_cjk_font(&cc.egui_ctx);
            Ok(Box::<App>::default())
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

#[derive(PartialEq)]
enum Tab {
    Make,
    Verify,
}

struct App {
    tab: Tab,
    // 生成
    code: String,
    vendor: usize,
    base_url: String,
    model: String,
    api_key: String,
    show_key: bool,
    note: String,
    days: String,
    max_tokens: String,
    blob: String,
    status: Result<String, String>,
    // 校验
    verify_code: String,
    verify_blob: String,
    verify_out: Result<String, String>,
}

impl Default for App {
    fn default() -> Self {
        Self {
            tab: Tab::Make,
            code: String::new(),
            vendor: 0,
            base_url: String::new(),
            model: String::new(),
            api_key: String::new(),
            show_key: false,
            note: String::new(),
            days: String::new(),
            max_tokens: String::new(),
            blob: String::new(),
            status: Ok(String::new()),
            verify_code: String::new(),
            verify_blob: String::new(),
            verify_out: Ok(String::new()),
        }
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 一行「标签 + 输入框」,标签宽度统一,右边填满
fn field(ui: &mut egui::Ui, label: &str, value: &mut String, hint: &str, password: bool) {
    ui.horizontal(|ui| {
        ui.add_sized([120.0, 20.0], egui::Label::new(label));
        ui.add_sized(
            [ui.available_width(), 24.0],
            egui::TextEdit::singleline(value).hint_text(hint).password(password),
        );
    });
}

impl App {
    fn generate(&mut self) {
        let days = self.days.trim();
        let expires_at = if days.is_empty() {
            None
        } else {
            match days.parse::<f64>() {
                Ok(d) if d > 0.0 => Some(now_ms() + (d * 86_400_000.0) as i64),
                _ => {
                    self.status = Err("有效期要填一个正数(天)".into());
                    return;
                }
            }
        };
        let max_tokens = match self.max_tokens.trim() {
            "" => None,
            other => match other.parse::<u32>() {
                Ok(v) if v > 0 => Some(v),
                _ => {
                    self.status = Err("maxTokens 要填正整数,或者留空".into());
                    return;
                }
            },
        };

        let config = SharedApiConfig {
            vendor: VENDORS[self.vendor].to_string(),
            base_url: self.base_url.trim().to_string(),
            model: self.model.trim().to_string(),
            api_key: self.api_key.trim().to_string(),
            max_tokens,
            note: Some(self.note.trim().to_string()).filter(|s| !s.is_empty()),
            expires_at,
        };

        match share::encrypt(&config, &self.code, DEFAULT_ITERATIONS) {
            Ok(blob) => {
                let len = blob.chars().count();
                self.blob = blob;
                self.status = Ok(format!("生成成功,共 {len} 个字符。识别码错一位就解不开,记得核对。"));
            }
            Err(e) => {
                self.blob.clear();
                self.status = Err(e);
            }
        }
    }

    fn verify(&mut self) {
        self.verify_out = match share::decrypt(&self.verify_blob, &self.verify_code) {
            Ok(cfg) => {
                let masked: String = cfg.api_key.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
                let mut lines = vec![
                    format!("厂商:{}", cfg.vendor),
                    format!("地址:{}", if cfg.base_url.is_empty() { "(默认)" } else { &cfg.base_url }),
                    format!("模型:{}", if cfg.model.is_empty() { "(未指定)" } else { &cfg.model }),
                    format!("Key :••••{masked}"),
                ];
                if let Some(m) = cfg.max_tokens {
                    lines.push(format!("maxTokens:{m}"));
                }
                if let Some(note) = &cfg.note {
                    lines.push(format!("留言:{note}"));
                }
                if let Some(exp) = cfg.expires_at {
                    let left = (exp - now_ms()) as f64 / 86_400_000.0;
                    lines.push(if left > 0.0 {
                        format!("有效期:还剩 {left:.1} 天")
                    } else {
                        "有效期:已过期,对方导入会被拒绝".to_string()
                    });
                }
                Ok(lines.join("\n"))
            }
            Err(e) => Err(e),
        };
    }
}

impl eframe::App for App {
    // eframe 0.36 起 App 直接拿到 Ui,中央面板由框架给好,不用自己开 CentralPanel
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        ui.horizontal(|ui| {
            ui.selectable_value(&mut self.tab, Tab::Make, "生成密文");
            ui.selectable_value(&mut self.tab, Tab::Verify, "校验密文");
        });
        ui.separator();
        match self.tab {
            Tab::Make => self.ui_make(ui),
            Tab::Verify => self.ui_verify(ui),
        }
    }
}

impl App {
    fn ui_make(&mut self, ui: &mut egui::Ui) {
        egui::ScrollArea::vertical().show(ui, |ui| {
            ui.add_space(4.0);
            ui.label("① 把对方发来的本机识别码填在这里");
            field(ui, "本机识别码", &mut self.code, "PCM-XXXXX-XXXXX-XXXXX-XXXXX", false);

            ui.add_space(10.0);
            ui.label("② 填要分发的 API 配置");
            ui.horizontal(|ui| {
                ui.add_sized([120.0, 20.0], egui::Label::new("厂商"));
                // 用下拉框而不是并排的三个可选标签:后者选中态和悬停态长得太像,
                // 一眼看不出当前选的是哪个;以后加厂商也不会把这一行撑长
                egui::ComboBox::from_id_salt("vendor")
                    .selected_text(VENDORS[self.vendor])
                    .show_ui(ui, |ui| {
                        for (i, name) in VENDORS.iter().enumerate() {
                            ui.selectable_value(&mut self.vendor, i, *name);
                        }
                    });
            });
            field(ui, "API 地址", &mut self.base_url, "留空用厂商默认", false);
            field(ui, "模型", &mut self.model, "gpt-4o / claude-sonnet-4-5 …", false);
            ui.horizontal(|ui| {
                ui.add_sized([120.0, 20.0], egui::Label::new("API Key"));
                ui.add_sized(
                    [ui.available_width() - 60.0, 24.0],
                    egui::TextEdit::singleline(&mut self.api_key)
                        .hint_text("要分发的 Key")
                        .password(!self.show_key),
                );
                ui.checkbox(&mut self.show_key, "显示");
            });

            ui.add_space(10.0);
            ui.label("③ 可选");
            field(ui, "留言", &mut self.note, "对方导入时会看到", false);
            field(ui, "有效期(天)", &mut self.days, "留空 = 不限期", false);
            field(ui, "maxTokens", &mut self.max_tokens, "留空 = 用对方的默认值", false);

            ui.add_space(12.0);
            ui.horizontal(|ui| {
                if ui.button("生成密文").clicked() {
                    self.generate();
                }
                if ui.button("清空").clicked() {
                    let code = std::mem::take(&mut self.code);
                    *self = App { code, ..Default::default() };
                }
                if !self.blob.is_empty() && ui.button("复制密文").clicked() {
                    ui.ctx().copy_text(self.blob.clone());
                }
            });

            match &self.status {
                Ok(msg) if !msg.is_empty() => {
                    ui.colored_label(egui::Color32::from_rgb(90, 190, 120), msg);
                }
                Err(e) => {
                    ui.colored_label(egui::Color32::from_rgb(220, 100, 100), e);
                }
                _ => {}
            }

            if !self.blob.is_empty() {
                ui.add_space(6.0);
                ui.label("把下面这一整段发给对方:");
                ui.add(
                    egui::TextEdit::multiline(&mut self.blob.as_str())
                        .desired_width(f32::INFINITY)
                        .desired_rows(6)
                        .font(egui::TextStyle::Monospace),
                );
            }

            ui.add_space(10.0);
            ui.separator();
            ui.small(
                "密文只有那台机器解得开,转发给别人没用;但接收方自己一定拿得到明文 Key\
                 ——他的软件要调 API。所以这是「绑定机器 + 传输不裸奔」,不是对接收方保密。",
            );
        });
    }

    fn ui_verify(&mut self, ui: &mut egui::Ui) {
        egui::ScrollArea::vertical().show(ui, |ui| {
            ui.add_space(4.0);
            ui.label("发出去之前自己验一遍:用同一个识别码把密文解开看看");
            field(ui, "本机识别码", &mut self.verify_code, "PCM-XXXXX-…", false);
            ui.label("密文");
            ui.add(
                egui::TextEdit::multiline(&mut self.verify_blob)
                    .desired_width(f32::INFINITY)
                    .desired_rows(5)
                    .hint_text("以 PCAI1. 开头")
                    .font(egui::TextStyle::Monospace),
            );
            ui.add_space(8.0);
            ui.horizontal(|ui| {
                if ui.button("解开看看").clicked() {
                    self.verify();
                }
                if ui.button("清空").clicked() {
                    self.verify_blob.clear();
                    self.verify_out = Ok(String::new());
                }
            });
            ui.add_space(6.0);
            match &self.verify_out {
                Ok(text) if !text.is_empty() => {
                    ui.group(|ui| {
                        ui.label(text);
                    });
                }
                Err(e) => {
                    ui.colored_label(egui::Color32::from_rgb(220, 100, 100), e);
                }
                _ => {}
            }
        });
    }
}
