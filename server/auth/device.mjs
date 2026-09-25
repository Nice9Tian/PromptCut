/**
 * 本机设备信息（计划 `docs/plan/Master-Execution-Plan.md` 第 12.2 节「设备名」、契约 `auth-contract.md` 第 5 节「本机声明」）。
 *
 * - `deviceId`：主机名、平台、架构与第一块非内部网卡的 MAC 拼起来取 sha256，前 22 个 base64url 字符前面加 `pc-`
 *   （满足 16～64 个 `[A-Za-z0-9_-]`）。同一台机器每次算出来都一样；
 * - `deviceName`：主机名加上面那串哈希的前 4 个字符，例如 `DESKTOP-ABC-x7Qe`；
 * - 环境变量 `PROMPTCUT_DEVICE_ID` / `PROMPTCUT_DEVICE_NAME` 可以覆盖（同一台机器上起两个实例做测试时用）。
 *
 * 计划里写的「写入用户数据目录后不再变」留给桌面壳（C6.5）：本模块不写任何文件，只按硬件信息现算。
 */
import os from 'node:os';
import { createHash } from 'node:crypto';
import { isDeviceId, isDeviceName } from './protocol.mjs';

function firstMac() {
  for (const list of Object.values(os.networkInterfaces() ?? {})) {
    for (const nic of list ?? []) {
      if (nic && !nic.internal && nic.mac && nic.mac !== '00:00:00:00:00:00') return nic.mac;
    }
  }
  return '';
}

/** @param {Record<string, string | undefined>} [env] */
export function localDeviceInfo(env = process.env) {
  const host = String(os.hostname() || 'host');
  const hash = createHash('sha256').update(`${host}\n${os.platform()}\n${os.arch()}\n${firstMac()}`, 'utf8').digest('base64url');
  const deviceId = isDeviceId(env.PROMPTCUT_DEVICE_ID) ? env.PROMPTCUT_DEVICE_ID : `pc-${hash.slice(0, 22)}`;
  const fallbackName = `${host.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, 59) || 'host'}-${hash.slice(0, 4)}`;
  const deviceName = isDeviceName(env.PROMPTCUT_DEVICE_NAME) ? env.PROMPTCUT_DEVICE_NAME : fallbackName;
  return { deviceId, deviceName };
}
