/**
 * 隔离工作进程数据目录的清空（ 的 ，加主进程  的重试写法）在「有进程还占着目录」时的行为演示。
 *
 *   node scripts/probes/hosted-render-wipe-demo.mjs
 *
 * 只在系统临时目录里操作，不起浏览器、不起服务。让一个子进程把工作目录停在 iso/tmp 里 3 秒（相当于还没死透的 Chrome，Windows 上占着的目录删不掉），
 * 然后像  那样最多重试 20 次、每次调 ：
 *   - 旧的 wipeDir（整目录一起 rmSync，记号先被删）：第 1 次 EPERM，记号没了；第 2 次 （「没有记号，不清」）直接抛、不再重试；
 *     收尾后下一轮 wipeDir 仍然 ——隔离工作进程在这次服务期间再也起不来；
 *   - 现在的 wipeDir（先清记号以外的每一项、记号最后才动）：前几次 EPERM 但记号一直在，占着的子进程退出后重试清干净，下一轮 wipeDir 成功。
 * 用例钉在 （模拟删不掉）；这里是真文件锁的演示（Windows 上才会失败，别的平台第 1 次就清干净）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { wipeDir, ISO_MARKER } from '../../server/hosted-render/isolation.mjs';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-wipe-demo-'));
const iso = path.join(base, 'iso');
wipeDir(iso);                                  // 起一轮：建目录放记号
fs.mkdirSync(path.join(iso, 'tmp'));
fs.writeFileSync(path.join(iso, 'tmp', 'x.txt'), 'x');
fs.mkdirSync(path.join(iso, 'vite-cache'));
// 占着目录的子进程（相当于还没死透的 Chrome）：它的工作目录在 iso/tmp 里，3 秒后退出
const holder = spawn(process.execPath, ['-e', 'setTimeout(()=>{},3000)'], { cwd: path.join(iso, 'tmp'), stdio: 'ignore', windowsHide: true });
await delay(300);
const list = () => { try { return fs.readdirSync(iso); } catch (e) { return `(${e.code})`; } };
console.log('清之前：', list());
// 主进程 wipeIso 的写法（server/hosted-render/main.mjs）：最多 20 次，每次 wipeDir，iso-not-ours 直接抛，别的错等 500 毫秒再来
for (let i = 1; i <= 20; i++) {
  try { wipeDir(iso); console.log(`第 ${i} 次：清掉了`); break; }
  catch (err) {
    console.log(`第 ${i} 次失败：code=${err.code} ${String(err.message).slice(0, 70)}；此刻目录里：`, list());
    if (err.code === 'iso-not-ours') { console.log('→ wipeIso 在这里直接抛出，不再重试（日志里就是「没有记号，不清」）'); break; }
    await delay(500);
  }
}
holder.kill();
await delay(500);
console.log('收尾后目录里：', list(), '；下一轮 prepare 的 wipeDir：', (() => { try { wipeDir(iso); return '成功'; } catch (e) { return e.code; } })());
fs.rmSync(base, { recursive: true, force: true });
