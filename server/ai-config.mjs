import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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
    api: {
      vendor: 'anthropic',
      baseUrl: '',
      apiKey: '',
      model: '',
      maxTokens: 4096
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

  const p = getConfigPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(newConfig, null, 2), 'utf8');
  
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
