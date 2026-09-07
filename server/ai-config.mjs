import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { sealKey, openKey } from './runners/config-crypt.mjs';

function getConfigPath() {
  if (process.env.PROMPTCUT_AI_CONFIG) {
    return process.env.PROMPTCUT_AI_CONFIG;
  }
  const appData = process.env.LOCALAPPDATA || os.homedir();
  return path.join(appData, 'promptcut', 'ai.json');
}

function getDefaults() {
  return {
    version: 1,
    defaultProvider: null,
    toolProtocol: false,
    api: {
      vendor: 'anthropic',
      baseUrl: '',
      apiKey: '',
      model: '',
      maxTokens: 4096
    },
    // 三家 CLI 各自的可选模型清单,和 api.model 同一个约定:用 | 分隔。
    // 面板上的模型选择器就读这里;留空就只有「默认」一项。
    cliModels: {
      claude: 'opus|sonnet|haiku',
      codex: '',
      agy: ''
    }
  };
}

export function readConfig() {
  const p = getConfigPath();
  const defs = getDefaults();
  try {
    if (!fs.existsSync(p)) return defs;
    const content = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(content);
    const merged = deepMerge(defs, parsed, true);
    if (!merged.api || typeof merged.api !== 'object' || Array.isArray(merged.api)) {
      merged.api = defs.api;
    }
    // 落盘的是密文,进程内一律用明文:下游(providers、publicConfig)都不用改
    merged.api.apiKey = openKey(merged.api.apiKey);
    return merged;
  } catch {
    return defs;
  }
}

function deepMerge(target, source, reading = false) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (!(key in target) && !reading) {
      continue;
    }
    if (source[key] !== null && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key] || {}, source[key], reading);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

export function writeConfig(partial) {
  const current = readConfig();
  const newConfig = deepMerge(current, partial, false);
  
  if (partial.api && partial.api.vendor !== undefined) {
    if (!['anthropic', 'openai', 'gemini'].includes(partial.api.vendor)) {
      throw new Error('vendor 只能是 anthropic / openai / gemini');
    }
    newConfig.api.vendor = partial.api.vendor;
  }
  
  if (partial.api && partial.api.baseUrl !== undefined) {
    if (partial.api.baseUrl !== '' && !partial.api.baseUrl.startsWith('http://') && !partial.api.baseUrl.startsWith('https://')) {
      throw new Error('baseUrl 必须是 http(s) 地址或留空');
    }
    newConfig.api.baseUrl = partial.api.baseUrl;
  }
  
  if (partial.defaultProvider !== undefined) {
    if (!['claude', 'agy', 'codex', 'api', null].includes(partial.defaultProvider)) {
      throw new Error('defaultProvider 必须是 claude, agy, codex, api 或 null');
    }
    newConfig.defaultProvider = partial.defaultProvider;
  }
  
  if (partial.api && partial.api.apiKey !== undefined) {
    if (partial.api.apiKey === null) {
      newConfig.api.apiKey = '';
    } else if (partial.api.apiKey !== '') {
      newConfig.api.apiKey = partial.api.apiKey;
    } else {
      newConfig.api.apiKey = current.api.apiKey;
    }
  } else {
    newConfig.api.apiKey = current.api.apiKey;
  }
  
  if (partial.api && partial.api.maxTokens !== undefined) {
    const val = parseInt(partial.api.maxTokens, 10);
    if (!isNaN(val) && val > 0) {
      newConfig.api.maxTokens = val;
    } else {
      newConfig.api.maxTokens = current.api.maxTokens;
    }
  }

  if (partial.cliModels !== undefined) {
    const incoming = partial.cliModels;
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
      throw new Error('cliModels 必须是对象');
    }
    for (const key of ['claude', 'codex', 'agy']) {
      if (incoming[key] === undefined) continue;
      if (typeof incoming[key] !== 'string') throw new Error(`cliModels.${key} 必须是字符串`);
      newConfig.cliModels[key] = incoming[key];
    }
  }

  if (partial.toolProtocol !== undefined) {
    newConfig.toolProtocol = !!partial.toolProtocol;
  }

  const p = getConfigPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // Key 只以密文落盘;返回给调用方的仍是明文那份(publicConfig 会再脱敏一次)
  const onDisk = { ...newConfig, api: { ...newConfig.api, apiKey: sealKey(newConfig.api.apiKey) } };
  // 0600:密文的口令是**本机**机器码,同一台机器上的另一个用户推得出来,所以别让他读到密文。
  // writeFileSync 的 mode 只在新建时生效,已存在的文件要另外 chmod 一次。
  // (Windows 上 chmod 基本是空操作,这一道是给 POSIX 的。)
  fs.writeFileSync(p, JSON.stringify(onDisk, null, 2), { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(p, 0o600); } catch { /* Windows / 权限不够,不影响功能 */ }

  return newConfig;
}

export function publicConfig() {
  const cfg = readConfig();
  const apiKey = cfg.api.apiKey || '';
  cfg.api.apiKey = {
    set: apiKey.length > 0,
    last4: apiKey.length >= 4 ? apiKey.slice(-4) : ''
  };
  return cfg;
}
