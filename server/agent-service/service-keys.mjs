/**
 * Agent 服务节点上外部服务的 Key:按服务名导入(模型、配音……),与读出。
 *
 * 流程(任务书 `docs/plan/cloud-agent-task.md` F;契约 `docs/plan/cloud-agent-contract.md` 第 8 节):
 *   节点报出机器识别码(`machine-id.mjs`)→ 用户在自己的电脑上用 `make-api-share.bat` 把 Key 加密成只有这台节点解得开的密文
 *   → 密文送到节点,`import-key.mjs` 在本机解开(`share-blob.mjs`)→ 按现有的落盘加密(`server/runners/config-crypt.mjs`)存进数据目录。
 * 会话与传输途中只接触密文;明文 Key 只在解开后的这个进程的内存里,存盘的是落盘密文,不打印、不写日志。
 *
 * 服务名与落点(`<数据目录>/config/`):
 *   `model`  模型 Key:`ai.json`(厂商、地址、模型清单、token 上限)+ `keys/custom.key`,与 `server/agent/service/model-config.mjs` 读的位置与格式一致;
 *   `voice`  配音 Key:`voice.json`(`{ v, baseUrl, provider }`)+ `keys/voice.key`(`PCVOC1.` 封装,与对话 Key 是两把,互不相通)。
 *            分发密文里的字段在这里的含义:「API 地址」= 配音网关的地址(空 = 由使用方的缺省);「模型」= 配音提供方,
 *            minimax / kling / vidu 之一(空 = minimax);「厂商」随便选一个(配音不看它)。
 * 加别的服务:在 `SERVICES` 里加一项(`apply` 写盘、`read` 读出),命令行与测试不用改。
 *
 * 本文件不引用 `src/`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { openKey, sealKey, sealedKind } from '../runners/config-crypt.mjs';
import { machineCode } from '../runners/machine-id.mjs';
import { PROVIDERS as VOICE_PROVIDERS } from '../voice/presets.mjs';
import { modelConfigPaths, readModelConfig, writeModelConfig } from '../agent/service/model-config.mjs';
import { decryptShareBlob, ShareBlobError } from './share-blob.mjs';

/** 导入没做成的原因。`code`:`bad-service` | `bad-data-dir` | `expired` | `bad-content` | 以及 `ShareBlobError` 的几种 */
export class ImportKeyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ImportKeyError';
    this.code = code;
  }
}

const MODEL_VENDORS = Object.freeze(['anthropic', 'openai', 'gemini']);
const tailOf = (key) => (key.length >= 12 ? key.slice(-4) : '****');
const httpUrl = (s) => /^https?:\/\/\S+$/.test(s);

function writePrivate(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch { /* Windows 上基本是空操作 */ }
  fs.renameSync(tmp, file);
}

const configDirOf = (dataDir) => path.join(dataDir, 'config');
export const voicePaths = (dataDir) => ({ file: path.join(configDirOf(dataDir), 'voice.json'), keyFile: path.join(configDirOf(dataDir), 'keys', 'voice.key') });

