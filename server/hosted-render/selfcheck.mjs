/**
 * 托管方渲染服务的启动自检（契约 `docs/plan/hosted-render-contract.md` 第 7.3 节）。
 *
 * `runSelfcheck(config, deps)` 回 `{ ok, errors: [{ reason, detail }], warnings: [{ reason, detail }], info }`：
 * - `errors` 里有任何一项，管理进程以退出码 78 结束、不接活（`SELFCHECK_EXIT`）；每项各打一行 `selfcheck.error`；
 * - `warnings` 只告警、照常启动：`no-cgroup`（没有 systemd / cgroup v2：无 cgroup 上限，只靠进程内看护）、
 *   `no-h264`（ffmpeg 没有 H.264 编码器；轨道流第一版不开，所以只告警）、`no-sandbox`（Chrome 关着沙箱在跑，写明原因）。
 *
 * | `reason` | 查什么 |
 * |---|---|
 * | `node-version` | Node ≥ 22.18（`.ts` 靠类型剥离直接载入） |
 * | `service-key` | 私钥文件在、权限不宽于 0600、格式对 |
 * | `data-dir` | 数据目录可写（没有就建） |
 * | `no-chrome` / `chrome-launch` | 找得到并起得来 chrome-headless-shell（带 root / 容器下的沙箱判断） |
 * | `no-cjk-font` | 在刚起的 Chrome 里把「中」「国」各画一遍：没有中文字体时两个字都是同一个缺字方框，位图相同 |
 * | `no-ffmpeg` | `ffmpeg -version` 能跑 |
 *
 * 各项探测都能注入（`deps`），单测不起真 Chrome。真探测只用 Node 内置模块与仓库里的 puppeteer、`bakery/chrome.mjs`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readServiceKeyFile } from '../auth/service-identity.mjs';
import { cgroupSupport } from './limits.mjs';

/** 自检不过时管理进程的退出码（EX_CONFIG）；PM2 配置里写进 `stop_exit_codes`，不反复拉起 */
export const SELFCHECK_EXIT = 78;
export const MIN_NODE = [22, 18];

export function nodeVersionOk(version = process.versions.node, min = MIN_NODE) {
  const [major, minor] = String(version).split('.').map(Number);
  return major > min[0] || (major === min[0] && minor >= min[1]);
}

/** 目录可写：没有就建，试写一个文件再删。不行抛错 */
export function checkWritableDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const probe = path.join(dir, `.write-probe-${process.pid}-${Date.now().toString(36)}`);
  fs.writeFileSync(probe, 'ok');
  fs.unlinkSync(probe);
}

