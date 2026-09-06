//! 和 `src/ai/configShare.ts`、`tools/make-api-share.py` 同一套信封。
//!
//! 三份实现必须逐字节兼容,所以下面这些常量和归一化规则改一个就得三处一起改。
//! `tests` 里放了一条由 JS 那边生成的密文当基准,任何一方跑偏都会在 `cargo test` 里现形。

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::Sha256;

pub const PREFIX: &str = "PCAI1.";
const AAD: &[u8] = b"PromptCut-api-share-v1";
const SALT_BYTES: usize = 16;
const IV_BYTES: usize = 12;
const TAG_BYTES: usize = 16;
pub const DEFAULT_ITERATIONS: u32 = 600_000;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct SharedApiConfig {
    pub vendor: String,
    #[serde(rename = "baseUrl")]
    pub base_url: String,
    pub model: String,
    #[serde(rename = "apiKey")]
    pub api_key: String,
    #[serde(rename = "maxTokens", default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(rename = "expiresAt", default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
}

/// 口令归一化。必须和 configShare.ts 的 `normalizePassword` 一步不差。
///
/// 识别码是人从聊天窗口抄来的,所以对 PCM 开头的输入纠错;自定义口令原样使用,
/// 里面的大小写和符号都有意义。
pub fn normalize_password(raw: &str) -> String {
    let text = raw.trim();
    if !text.to_uppercase().starts_with("PCM") {
        return text.to_string();
    }
    let upper = text.to_uppercase();
    let body = upper.strip_prefix("PCM").unwrap_or(&upper);
    body.chars()
        .filter(|c| c.is_ascii_digit() || c.is_ascii_uppercase())
        .map(|c| match c {
            'O' => '0',
            'I' | 'L' => '1',
            'U' => 'V',
            other => other,
        })
        .collect()
}

fn derive_key(password: &str, salt: &[u8], iterations: u32) -> [u8; 32] {
    let mut key = [0u8; 32];
    pbkdf2::pbkdf2_hmac::<Sha256>(password.as_bytes(), salt, iterations, &mut key);
    key
}

fn random_bytes(out: &mut [u8]) {
    use aes_gcm::aead::rand_core::{OsRng, RngCore};
    OsRng.fill_bytes(out);
}

pub fn encrypt(config: &SharedApiConfig, password: &str, iterations: u32) -> Result<String, String> {
    let pass = normalize_password(password);
    if pass.is_empty() {
        return Err("请填加密口令(对方的本机识别码,或你们约定的口令)".into());
    }
    if config.api_key.trim().is_empty() {
        return Err("请填 API Key".into());
    }

    let mut salt = [0u8; SALT_BYTES];
    let mut iv = [0u8; IV_BYTES];
    random_bytes(&mut salt);
    random_bytes(&mut iv);

    let key = derive_key(&pass, &salt, iterations);
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
    let plaintext = serde_json::to_vec(config).map_err(|e| e.to_string())?;
    let body = cipher
        .encrypt(
            Nonce::from_slice(&iv),
            Payload { msg: &plaintext, aad: AAD },
        )
        .map_err(|_| "加密失败".to_string())?;

    // 轮数写进头里:以后调大默认值,老密文仍按自己那时的轮数解得开
    let mut blob = Vec::with_capacity(4 + SALT_BYTES + IV_BYTES + body.len());
    blob.extend_from_slice(&iterations.to_be_bytes());
    blob.extend_from_slice(&salt);
    blob.extend_from_slice(&iv);
    blob.extend_from_slice(&body);
    Ok(format!("{PREFIX}{}", URL_SAFE_NO_PAD.encode(&blob)))
}

