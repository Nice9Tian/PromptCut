/**
 * CLI 一键安装。
 *
 * 用户不该为了用 AI 助手先去命令行装 CLI,所以设置对话框里「未安装」的那一项要能直接装。
 * 装法统一走 npm 全局安装:两个包名都对着 registry 查过
 * (@anthropic-ai/claude-code、@openai/codex 都能 npm view 到版本)。
 * Antigravity 的 agy 是跟 Antigravity 一起装的,没有 npm 包,所以这里没有它——
 * 对话框会显示「需要先装 Antigravity」而不是给一个点了会失败的按钮。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** 能一键装的 provider → npm 包名 */
const PLANS = {
  claude: { pkg: "@anthropic-ai/claude-code", label: "Claude Code" },
  codex: { pkg: "@openai/codex", label: "Codex" },
};

/** 装不了的那些,给一句人能看懂的话(对话框直接显示,而不是给个点了会失败的按钮) */
const MANUAL = {
  agy: "agy 随 Antigravity 一起安装,先装好 Antigravity 再回到这里。",
  api: "API 直连不需要装 CLI,填好密钥即可。",
};

export function installPlanFor(id) {
  const plan = PLANS[id];
  if (!plan) return null;
  return { id, ...plan, command: `npm i -g ${plan.pkg}` };
}

export function manualHintFor(id) {
  return MANUAL[id] || null;
}

/**
 * 找 npm(先看 PATH,再看 Node 的默认安装位置)。找不到返回 null。
 * Windows 上 where 会同时给出无扩展名的 bash 脚本和 npm.cmd,只有后者能被 cmd.exe 直接执行,
 * 所以要挑带 .cmd/.exe 的那条。
 */
export function findNpm() {
  const isWin = process.platform === "win32";
  try {
    const out = execFileSync(isWin ? "where" : "which", ["npm"], {
      encoding: "utf8",
      timeout: 3000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const hits = out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((f) => fs.existsSync(f));
    const runnable = isWin ? hits.find((f) => /\.(cmd|bat|exe)$/i.test(f)) : hits[0];
    if (runnable) return runnable;
  } catch {
    // 不在 PATH 上,往下试固定位置
  }
  const guesses = isWin
    ? [
        path.join(process.env.ProgramFiles || "C:\\Program Files", "nodejs", "npm.cmd"),
        path.join(process.env.APPDATA || "", "npm", "npm.cmd"),
      ]
    : ["/usr/local/bin/npm", "/usr/bin/npm"];
  for (const g of guesses) {
    if (g && fs.existsSync(g)) return g;
  }
  return null;
}
