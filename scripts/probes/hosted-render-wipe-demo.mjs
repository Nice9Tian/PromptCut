// scripts/probes/hosted-render-wipe-demo.mjs
// 排障用，只在系统临时目录里操作：复现「没有记号」：用真的 wipeDir 和主进程里 wipeIso 一样的重试写法，让一个子进程把工作目录停在 iso/tmp 里 3 秒（占着目录删不掉）。
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
