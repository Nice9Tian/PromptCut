/**
 * 云端 Agent 的模型配置:切模拟模型(`--mock`)、删 Key(`--clear`),以及**仅供本机调试**的交互式录入明文 Key。
 *
 * 〔用户 2026-10-07 定〕正式的 Key 录入走加密分发,不走本文件:节点报出机器识别码(`machine-id.mjs`)→ 用户在自己的电脑上用
 * `make-api-share.bat` 生成只有这台节点解得开的密文 → `import-key.mjs` 导入。会话全程只接触密文,不向用户要明文。
 * 下面的交互式录入保留,是给「用户本人坐在节点终端前、手边没有密文」的调试场合;运行时会先写明这一点。
 *
 * 契约 `docs/plan/cloud-agent-contract.md` 第 8.2 节原先的写法(交互式录入明文)如下,仍然有效:由托管方自己在节点的终端里运行:
 *
 *   cd <部署目录> && PROMPTCUT_AGENT_DATA=<数据目录> node server/agent-service/set-key.mjs
 *
 * 依次问厂商、接口地址、模型清单、单次回复的 token 上限、Key。Key 那一问不回显;读完立刻封装写盘。
 *
 *   --mock    不要 Key,改用仓库里的模拟模型提供方(验收与排查用);再运行一次不带参数的就换回真的
 *   --clear   删掉已保存的 Key(模型配置留着;之后对话请求回「还没有配置模型」)
 *
 * 规矩:
 *   - **不接受命令行参数与环境变量里的 Key**(给了就报错退出),所以 Key 进不了 shell 历史与进程列表;
 *   - 标准输入不是终端时拒绝录入(防止被管道喂进来、顺手留在历史里);
 *   - 自己不打印 Key,结束时只打印末四位;不写任何日志。
 * 写出的是 `<数据目录>/config/ai.json`(厂商、地址、模型清单)与 `<数据目录>/config/keys/custom.key`(密文,0600;
 * 口令由这台机器的指纹派生,整个文件拷到别的机器上解不开)。服务每一轮开始时现读,**录入或换 Key 之后不用重启**。
 * 本文件不引用 `src/`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { clearModelKey, MODEL_VENDORS, modelConfigPaths, readModelConfig, writeModelConfig } from '../agent/service/model-config.mjs';

const REAL_VENDORS = MODEL_VENDORS.filter((v) => v !== 'mock');
const FLAGS = new Set(['--mock', '--clear', '--help', '-h']);

class Quit extends Error {
  constructor(message, code = 1) { super(message); this.exitCode = code; }
}

/** 环境变量里看着像是想把 Key 带进来的:一律拒绝 */
function keyLikeEnv(env) {
  return Object.keys(env).filter((k) => /^PROMPTCUT_AGENT_.*(KEY|SECRET|TOKEN)$/i.test(k) || /^PROMPTCUT_(MODEL|API)_KEY$/i.test(k)).filter((k) => String(env[k] ?? '') !== '');
}

/** 逐字符读终端输入。`hidden` 的不回显 */
function createPrompter(stdin, stdout) {
  let buf = '';
  let waiting = null;
  const feed = (chunk) => {
    buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    pump();
  };
  function pump() {
    while (waiting && buf.length) {
      const ch = buf[0];
      buf = buf.slice(1);
      if (ch === '\u0003' || ch === '\u0004') { const w = waiting; waiting = null; stdout.write('\n'); w.reject(new Quit('已取消,没有改动。', 130)); return; }
      if (ch === '\r' || ch === '\n') {
        // Windows 终端回车是 \r\n:吃掉紧跟着的 \n
        if (ch === '\r' && buf[0] === '\n') buf = buf.slice(1);
        const w = waiting; waiting = null;
        stdout.write('\n');
        w.resolve(w.text);
        return;
      }
      if (ch === '\u007f' || ch === '\b') {
        if (waiting.text.length) { waiting.text = waiting.text.slice(0, -1); if (!waiting.hidden) stdout.write('\b \b'); }
        continue;
      }
      if (ch < ' ') continue;
      waiting.text += ch;
      if (!waiting.hidden) stdout.write(ch);
    }
  }
  stdin.setEncoding?.('utf8');
  stdin.setRawMode?.(true);
  stdin.on('data', feed);
  stdin.resume?.();
  return {
    ask(question, { hidden = false } = {}) {
      stdout.write(question);
      return new Promise((resolve, reject) => { waiting = { text: '', hidden, resolve, reject }; pump(); });
    },
    close() {
      stdin.off('data', feed);
      try { stdin.setRawMode?.(false); } catch { /* 不是终端 */ }
      stdin.pause?.();
    },
  };
}

/**
 * @param {object} o
 * @param {string[]} o.argv 命令行参数(不含 node 与脚本名)
 * @param {Record<string, string | undefined>} o.env
 * @returns {Promise<number>} 退出码
 */
