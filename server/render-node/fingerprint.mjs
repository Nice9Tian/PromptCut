import { createHash } from 'node:crypto';

/**
 * 渲染节点的环境指纹与结果键(设计 2.1,契约 B.1)。
 *
 * 不同硬件上 Canvas / WebGL 的字体微调和抗锯齿有确定的像素差,不同环境渲出的连续帧
 * 拼在一起会闪。所以**不假设跨环境可以互相替用**:细任务的结果键 = 内容键 × 环境指纹。
 *
 *   envFingerprint = sha256(`${os}\n${gpuClass}\n${chromeMajor}`) 的前 16 位十六进制
 *   resultKey      = sha256(`${contentKey}\n${envFingerprint}`)     的 64 位十六进制
 *
 * 结果键和现有的共享键、本地档键、流键同形(64 位小写十六进制),路由正则不用改。
 * 节点启动时用 `describeEnvironment` 算一次,在 `node.hello` 里上报。
 *
 * 纯函数:不读环境变量、不做 I/O;缺项一律按空值计,不抛。
 */

const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * `process.platform`、已归一的名字或页面上报的平台串 → `windows` | `macos` | `linux` | `other`
 * (大小写不敏感)。
 *
 * 先精确匹配(`win32` / `windows`、`darwin` / `macos`、`linux`),再按前缀补三条(契约 F.2):
 * `win…` → windows、`mac…` → macos、`linux…` → linux。前缀是为了认得页面的
 * `navigator.platform`(`Win32`、`MacIntel`、`Linux x86_64`)和 `userAgentData.platform`
 * (`Windows`、`macOS`、`Linux`),这样页面和本机预渲染进程在同一台机器上算出同一个 `os`。
 */
export function normalizeOs(platform) {
  const name = String(platform ?? '').trim().toLowerCase();
  if (name === 'win32' || name === 'windows') return 'windows';
  if (name === 'darwin' || name === 'macos') return 'macos';
  if (name === 'linux') return 'linux';
  if (name.startsWith('win')) return 'windows';
  if (name.startsWith('mac')) return 'macos';
  if (name.startsWith('linux')) return 'linux';
  return 'other';
}

/*
 * GPU 基础类别的匹配表,**顺序即优先级**:软件栅格化最先(ANGLE 的 SwiftShader
 * 串里也会带厂商名),认不出的最后一律当 `software` —— 保守:没有硬件加速。
 * `ati ` 带空格,免得误中 `corporation` 之类的词。
 */
const GPU_RULES = [
  ['software', ['swiftshader', 'llvmpipe', 'software', 'microsoft basic render']],
  ['nvidia', ['nvidia', 'geforce', 'quadro', 'rtx']],
  ['amd', ['amd', 'radeon', 'ati ']],
  ['intel', ['intel']],
  ['apple', ['apple']],
];

/**
 * WebGL 的 UNMASKED_RENDERER / UNMASKED_VENDOR → `nvidia` | `amd` | `intel` | `apple` | `software`。
 * 两个串用一个空格拼起来一起匹配,大小写不敏感。
 */
export function gpuClassOf(renderer, vendor) {
  const text = `${renderer ?? ''} ${vendor ?? ''}`.toLowerCase();
  for (const [gpuClass, needles] of GPU_RULES) {
    if (needles.some(needle => text.includes(needle))) return gpuClass;
  }
  return 'software';
}

/**
 * Chrome 主版本:`'138.0.7204.49'`、`'HeadlessChrome/138.0…'`、完整 UA、`138` → 138;
 * 解析不出 → 0。串里有 `Chrome/` / `Chromium/` 就取它后面的数(完整 UA 开头是 `Mozilla/5.0`,
 * 不能取第一个数),否则取第一个数。
 */
export function chromeMajorOf(version) {
  if (typeof version === 'number') return Number.isFinite(version) && version > 0 ? Math.floor(version) : 0;
  const text = String(version ?? '');
  const match = /(?:chrome|chromium)\/(\d+)/i.exec(text) ?? /(\d+)/.exec(text);
  if (!match) return 0;
  const major = Number(match[1]);
  return Number.isSafeInteger(major) ? major : 0;
}

/** 环境指纹:16 位小写十六进制。三项任一缺失按 `''` / `0` 计。 */
export function envFingerprintOf({ os, gpuClass, chromeMajor } = {}) {
  return sha256(`${os ?? ''}\n${gpuClass ?? ''}\n${chromeMajor ?? 0}`).slice(0, 16);
}

/** 从原始探测值一次算齐:`{ os, gpuClass, chromeMajor, fingerprint }`。 */
export function describeEnvironment({ platform, renderer, vendor, chromeVersion } = {}) {
  const os = normalizeOs(platform);
  const gpuClass = gpuClassOf(renderer, vendor);
  const chromeMajor = chromeMajorOf(chromeVersion);
  return { os, gpuClass, chromeMajor, fingerprint: envFingerprintOf({ os, gpuClass, chromeMajor }) };
}

/** 细任务的结果键:内容键(共享键 / 本地档键 / 流键)乘上环境指纹,64 位小写十六进制。 */
export function resultKeyOf(contentKey, envFingerprint) {
  return sha256(`${contentKey ?? ''}\n${envFingerprint ?? ''}`);
}
