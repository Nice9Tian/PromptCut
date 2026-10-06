/**
 * 报出这台节点的机器识别码(模型 Key 加密分发的第一步;任务书 F)。
 *
 *   node server/agent-service/machine-id.mjs            只在标准输出打一行 `PCM-XXXXX-XXXXX-XXXXX-XXXXX`(别的说明走标准错误,方便 $(...) 取用)
 *   node server/agent-service/machine-id.mjs --json     `{"code":"PCM-…","platform":"linux","source":"machine-id","stable":true}`
 *
 * 码怎么来:`server/runners/machine-id.mjs` 的 `machineCode()`——Linux 取 `/etc/machine-id`(取不到再取 `/var/lib/dbus/machine-id`),
 * 加盐取 SHA-256 摘要的前 100 位,Crockford Base32,四组每组五位。**不掺主机名、IP、用户名**:换账号、改主机名、换 IP 都不变;
 * 重装系统或从镜像克隆后重新生成 machine-id 才会变(变了就要重新生成密文、重新导入)。
 * 退到「主机名 + 平台 + 架构 + 网卡」的兜底(`source` 是 `fallback`)时稳定性差,换网卡或改主机名就变:本命令会在标准错误里警告。
 * 这串码就是密文的解开口令:只有拿到它的人才能为这台节点生成解得开的密文,发给要生成密文的人即可,别贴到公开的地方。
 *
 * 本文件不引用 `src/`。
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { machineCode, machineFingerprint } from '../runners/machine-id.mjs';

const SOURCES = { win: 'windows-machine-guid', mac: 'mac-platform-uuid', linux: 'machine-id', fallback: 'fallback' };

/** 这台机器此刻的识别码与它的来源(原始指纹不出这个函数) */
export function describeMachine(fingerprint = machineFingerprint()) {
  const kind = String(fingerprint).split(':')[0];
  const source = SOURCES[kind] ?? 'fallback';
  return { code: machineCode(fingerprint), platform: process.platform, source, stable: source !== 'fallback' };
}

export function runMachineId({ argv = [], stdout = process.stdout, stderr = process.stderr, fingerprint } = {}) {
  const extra = argv.filter((a) => a !== '--json');
  if (extra.length) { stderr.write(`不认识的参数:${extra.join(' ')}。用法:node server/agent-service/machine-id.mjs [--json]\n`); return 2; }
  const info = describeMachine(fingerprint);
  if (argv.includes('--json')) { stdout.write(`${JSON.stringify(info)}\n`); return 0; }
  stdout.write(`${info.code}\n`);
  if (!info.stable) stderr.write('警告:这台机器取不到系统级的机器标识,用的是「主机名 + 网卡」兜底,换网卡或改主机名识别码就会变,到时要重新生成密文、重新导入。\n');
  else stderr.write('这是这台节点的机器识别码,密文要按它生成。换账号、改主机名、改 IP 都不变;重装系统后会变。\n');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = runMachineId({ argv: process.argv.slice(2) });
}
