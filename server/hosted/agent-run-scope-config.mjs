/**
 * 文档服务这一侧「一条任务一个进程」的配置：从一份本机 JSON 读成 `account.agent.runScopes`
 * （`doc-agent-assembly.mjs` → `createAgentRunScopeDoc` 认的那个形状）。
 *
 * 文件由环境变量 `PROMPTCUT_DOC_AGENT_RUN_SCOPES_FILE` 指（绝对路径）。不设就是不开这个模式——那时云端 Agent 的任务
 * 领得到分配的那几条内部接口照旧回 503 `run-scope-unavailable`，Agent 一侧起不来任务，不会退回别的跑法。
 *
 *   v: 1
 *   signingKeyFile          文档服务给分配、终态签名用的 Ed25519 私钥（PEM）；它的公钥就是各槽 `expected.docPublicKey`
 *   masterServiceKid        只做控制的主身份在服务登记表里的钥匙号（和跑任务的那个身份不同）
 *   masterFingerprint256    主身份那张证书的指纹（和任务证书不同）
 *   slots[]                 每个槽：
 *       expected                和 root 入口配置里这个槽的 `publisher.expected` 逐字相同
 *       registryDir             root 写这个槽记录的目录（文档服务只读；目录和文件都要是 root 的、别人写不了）
 *       configuredAnchorDigest  初始化这个槽时 root 入口打印的锚点摘要
 * 跑任务的身份（钥匙号与证书指纹）不在这里重复写：用文档服务已有的 Agent 身份（`account.agent`），各槽共用。
 *
 * 只在 Linux 上能开：读 root 的记录要核属主（`agent-run-scope-reader.mjs`）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { validateAgentScopeExpected } from './agent-run-scope-schema.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === [...keys].sort().join(',');
const hash = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const pin = v => String(v ?? '').replaceAll(':', '').toLowerCase();

/**
 * @param {object} o
 * @param {string} o.file
 * @param {{ fingerprint256: string, serviceKid: string }} o.agent 跑任务的那个 Agent 身份
 * @param {string} o.authorityId 文档服务的权威号
 * @param {string} [o.platform]
 * @param {(file: string) => Buffer} [o.read]
 */
export function loadAgentRunScopesConfig({ file, agent, authorityId, platform = process.platform, read = fs.readFileSync } = {}) {
  if (platform !== 'linux') fail('run-scopes-linux-required');
  if (typeof file !== 'string' || !path.isAbsolute(file) || !hash(pin(agent?.fingerprint256)) || typeof agent.serviceKid !== 'string' || !agent.serviceKid ||
      typeof authorityId !== 'string' || !authorityId) fail('run-scopes-configuration');
  let value;
  try { value = JSON.parse(read(file).toString('utf8')); } catch { fail('run-scopes-file'); }
  if (!exact(value, ['v', 'signingKeyFile', 'masterServiceKid', 'masterFingerprint256', 'slots']) || value.v !== 1 ||
      typeof value.signingKeyFile !== 'string' || !path.isAbsolute(value.signingKeyFile) ||
      typeof value.masterServiceKid !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value.masterServiceKid) || !hash(pin(value.masterFingerprint256)) ||
      !Array.isArray(value.slots) || !value.slots.length || value.slots.length > 64) fail('run-scopes-configuration');
  const masterFingerprint256 = pin(value.masterFingerprint256), workerFingerprint256 = pin(agent.fingerprint256);
  // 主身份和跑任务的身份必须是两把钥匙、两张证书：主身份领不到任务，任务身份问不了调度的那几条
  if (masterFingerprint256 === workerFingerprint256 || value.masterServiceKid === agent.serviceKid) fail('run-scopes-role-configuration');
  let signingKey, docPublicKey;
  try {
    signingKey = createPrivateKey(read(value.signingKeyFile));
    if (signingKey.asymmetricKeyType !== 'ed25519') throw new Error('type');
    docPublicKey = createPublicKey(signingKey).export({ format: 'der', type: 'spki' }).toString('base64');
  } catch { fail('run-scopes-signing-key'); }
  const seen = new Set();
  const slots = value.slots.map(slot => {
    if (!exact(slot, ['expected', 'registryDir', 'configuredAnchorDigest']) || typeof slot.registryDir !== 'string' ||
        !path.isAbsolute(slot.registryDir) || path.normalize(slot.registryDir) !== slot.registryDir || !hash(slot.configuredAnchorDigest)) fail('run-scopes-slot');
    const expected = validateAgentScopeExpected(slot.expected);
    if (expected.docAuthorityId !== authorityId || expected.docPublicKey !== docPublicKey) fail('run-scopes-slot-authority');
    for (const id of [`key:${expected.authorityId}:${expected.slotId}`, `dir:${slot.registryDir}`, `unit:${expected.unit}`]) {
      if (seen.has(id)) fail('run-scopes-slot-duplicate'); seen.add(id);
    }
    return { expected, registryDir: slot.registryDir, configuredAnchorDigest: slot.configuredAnchorDigest,
      workerServiceKid: agent.serviceKid, workerFingerprint256 };
  });
  return { signingKey, slots, masterServiceKid: value.masterServiceKid, masterFingerprint256 };
}
