/**
 * **只用于本机演练**的模型配置来源(任务书 `docs/plan/cloud-agent-task.md` F、完成条件第 8 条):
 * 读这台电脑上桌面版已经配好的 API 直连配置,给本机起的 Agent 服务跑真实模型用。
 *
 * - 只读:`ai.json` 与 `keys/custom.key` 各读一次内容,不写、不拷贝、不改;Key 在进程内用现有的落盘加密解开
 *   (`server/runners/config-crypt.mjs`),只留在内存里,不打印、不进日志、不进任何产物;
 * - `ai.json` 的 `api.source` 是空串时桌面版不会去读 Key 文件;这里固定按 `custom` 那一路读,只在本进程内这样看,不动用户的文件;
 * - 除这两个文件外,用户数据目录里别的东西(对话记录、项目、素材)一概不碰;
 * - 云节点上不用它:节点上的 Key 走加密分发(`import-key.mjs`)。命令行入口只在设了 `PROMPTCUT_AGENT_REHEARSAL_DESKTOP_MODEL=1`
 *   时才用,并在日志里打一行 `agent.rehearsal.desktop-model`(只有厂商与模型名)。
 *
 * 本文件不引用 `src/`。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openKey, sealedKind } from '../runners/config-crypt.mjs';
import { MODEL_VENDORS } from '../agent/service/model-config.mjs';

/** 桌面版配置所在的目录(与 `server/ai-config.mjs` 的缺省位置相同;不认 `PROMPTCUT_AI_CONFIG`,免得探针的隔离环境把它指到别处) */
export function desktopConfigDir(env = process.env) {
  return path.join(env.LOCALAPPDATA || os.homedir(), 'promptcut');
}

/**
 * 读出演练用的模型配置;读不到回 `{}`(服务据此回 `no-model-key`)。
 * @returns {{ vendor?: string, baseUrl?: string, model?: string, maxTokens?: number, apiKey?: string }}
 */
export function readDesktopModelConfig({ dir = desktopConfigDir(), maxTokens = 8192 } = {}) {
  let api = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'ai.json'), 'utf8'));
    api = parsed && typeof parsed.api === 'object' && parsed.api ? parsed.api : null;
  } catch { return {}; }
  if (!api || !MODEL_VENDORS.includes(api.vendor) || api.vendor === 'mock') return {};
  let apiKey = '';
  try {
    const sealed = fs.readFileSync(path.join(dir, 'keys', 'custom.key'), 'utf8').trim();
    if (sealedKind(sealed) === 'custom') apiKey = openKey(sealed, 'custom') || '';
  } catch { /* 没有这一路的 Key */ }
  if (!apiKey) return {};
  const cap = Number.isSafeInteger(api.maxTokens) && api.maxTokens > 0 ? Math.min(api.maxTokens, maxTokens) : maxTokens;
  return {
    vendor: api.vendor,
    baseUrl: typeof api.baseUrl === 'string' ? api.baseUrl : '',
    model: typeof api.model === 'string' ? api.model : '',
    maxTokens: cap,
    apiKey,
  };
}
