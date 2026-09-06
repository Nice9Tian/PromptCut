#!/usr/bin/env python3
"""把一份 LLM API 配置加密成 PromptCut 能导入的密文。

分发方(你)在自己机器上跑这个脚本;接收方在 PromptCut 里
「AI 设置 → API 直连 → 导入分发来的配置」把密文粘进去就行。

用法
----
    # 全程交互(不想记参数就用这个)
    python tools/make-api-share.py

    # 给好参数,Key 仍然会单独问,不走命令行
    python tools/make-api-share.py --code PCM-XXXXX-XXXXX-XXXXX-XXXXX \
        --vendor openai --base-url https://api.example.com/v1 \
        --model gpt-4o --note "内部测试用" --days 30

    # 验证自己刚发出去的密文
    python tools/make-api-share.py --decrypt --code PCM-… --blob PCAI1.…

    # 自检:确认这台机器上的实现和 PromptCut 里的一致
    python tools/make-api-share.py --self-test

为什么没有 --key 参数
--------------------
命令行参数会进 shell 历史、也会出现在别人的 `ps` 输出里。Key 只从
交互式输入(不回显)、`--key-file` 或环境变量 `PROMPTCUT_API_KEY` 读。

这套东西能防什么
----------------
密文在邮件、聊天里传的时候是密的;转发给第三个人,他的机器码不同,解不开。
**不能**防接收方自己——他的软件必须拿到明文 Key 才能调 API。所以这是
「绑定到指定机器 + 传输途中不裸奔」,不是对接收方保密。真要控制用量,
还得靠 API 侧的配额和轮换。

依赖
----
    pip install cryptography
"""
from __future__ import annotations

import argparse
import base64
import getpass
import json
import os
import re
import secrets
import struct
import sys
import time

try:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
except ImportError:  # pragma: no cover - 只是给个人话的提示
    sys.exit("缺少依赖,请先运行:pip install cryptography")

# 下面这些常量必须和 src/ai/configShare.ts 完全一致,改一个就互相解不开了
PREFIX = "PCAI1."
AAD = b"PromptCut-api-share-v1"
SALT_BYTES = 16
IV_BYTES = 12
TAG_BYTES = 16
DEFAULT_ITERATIONS = 600_000
VENDORS = ("anthropic", "openai", "gemini")


def normalize_password(raw: str) -> str:
    """和 configShare.ts 的 normalizePassword 逐步对齐。

    识别码是人从聊天窗口抄的,所以对 PCM 开头的输入做纠错;
    自定义口令原样使用,里面的大小写和符号都有意义。
    """
    text = (raw or "").strip()
    if not text.upper().startswith("PCM"):
        return text
    text = text.upper()
    text = re.sub(r"^PCM", "", text, count=1)
    text = re.sub(r"[^0-9A-Z]", "", text)
    return text.replace("O", "0").replace("I", "1").replace("L", "1").replace("U", "V")


def b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def b64url_decode(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def derive_key(password: str, salt: bytes, iterations: int) -> bytes:
    import hashlib

    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations, dklen=32)


