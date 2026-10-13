// P5(后台作业状态与一键流程)可重复跑的真实探针。
//
//   node scripts/probes/cloud-tools-p5-workflow-probe.mjs
//
// 跑之前设好 PROMPTCUT_ACCOUNT_PROVIDER_ROOT、PROMPTCUT_PASSWORD_ORDER_MODULE(运行授权夹具要用,值见仓库 docs/local.md 里的说明)。
// 依赖:转写用 `node scripts/probes/cloud-tools-p2-stt-probe.mjs --setup` 备好的 Python + faster-whisper small;镜头要 ffmpeg(scdet);
// 主体要装了 onnxruntime 的 Python 和 light 档权重(见 scripts/probes/cloud-tools-p4-subject-probe.mjs 文件头的环境变量)。缺依赖就失败,不跳过。
// 内容:先跑假感知的单测(34 条:授权、隔离、失败不越过、取消、重启、提交),再跑真链路(真短片:中文合成语音 + 三个硬切场景含人像照片):
//   整条一键流程走通、依赖没就绪时停在那一阶段、阶段进行中被停(Python 进程真的退出)、服务关闭后重开说得清被中断在哪一阶段。
// 前后各数一次可见窗口和残留的 Python / ffmpeg 进程。输出同时写进 docs/reports/assets/v18-tools-p5/probe.log。耗时只记录。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, realChainMissing, liveProcesses, visibleWindows } from '../../server/test/cloud-tools-p5-real-lib.mjs';

const missing = realChainMissing();
if (missing) { console.error(`[p5] 依赖不全:${missing}`); process.exit(2); }
const logFile = path.join(ROOT, 'docs', 'reports', 'assets', 'v18-tools-p5', 'probe.log');
fs.mkdirSync(path.dirname(logFile), { recursive: true });
const lines = [];
const say = (text) => { console.log(text); lines.push(text); };

const windowsBefore = visibleWindows();
const processesBefore = liveProcesses();
say(`[p5] 开始前:可见窗口 ${windowsBefore},残留的转写/镜头/主体进程 ${processesBefore}`);

const code = await new Promise((resolve) => {
  const child = spawn(process.execPath, [
    '--experimental-test-module-mocks', '--test-global-setup=server/test/global-setup.mjs', '--test', '--test-reporter=spec',
    'server/test/cloud-tools-p5-workflow.test.mjs', 'server/test/cloud-tools-p5-real.test.mjs',
  ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true, env: { ...process.env, P5_VERBOSE: '1' } });
  let text = '';
  child.stdout.on('data', (chunk) => { text += chunk; process.stdout.write(chunk); });
  child.once('close', (exitCode) => {
    lines.push(text);
    const skipped = Number(/ℹ skipped (\d+)/.exec(text)?.[1] ?? 0);
    if (exitCode === 0 && skipped > 0) { say(`[p5] 有 ${skipped} 条被跳过:探针不接受跳过`); resolve(3); } else resolve(exitCode ?? 1);
  });
});

const windowsAfter = visibleWindows();
const processesAfter = liveProcesses();
say(`[p5] 结束后:可见窗口 ${windowsAfter},残留的转写/镜头/主体进程 ${processesAfter}`);
let finalCode = code;
if (processesAfter !== processesBefore) { say('[p5] FAIL 有进程残留'); finalCode = finalCode || 4; }
if (windowsAfter > windowsBefore) { say('[p5] FAIL 冒出了新的可见窗口'); finalCode = finalCode || 5; }
say(finalCode === 0 ? '[p5] 全部通过' : `[p5] 未通过(退出码 ${finalCode})`);
fs.writeFileSync(logFile, lines.join('\n'), 'utf8');
process.exit(finalCode);