pub fn decrypt(blob: &str, password: &str) -> Result<SharedApiConfig, String> {
    // 聊天软件会给长文本插换行和空格,先全去掉
    let text: String = blob.chars().filter(|c| !c.is_whitespace()).collect();
    let Some(payload) = text.strip_prefix(PREFIX) else {
        return Err("这段文本不是 PromptCut 的配置密文(应以 PCAI1. 开头)".into());
    };
    let raw = URL_SAFE_NO_PAD
        .decode(payload)
        .map_err(|_| "密文格式不对,可能没复制全".to_string())?;
    if raw.len() < 4 + SALT_BYTES + IV_BYTES + TAG_BYTES {
        return Err("密文被截断了,请让对方重发完整内容".into());
    }

    let iterations = u32::from_be_bytes([raw[0], raw[1], raw[2], raw[3]]);
    // 别拿密文里的轮数去跑一个能把界面卡死的数
    if !(10_000..=5_000_000).contains(&iterations) {
        return Err("密文头部异常,拒绝解析".into());
    }
    let salt = &raw[4..4 + SALT_BYTES];
    let iv = &raw[4 + SALT_BYTES..4 + SALT_BYTES + IV_BYTES];
    let body = &raw[4 + SALT_BYTES + IV_BYTES..];

    let key = derive_key(&normalize_password(password), salt, iterations);
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
    let plaintext = cipher
        .decrypt(Nonce::from_slice(iv), Payload { msg: body, aad: AAD })
        .map_err(|_| "解不开:口令(本机识别码)对不上,或者密文被改过".to_string())?;

    let parsed: SharedApiConfig = serde_json::from_slice(&plaintext)
        .map_err(|_| "密文解开了,但内容不是有效的配置".to_string())?;
    if parsed.api_key.is_empty() {
        return Err("密文解开了,但里面没有 API Key".into());
    }
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CODE: &str = "PCM-C3KK8-JF2R3-QKWC3-AAGNQ";
    const FAST: u32 = 20_000;

    fn sample() -> SharedApiConfig {
        SharedApiConfig {
            vendor: "openai".into(),
            base_url: "https://api.example.com/v1".into(),
            model: "gpt-4o".into(),
            api_key: "sk-test-ABC123456789xyz".into(),
            max_tokens: None,
            note: Some("给小王用".into()),
            expires_at: None,
        }
    }

    #[test]
    fn round_trip() {
        let blob = encrypt(&sample(), CODE, FAST).unwrap();
        assert!(blob.starts_with(PREFIX));
        assert_eq!(decrypt(&blob, CODE).unwrap(), sample());
    }

    #[test]
    fn no_plaintext_key_in_blob() {
        let blob = encrypt(&sample(), CODE, FAST).unwrap();
        assert!(!blob.contains("sk-test"));
        assert!(!blob.contains("api.example.com"));
    }

    #[test]
    fn each_run_differs() {
        assert_ne!(
            encrypt(&sample(), CODE, FAST).unwrap(),
            encrypt(&sample(), CODE, FAST).unwrap()
        );
    }

    #[test]
    fn wrong_password_fails() {
        let blob = encrypt(&sample(), CODE, FAST).unwrap();
        assert!(decrypt(&blob, "PCM-00000-00000-00000-00000").is_err());
    }

    #[test]
    fn sloppy_codes_still_work() {
        let blob = encrypt(&sample(), CODE, FAST).unwrap();
        for variant in [
            CODE.to_lowercase(),
            CODE.replace('-', ""),
            CODE.replace('0', "O"),
            format!("  {CODE}  "),
        ] {
            assert!(decrypt(&blob, &variant).is_ok(), "解不开:{variant}");
        }
    }

    #[test]
    fn whitespace_from_chat_apps_is_ignored() {
        let blob = encrypt(&sample(), CODE, FAST).unwrap();
        let wrapped: String = blob
            .as_bytes()
            .chunks(40)
            .map(|c| format!("{}\n", std::str::from_utf8(c).unwrap()))
            .collect();
        assert_eq!(decrypt(&wrapped, CODE).unwrap(), sample());
    }

    #[test]
    fn tampering_is_caught() {
        let blob = encrypt(&sample(), CODE, FAST).unwrap();
        let mut bytes = blob.into_bytes();
        let last = bytes.len() - 3;
        bytes[last] = if bytes[last] == b'A' { b'B' } else { b'A' };
        assert!(decrypt(&String::from_utf8(bytes).unwrap(), CODE).is_err());
    }

    #[test]
    fn truncated_says_so() {
        let blob = encrypt(&sample(), CODE, FAST).unwrap();
        let err = decrypt(&blob[..30], CODE).unwrap_err();
        assert!(err.contains("截断"), "{err}");
    }

    #[test]
    fn non_blob_is_rejected() {
        assert!(decrypt("这是一段普通文本", CODE).is_err());
    }

    #[test]
    fn empty_inputs_are_caught() {
        let mut cfg = sample();
        cfg.api_key = String::new();
        assert!(encrypt(&cfg, CODE, FAST).is_err());
        assert!(encrypt(&sample(), "", FAST).is_err());
    }

    #[test]
    fn absurd_iteration_count_is_refused() {
        let blob = encrypt(&sample(), CODE, FAST).unwrap();
        let mut raw = URL_SAFE_NO_PAD.decode(&blob[PREFIX.len()..]).unwrap();
        raw[..4].copy_from_slice(&2_000_000_000u32.to_be_bytes());
        let evil = format!("{PREFIX}{}", URL_SAFE_NO_PAD.encode(&raw));
        assert!(decrypt(&evil, CODE).unwrap_err().contains("头部异常"));
    }

    /// 基准密文:由 src/ai/configShare.ts 生成。这条过不了,就说明三份实现跑偏了。
    #[test]
    fn decrypts_blob_made_by_the_typescript_side() {
        const FROM_JS: &str = "PCAI1.AABOIG47vZ1SBN5tqedIRq251y5sP9VNFy4KEQxL44s-6JIpvYxC2g5PXjImKFJNEedRVQ5rua1o4_AqXZVTlrlCKYosGs4mLR81kPohqxW7bFXQ2vq3NtL-qN-w860YAhLnaEWP4BSzeDxME91xc1zPsokSq0adM3ebiiYrC1hFIRQGq01nQLNeG1wN3Env2Oc2On0sVSBq";
        let got = decrypt(FROM_JS, CODE).expect("解不开 TS 侧生成的密文");
        assert_eq!(got.vendor, "gemini");
        assert_eq!(got.model, "gemini-2.0-flash");
        assert_eq!(got.api_key, "sk-JS-SIDE-1234");
        assert_eq!(got.note.as_deref(), Some("来自 JS"));
    }

    /// 反向互通用的夹具:按需跑,把 Rust 这边生成的密文打出来喂给 JS / Python 解。
    /// `cargo test --release -- --ignored --nocapture`
    #[test]
    #[ignore = "夹具:只在核对三份实现是否互通时手动跑"]
    fn emit_blob_for_cross_check() {
        let mut cfg = sample();
        cfg.vendor = "anthropic".into();
        cfg.api_key = "sk-RUST-SIDE-4242".into();
        cfg.note = Some("来自 Rust".into());
        cfg.max_tokens = Some(4096);
        println!("RUSTBLOB={}", encrypt(&cfg, CODE, FAST).unwrap());
    }

    #[test]
    fn normalize_matches_the_other_implementations() {
        assert_eq!(normalize_password("PCM-C3KK8-JF2R3-QKWC3-AAGNQ"), "C3KK8JF2R3QKWC3AAGNQ");
        assert_eq!(normalize_password("pcm c3kk8 jf2r3 qkwc3 aagnq"), "C3KK8JF2R3QKWC3AAGNQ");
        // 自定义口令不动它
        assert_eq!(normalize_password("  hunter2!  "), "hunter2!");
    }
}