/** 服务表。`apply(dataDir, cfg)` 先校验再写盘,回给界面看的摘要(不含 Key);校验不过抛 `ImportKeyError`、此前不写任何东西 */
const SERVICES = {
  model: {
    label: '模型',
    apply(dataDir, cfg) {
      if (!MODEL_VENDORS.includes(cfg.vendor)) throw new ImportKeyError('bad-content', `密文里的厂商是「${cfg.vendor || '空'}」,模型 Key 的厂商只能是 ${MODEL_VENDORS.join(' / ')}。请在生成密文时选对厂商。`);
      const models = cfg.model.split('|').map((s) => s.trim()).filter(Boolean);
      if (!models.length) throw new ImportKeyError('bad-content', '密文里没有写模型清单。请让对方在「模型」一栏填上(多个用 | 分隔,第一个是缺省)。');
      if (cfg.baseUrl && !httpUrl(cfg.baseUrl)) throw new ImportKeyError('bad-content', '密文里的接口地址要以 http:// 或 https:// 开头。');
      const old = readModelConfig(dataDir);
      const maxTokens = cfg.maxTokens ?? (old.vendor && old.vendor !== 'mock' ? old.maxTokens : 4096) ?? 4096;
      if (!Number.isSafeInteger(maxTokens) || maxTokens < 256) throw new ImportKeyError('bad-content', 'token 上限要是不小于 256 的整数。');
      const replaced = fs.existsSync(modelConfigPaths(dataDir).keyFile);
      writeModelConfig(dataDir, { vendor: cfg.vendor, baseUrl: cfg.baseUrl, model: models.join('|'), maxTokens }, cfg.apiKey);
      return { vendor: cfg.vendor, models, defaultModel: models[0], maxTokens, replaced };
    },
    read: (dataDir) => readModelConfig(dataDir),
  },
  voice: {
    label: '配音',
    apply(dataDir, cfg) {
      const provider = cfg.model.split('|')[0].trim().toLowerCase();
      if (provider && !VOICE_PROVIDERS.includes(provider)) throw new ImportKeyError('bad-content', `配音的「模型」一栏要填 ${VOICE_PROVIDERS.join(' / ')} 之一(或留空,用 minimax),密文里写的是「${provider}」。`);
      if (cfg.baseUrl && !httpUrl(cfg.baseUrl)) throw new ImportKeyError('bad-content', '密文里的接口地址要以 http:// 或 https:// 开头。');
      const { file, keyFile } = voicePaths(dataDir);
      const replaced = fs.existsSync(keyFile);
      writePrivate(keyFile, `${sealKey(cfg.apiKey, 'voice')}\n`);
      writePrivate(file, `${JSON.stringify({ v: 1, baseUrl: cfg.baseUrl.replace(/\/+$/, ''), provider: provider || 'minimax' }, null, 2)}\n`);
      return { vendor: null, models: [provider || 'minimax'], defaultModel: provider || 'minimax', baseUrl: cfg.baseUrl || null, replaced };
    },
    read(dataDir) {
      const { file, keyFile } = voicePaths(dataDir);
      let conf = {};
      try { conf = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
      let apiKey = '';
      try {
        const sealed = fs.readFileSync(keyFile, 'utf8').trim();
        if (sealedKind(sealed) === 'voice') apiKey = openKey(sealed, 'voice') || '';
      } catch { /* 还没导入 */ }
      return { baseUrl: typeof conf.baseUrl === 'string' ? conf.baseUrl : '', provider: VOICE_PROVIDERS.includes(conf.provider) ? conf.provider : 'minimax', apiKey };
    },
  },
};

export const KEY_SERVICE_NAMES = Object.freeze(Object.keys(SERVICES));

/** 读出某个服务此刻的配置(含解开后的 Key 明文,只在调用方的内存里用;读不出回空对象) */
export function readServiceKey(dataDir, service) {
  const s = SERVICES[service];
  if (!s) throw new ImportKeyError('bad-service', `不认识的服务名「${service}」,可用:${KEY_SERVICE_NAMES.join('、')}。`);
  return s.read(dataDir);
}

/**
 * 导入一份分发密文。顺序:认服务名 → 查数据目录 → 解密(格式、机器对不对、有没有被改)→ 查有效期 → 校验内容 → 写盘。
 * 任何一步没过都抛 `ImportKeyError` 或 `ShareBlobError`,此前不写任何东西。
 * @param {object} o
 * @param {string} o.dataDir Agent 服务的数据目录
 * @param {string} o.blob 密文文本
 * @param {string} [o.service] 服务名,缺省 `model`
 * @param {string} [o.code] 这台机器的识别码(缺省现算;测试里传别的来模拟「别的机器」)
 * @param {number} [o.now] 当前时刻(毫秒)
 * @returns {{ service: string, label: string, vendor: string | null, models: string[], defaultModel: string, tail: string, replaced: boolean, note?: string, maxTokens?: number, baseUrl?: string | null }}
 */
export function importServiceKey({ dataDir, blob, service = 'model', code = machineCode(), now = Date.now() }) {
  const s = SERVICES[service];
  if (!s) throw new ImportKeyError('bad-service', `不认识的服务名「${service}」,可用:${KEY_SERVICE_NAMES.join('、')}。`);
  try {
    if (!fs.statSync(dataDir).isDirectory()) throw new Error('不是目录');
    fs.accessSync(dataDir, fs.constants.W_OK);
  } catch (err) {
    throw new ImportKeyError('bad-data-dir', `数据目录不可用:${err?.message ?? err}`);
  }
  const cfg = decryptShareBlob(blob, code);
  if (typeof cfg.expiresAt === 'number' && cfg.expiresAt <= now) throw new ImportKeyError('expired', '这份密文已过期(生成时设了有效期)。请让对方重新生成。');
  const summary = s.apply(dataDir, cfg);
  return { service, label: s.label, tail: tailOf(cfg.apiKey), ...(cfg.note ? { note: cfg.note } : {}), ...summary };
}

export { ShareBlobError };