export async function runSetKey({ argv = [], env = process.env, stdin = process.stdin, stdout = process.stdout } = {}) {
  const say = (line) => stdout.write(`${line}\n`);
  let prompter = null;
  try {
    const extra = argv.filter((a) => !FLAGS.has(a));
    if (extra.length) throw new Quit('不接受从命令行给的任何内容(包括 Key):请直接运行本脚本,按提示输入。可用的开关只有 --mock 与 --clear。');
    const leaked = keyLikeEnv(env);
    if (leaked.length) throw new Quit(`不接受从环境变量给 Key(看到了 ${leaked.join('、')}):请去掉它,直接运行本脚本,按提示输入。`);
    if (argv.includes('--help') || argv.includes('-h')) {
      say('用法:PROMPTCUT_AGENT_DATA=<数据目录> node server/agent-service/set-key.mjs [--mock | --clear]');
      return 0;
    }
    const dataDir = env.PROMPTCUT_AGENT_DATA;
    if (!dataDir) throw new Quit('请用环境变量 PROMPTCUT_AGENT_DATA 指出 Agent 服务的数据目录。');
    try {
      if (!fs.statSync(dataDir).isDirectory()) throw new Error('不是目录');
      fs.accessSync(dataDir, fs.constants.W_OK);
    } catch (err) {
      throw new Quit(`数据目录不可用:${err?.message ?? err}`);
    }

    if (argv.includes('--mock')) {
      writeModelConfig(dataDir, { vendor: 'mock', model: 'mock-1' }, null);
      say('已切到模拟模型提供方(不调用任何真实模型)。换回真实模型:不带参数再运行一次本脚本。');
      return 0;
    }
    if (argv.includes('--clear')) {
      clearModelKey(dataDir);
      say('已删除保存的 Key。');
      return 0;
    }

    if (!stdin.isTTY) throw new Quit('标准输入不是终端:请登录到节点后在终端里直接运行本脚本,不要用管道或重定向把 Key 喂进来。');
    const old = readModelConfig(dataDir);
    const oldVendor = REAL_VENDORS.includes(old.vendor) ? old.vendor : 'anthropic';
    prompter = createPrompter(stdin, stdout);
    say('提示:这是仅供本机调试的录入方式。正式录入模型 Key 请用加密分发:node server/agent-service/machine-id.mjs 报出识别码,用 make-api-share.bat 生成密文,再 node server/agent-service/import-key.mjs --file <密文文件>。');
    say(`模型配置写到 ${path.join(modelConfigPaths(dataDir).dir, '')}`);
    const vendor = (await prompter.ask(`厂商(${REAL_VENDORS.join(' / ')})[${oldVendor}]:`)).trim() || oldVendor;
    if (!REAL_VENDORS.includes(vendor)) throw new Quit(`厂商只能是 ${REAL_VENDORS.join(' / ')}。没有改动。`);
    const baseUrl = (await prompter.ask(`接口地址(用厂商官方地址就直接回车)[${old.baseUrl || '官方地址'}]:`)).trim() || old.baseUrl || '';
    if (baseUrl && !/^https?:\/\//.test(baseUrl)) throw new Quit('接口地址要以 http:// 或 https:// 开头。没有改动。');
    const model = (await prompter.ask(`模型清单(多个用 | 分隔,第一个是缺省)[${old.model && old.vendor !== 'mock' ? old.model : '必填'}]:`)).trim() || (old.vendor !== 'mock' ? old.model : '') || '';
    if (!model) throw new Quit('模型清单不能空。没有改动。');
    const maxText = (await prompter.ask(`单次回复的 token 上限 [${old.maxTokens || 4096}]:`)).trim();
    const maxTokens = maxText ? Number(maxText) : (old.maxTokens || 4096);
    if (!Number.isSafeInteger(maxTokens) || maxTokens < 256) throw new Quit('token 上限要是不小于 256 的整数。没有改动。');
    let key = (await prompter.ask('Key(输入时不显示,输完回车):', { hidden: true })).trim();
    if (!key) throw new Quit('没有输入 Key。没有改动。');
    writeModelConfig(dataDir, { vendor, baseUrl, model, maxTokens }, key);
    const tail = key.length >= 12 ? key.slice(-4) : '****';
    key = '';
    say(`已保存,末四位 ${tail}。运行中的服务下一轮对话起就用它,不用重启。`);
    return 0;
  } catch (err) {
    if (err instanceof Quit) { say(err.message); return err.exitCode; }
    say(`没有保存:${String(err?.message ?? err)}`);
    return 1;
  } finally {
    prompter?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runSetKey({ argv: process.argv.slice(2) }).then((code) => { process.exitCode = code; });
}
