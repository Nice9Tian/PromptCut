//! 和收报告的 Worker 说话。全部走后台线程,结果用 channel 送回界面。
//!
//! 管理密钥只当查询参数用,不打进日志、不写进任何界面上的可复制文本 ——
//! 它是取全文的唯一凭据。

use serde::{Deserialize, Serialize};

/// 列表里的一条。字段跟 Worker 的 `/list` 对齐。
#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct Item {
    pub id: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub at: String,
    #[serde(default)]
    pub size: u64,
    #[serde(default)]
    pub ip: String,
}

#[derive(Debug, Deserialize)]
struct ListResp {
    #[serde(default)]
    keys: Vec<Item>,
    #[serde(default)]
    cursor: Option<String>,
}

/// 后台线程做完一件事之后送回来的东西
pub enum Msg {
    /// 列表刷新完:条目 + 下一页游标(没有就是列完了)
    Listed(Vec<Item>, Option<String>),
    /// 某一份的全文取回来了
    Body(String, String),
    /// 某一份删掉了
    Deleted(String),
    /// 出错了,一句人话
    Failed(String),
}

fn base(url: &str) -> String {
    url.trim().trim_end_matches('/').to_string()
}

/// 把 URL 里可能出现的特殊字符转义。密钥是 base64url,理论上不含它们,
/// 但用户可能自己换成别的串,别在这里出锅。
fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/// HTTP 出错时给一句能照着查的话,不要只丢一个状态码
fn explain(status: u16) -> String {
    match status {
        404 => "取不到(404)。多半是管理密钥不对 —— 密钥不对时服务端故意回 404,不告诉扫描的人这里有东西".into(),
        403 => "被拒(403)".into(),
        s => format!("HTTP {s}"),
    }
}

pub fn list(url: &str, key: &str, cursor: Option<String>) -> Result<(Vec<Item>, Option<String>), String> {
    let mut target = format!("{}/list?k={}", base(url), esc(key));
    if let Some(c) = cursor {
        target.push_str(&format!("&cursor={}", esc(&c)));
    }
    let mut res = ureq::get(&target).call().map_err(|e| match e {
        ureq::Error::StatusCode(s) => explain(s),
        other => format!("连不上:{other}"),
    })?;
    let parsed: ListResp = res.body_mut().read_json().map_err(|e| format!("返回的不是 JSON:{e}"))?;
    Ok((parsed.keys, parsed.cursor))
}

pub fn body(url: &str, key: &str, id: &str) -> Result<String, String> {
    let target = format!("{}/r/{}?k={}", base(url), esc(id), esc(key));
    let mut res = ureq::get(&target).call().map_err(|e| match e {
        ureq::Error::StatusCode(s) => explain(s),
        other => format!("连不上:{other}"),
    })?;
    res.body_mut().read_to_string().map_err(|e| format!("读不出来:{e}"))
}

pub fn delete(url: &str, key: &str, id: &str) -> Result<(), String> {
    let target = format!("{}/r/{}?k={}", base(url), esc(id), esc(key));
    ureq::delete(&target).call().map_err(|e| match e {
        ureq::Error::StatusCode(s) => explain(s),
        other => format!("连不上:{other}"),
    })?;
    Ok(())
}
