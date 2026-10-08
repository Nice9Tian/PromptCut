#!/usr/bin/env node
/**
 * 托管方服务身份的密钥生成、登记与撤销（契约 `docs/plan/hosted-render-contract.md` 第 1.1 节）。在云节点上跑：
 * 私钥在节点上生成、不离开节点、不打印；标准输出只有一行 JSON（不含私钥与公钥原文以外的秘密）。
 *
 *   生成并登记（缺省就是这个动作）：
 *     node server/hosted-render/keygen.mjs --hosted-data <托管数据目录> --secrets <私钥目录>
 *          [--service render | agent | <别的服务名>] [--role render] [--acts-for self | member] [--instance-name <给人看的名字>]
 *       - 新生成一对 Ed25519；私钥写 `<私钥目录>/service-key.json`（目录 0700、文件 0600）；
 *         公钥原子追加进 `<托管数据目录>/secrets/services.json`（0600）；
 *       - 私钥目录里已有这个服务的私钥文件时沿用它的 `instanceId` / `instanceName`（换钥不换身份），旧文件被新的替换；
 *         登记表里旧公钥仍在（两把并存），渲染服务重启后再用 `--retire` 撤旧的；
 *       - 输出 `{ "ok": true, "action": "generate", "service", "role", "actsFor", "kid", "instanceId", "registry", "keyFile", "previousKid" }`。
 *   撤一把公钥：
 *     node server/hosted-render/keygen.mjs --hosted-data <托管数据目录> --retire <kid> [--service render]
 *       - 输出 `{ "ok": true, "action": "retire", "service", "kid", "removed": true | false }`；文档服务按文件修改时刻重读，不用重启。
 *   看登记表：
 *     node server/hosted-render/keygen.mjs --hosted-data <托管数据目录> --list
 *       - 输出 `{ "ok": true, "action": "list", "services": { <服务名>: { "role", "actsFor", "kids": [...] } } }`。
 *
 * `--service` 缺省 `render`；`--role` 缺省取服务名对应的角色（`render` → `render`，`agent` → `agent`），别的服务名必须显式给。
 * `--acts-for`：服务进项目时用谁的身份，缺省 `agent` 服务是 `member`（代成员），其余是 `self`；写进登记表，握手按它分支。
 * 出错：标准错误一行 `{ "ok": false, "error": <原因> }`，退出码 1（参数不对是 2）。
 *
 * 导出的 `runKeygen(argv, { now })` 给单测与部署脚本用（不碰 `process`）。只用 Node 内置模块与 `server/auth/`。
 */
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SERVICES_FILE, ACTS_FOR, generateServiceKeyPair, addServiceKey, retireServiceKey, readRegistryFile, writeServiceKeyFile, readServiceKeyFile, newInstanceId,
} from '../auth/service-identity.mjs';
import { ROLES, isServiceName, isDeviceName } from '../auth/protocol.mjs';

class UsageError extends Error {}

/** 解析命令行；不认识的参数、缺值抛 UsageError */
export function parseKeygenArgs(argv) {
  const opts = { hostedData: null, secrets: null, service: 'render', role: null, actsFor: null, instanceName: null, retire: null, list: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const v = argv[i += 1];
      if (v === undefined || v.startsWith('--')) throw new UsageError(`${a} 要跟一个值`);
      return v;
    };
    if (a === '--hosted-data') opts.hostedData = next();
    else if (a === '--secrets') opts.secrets = next();
    else if (a === '--service') opts.service = next();
    else if (a === '--role') opts.role = next();
    else if (a === '--acts-for') opts.actsFor = next();
    else if (a === '--instance-name') opts.instanceName = next();
    else if (a === '--retire') opts.retire = next();
    else if (a === '--list') opts.list = true;
    else throw new UsageError(`不认识的参数 ${a}`);
  }
  if (!opts.hostedData) throw new UsageError('要给 --hosted-data <托管数据目录>');
  if (!isServiceName(opts.service)) throw new UsageError('--service 要是 1～32 个 [a-z0-9-]');
  if (opts.role === null && ROLES.includes(opts.service)) opts.role = opts.service;
  if (opts.actsFor === null) opts.actsFor = opts.service === 'agent' ? 'member' : 'self';
  if (!ACTS_FOR.includes(opts.actsFor)) throw new UsageError(`--acts-for 只能是 ${ACTS_FOR.join(' / ')}`);
  if (opts.retire === null && !opts.list) {
    if (!opts.secrets) throw new UsageError('生成密钥要给 --secrets <私钥目录>');
    if (!ROLES.includes(opts.role)) throw new UsageError(`--role 只能是 ${ROLES.join(' / ')}`);
    if (opts.instanceName !== null && !isDeviceName(opts.instanceName)) throw new UsageError('--instance-name 要是 1～64 个字符');
  }
  return opts;
}

/**
 * 执行一次；回要打印的那一行对象。出错抛（`UsageError` 是参数问题）。
 * @param {string[]} argv
 * @param {{ now?: () => number }} [options]
 */
export function runKeygen(argv, { now = Date.now } = {}) {
  const opts = parseKeygenArgs(argv);
  const registry = path.join(path.resolve(opts.hostedData), 'secrets', SERVICES_FILE);
  if (opts.list) {
    const reg = readRegistryFile(registry);
    return {
      ok: true, action: 'list', registry,
      services: Object.fromEntries(Object.entries(reg.services).map(([name, e]) => [name, { role: e.role, actsFor: e.actsFor, kids: e.keys.map((k) => k.kid) }])),
    };
  }
  if (opts.retire !== null) {
    const removed = retireServiceKey(registry, { service: opts.service, kid: opts.retire });
    return { ok: true, action: 'retire', service: opts.service, kid: opts.retire, removed, registry };
  }
  const secrets = path.resolve(opts.secrets);
  // 换钥不换身份：已有私钥文件时沿用它的 instanceId
  let previous = null;
  try {
    previous = readServiceKeyFile(secrets);
    if (previous.service !== opts.service) previous = null;
  } catch { previous = null; }
  const pair = generateServiceKeyPair();
  const instanceId = previous?.instanceId ?? newInstanceId();
  const instanceName = opts.instanceName ?? previous?.instanceName ?? `${opts.service}@${String(os.hostname() || 'node').replace(/[^\w.-]/g, '-').slice(0, 40)}`;
  // 先登记公钥再写私钥：中途失败时登记表里多一把没人用的公钥（无害，可 --retire），不会出现有私钥而登记表不认
  addServiceKey(registry, { service: opts.service, role: opts.role, actsFor: opts.actsFor, kid: pair.kid, pub: pair.pub, at: now() });
  const keyFile = writeServiceKeyFile(secrets, { service: opts.service, kid: pair.kid, priv: pair.priv, instanceId, instanceName });
  return {
    ok: true, action: 'generate', service: opts.service, role: opts.role, actsFor: opts.actsFor, kid: pair.kid, instanceId,
    registry, keyFile, previousKid: previous?.kid ?? null,
  };
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(runKeygen(process.argv.slice(2)))}\n`);
  } catch (err) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: String(err?.code ?? err?.message ?? err), ...(err instanceof UsageError ? { usage: err.message } : {}) })}\n`);
    process.exit(err instanceof UsageError ? 2 : 1);
  }
}