def encrypt(config: dict, password: str, iterations: int = DEFAULT_ITERATIONS) -> str:
    password = normalize_password(password)
    if not password:
        raise ValueError("口令是空的")
    if not config.get("apiKey"):
        raise ValueError("apiKey 是空的")

    salt = secrets.token_bytes(SALT_BYTES)
    iv = secrets.token_bytes(IV_BYTES)
    key = derive_key(password, salt, iterations)
    # JS 那边 JSON.stringify 不带空格,这里对齐(其实只要能 parse 就行)
    plaintext = json.dumps(config, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    cipher = AESGCM(key).encrypt(iv, plaintext, AAD)
    return PREFIX + b64url_encode(struct.pack(">I", iterations) + salt + iv + cipher)


def decrypt(blob: str, password: str) -> dict:
    text = re.sub(r"\s+", "", blob or "")
    if not text.startswith(PREFIX):
        raise ValueError("这段文本不是 PromptCut 的配置密文(应以 PCAI1. 开头)")
    raw = b64url_decode(text[len(PREFIX):])
    if len(raw) < 4 + SALT_BYTES + IV_BYTES + TAG_BYTES:
        raise ValueError("密文被截断了")

    (iterations,) = struct.unpack(">I", raw[:4])
    if not 10_000 <= iterations <= 5_000_000:
        raise ValueError("密文头部异常")
    salt = raw[4:4 + SALT_BYTES]
    iv = raw[4 + SALT_BYTES:4 + SALT_BYTES + IV_BYTES]
    cipher = raw[4 + SALT_BYTES + IV_BYTES:]

    key = derive_key(normalize_password(password), salt, iterations)
    try:
        plaintext = AESGCM(key).decrypt(iv, cipher, AAD)
    except Exception as exc:  # InvalidTag 之类
        raise ValueError("解不开:口令(本机识别码)对不上,或者密文被改过") from exc
    return json.loads(plaintext.decode("utf-8"))


def read_api_key(args) -> str:
    """Key 只从不进 shell 历史的地方读"""
    if args.key_file:
        with open(args.key_file, "r", encoding="utf-8") as fh:
            return fh.read().strip()
    from_env = os.environ.get("PROMPTCUT_API_KEY", "").strip()
    if from_env:
        return from_env
    return getpass.getpass("API Key(输入时不显示): ").strip()


def ask(prompt: str, current: str | None) -> str:
    if current:
        return current
    return input(prompt).strip()


def self_test() -> int:
    """跑一遍往返和边界,顺便证明和 configShare.ts 同一个格式"""
    code = "PCM-C3KK8-JF2R3-QKWC3-AAGNQ"
    config = {
        "vendor": "openai",
        "baseUrl": "https://api.example.com/v1",
        "model": "gpt-4o",
        "apiKey": "sk-test-ABC123456789xyz",
        "note": "自检",
    }
    fast = 20_000
    blob = encrypt(config, code, fast)
    checks = [
        ("往返一致", decrypt(blob, code) == config),
        ("密文里没有明文 Key", "sk-test" not in blob),
        ("大小写容错", decrypt(blob, code.lower()) == config),
        ("去掉分隔符容错", decrypt(blob, code.replace("-", "")) == config),
        ("形近字 O→0 容错", decrypt(blob, code.replace("0", "O")) == config),
        ("换行容错", decrypt(re.sub(r"(.{40})", r"\1\n", blob), code) == config),
        ("两次密文不同", encrypt(config, code, fast) != encrypt(config, code, fast)),
    ]
    for name, expect_fail in [("换口令解不开", "PCM-00000-00000-00000-00000"), ("篡改后解不开", None)]:
        target = blob if expect_fail else blob[:-6] + ("B" if blob[-6] == "A" else "A") + blob[-5:]
        try:
            decrypt(target, expect_fail or code)
            checks.append((name, False))
        except ValueError:
            checks.append((name, True))

    ok = True
    for name, passed in checks:
        print(f"  {'✔' if passed else '✘'} {name}")
        ok = ok and passed
    print("自检通过" if ok else "自检失败")
    return 0 if ok else 1


def main() -> int:
    parser = argparse.ArgumentParser(
        description="把 LLM API 配置加密成 PromptCut 能导入的密文",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--code", help="接收方的本机识别码 PCM-…,或你们约定的口令")
    parser.add_argument("--vendor", choices=VENDORS, help="厂商")
    parser.add_argument("--base-url", default=None, help="API 地址,留空用厂商默认")
    parser.add_argument("--model", default=None, help="模型名")
    parser.add_argument("--note", default="", help="给接收方的留言")
    parser.add_argument("--days", type=float, default=None, help="多少天后失效,不给就是不限期")
    parser.add_argument("--max-tokens", type=int, default=None, help="写进配置的 maxTokens")
    parser.add_argument("--key-file", default=None, help="从文件读 API Key")
    parser.add_argument("--iterations", type=int, default=DEFAULT_ITERATIONS, help="PBKDF2 轮数")
    parser.add_argument("--decrypt", action="store_true", help="反过来:解开一段密文看看内容")
    parser.add_argument("--blob", default=None, help="配合 --decrypt 使用")
    parser.add_argument("--self-test", action="store_true", help="自检加解密实现")
    args = parser.parse_args()

    if args.self_test:
        return self_test()

    try:
        if args.decrypt:
            code = ask("接收方的本机识别码 / 口令: ", args.code)
            blob = args.blob or input("密文: ").strip()
            config = decrypt(blob, code)
            shown = dict(config)
            if shown.get("apiKey"):
                shown["apiKey"] = "••••" + shown["apiKey"][-4:]
            print(json.dumps(shown, ensure_ascii=False, indent=2))
            return 0

        code = ask("接收方的本机识别码(PCM-…): ", args.code)
        vendor = args.vendor
        while vendor not in VENDORS:
            vendor = input(f"厂商 {'/'.join(VENDORS)}: ").strip()
        config = {
            "vendor": vendor,
            "baseUrl": ask("API 地址(可留空): ", args.base_url),
            "model": ask("模型名: ", args.model),
            "apiKey": read_api_key(args),
        }
        if args.max_tokens:
            config["maxTokens"] = args.max_tokens
        if args.note:
            config["note"] = args.note
        if args.days:
            config["expiresAt"] = int((time.time() + args.days * 86400) * 1000)

        blob = encrypt(config, code, args.iterations)
        print("\n把下面这一整段发给对方(他粘进 PromptCut 就能自动导入):\n")
        print(blob)
        print(f"\n共 {len(blob)} 个字符。识别码错一位就解不开,记得核对。")
        return 0
    except (ValueError, OSError) as exc:
        print(f"出错:{exc}", file=sys.stderr)
        return 1
    except (KeyboardInterrupt, EOFError):
        print("\n已取消", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