/** 真探测：ffmpeg 在不在、有没有 H.264 编码器 */
export function probeFfmpeg() {
  const v = spawnSync('ffmpeg', ['-hide_banner', '-version'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  if (v.error || v.status !== 0) return { ok: false, detail: String(v.error?.code ?? `exit-${v.status}`) };
  const enc = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  const h264 = enc.status === 0 && /\b(libx264|h264_\w+|libopenh264)\b/.test(enc.stdout);
  return { ok: true, h264, version: (/ffmpeg version (\S+)/.exec(v.stdout) ?? [])[1] ?? null };
}

/**
 * 真探测：起一次 chrome-headless-shell（与预渲染同一套启动参数），开一个空白页，查中文字体。
 * 回 `{ ok, stage?, detail?, version?, cjk?, noSandbox? }`；`stage` 是 `no-chrome`（找不到可执行文件）或 `chrome-launch`。
 */
export async function probeChrome() {
  const { chromeLaunchArgs, noSandboxReason } = await import('../bakery/chrome.mjs');
  const { default: puppeteer } = await import('puppeteer');
  let browser = null;
  try {
    browser = await puppeteer.launch({ headless: 'shell', protocolTimeout: 60_000, args: chromeLaunchArgs() });
  } catch (err) {
    const message = String(err?.message ?? err);
    const missing = /Could not find|not found|ENOENT|No such file/i.test(message);
    return { ok: false, stage: missing ? 'no-chrome' : 'chrome-launch', detail: message.split('\n')[0].slice(0, 300) };
  }
  try {
    const version = await browser.version();
    const page = await browser.newPage();
    await page.goto('about:blank');
    const cjk = await page.evaluate(() => {
      const draw = (ch) => {
        const c = document.createElement('canvas');
        c.width = 48; c.height = 48;
        const g = c.getContext('2d');
        g.font = '36px sans-serif';
        g.textBaseline = 'top';
        g.fillText(ch, 4, 4);
        return Array.from(g.getImageData(0, 0, 48, 48).data).join(',');
      };
      const a = draw('中');
      const b = draw('国');
      const blank = draw(' ');
      // 没有中文字体：两个字都画成同一个缺字方框（或什么都不画），位图相同
      return a !== b && a !== blank && b !== blank;
    });
    return { ok: true, version, cjk, noSandbox: noSandboxReason() };
  } catch (err) {
    return { ok: false, stage: 'chrome-launch', detail: String(err?.message ?? err).split('\n')[0].slice(0, 300) };
  } finally {
    try { await browser.close(); } catch { /* 已经没了 */ }
  }
}

/**
 * @param {{ secretsDir: string, dataDir: string }} config
 * @param {object} [deps] 注入各项探测（单测用）：`nodeVersion`、`readKey`、`checkDir`、`chrome`、`ffmpeg`、`cgroup`
 */
export async function runSelfcheck(config, deps = {}) {
  const errors = [];
  const warnings = [];
  const info = {};
  const fail = (reason, detail) => errors.push({ reason, detail: String(detail ?? '') });
  const warn = (reason, detail) => warnings.push({ reason, detail: String(detail ?? '') });

  const version = deps.nodeVersion ?? process.versions.node;
  info.node = version;
  if (!nodeVersionOk(version)) fail('node-version', `要 Node ≥ ${MIN_NODE.join('.')}，现在是 ${version}`);

  try {
    const key = (deps.readKey ?? readServiceKeyFile)(config.secretsDir);
    info.service = { service: key.service, kid: key.kid, instanceId: key.instanceId };
  } catch (err) {
    fail('service-key', err?.message ?? err);
  }

  try {
    (deps.checkDir ?? checkWritableDir)(config.dataDir);
  } catch (err) {
    fail('data-dir', `${config.dataDir}：${String(err?.code ?? err?.message ?? err)}`);
  }

  let chrome;
  try {
    chrome = await (deps.chrome ?? probeChrome)();
  } catch (err) {
    chrome = { ok: false, stage: 'chrome-launch', detail: String(err?.message ?? err) };
  }
  if (!chrome.ok) {
    fail(chrome.stage === 'no-chrome' ? 'no-chrome' : 'chrome-launch',
      `${chrome.detail ?? ''}${chrome.stage === 'no-chrome' ? '；在部署目录里跑 npx puppeteer browsers install chrome-headless-shell' : ''}`);
  } else {
    info.chrome = chrome.version ?? null;
    if (chrome.cjk !== true) fail('no-cjk-font', 'Chrome 里画不出中文（两个不同的汉字画出来一样）；装中文字体：apt-get install fonts-noto-cjk');
    if (chrome.noSandbox) warn('no-sandbox', `Chrome 关着沙箱在跑（原因：${chrome.noSandbox}）；推荐用专门的非 root 用户跑工作进程`);
  }

  let ffmpeg;
  try {
    ffmpeg = (deps.ffmpeg ?? probeFfmpeg)();
  } catch (err) {
    ffmpeg = { ok: false, detail: String(err?.message ?? err) };
  }
  if (!ffmpeg.ok) fail('no-ffmpeg', `ffmpeg 跑不起来（${ffmpeg.detail ?? ''}）；装：apt-get install ffmpeg`);
  else {
    info.ffmpeg = ffmpeg.version ?? null;
    if (ffmpeg.h264 !== true) warn('no-h264', 'ffmpeg 没有 H.264 编码器；轨道流任务接不了（第一版本来就不开）');
  }

  const cg = (deps.cgroup ?? cgroupSupport)();
  info.cgroup = cg.ok ? 'systemd-scope' : `none:${cg.reason}`;
  if (!cg.ok) warn('no-cgroup', `无 cgroup 上限（${cg.reason}），只靠进程内看护：并发上限、背压、内存看护照常生效`);

  return { ok: errors.length === 0, errors, warnings, info };
}
