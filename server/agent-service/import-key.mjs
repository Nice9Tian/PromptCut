/**
 * 在节点上导入用 `make-api-share.bat` 生成的分发密文(任务书 F;流程见 `service-keys.mjs` 文件头)。
 *
 *   PROMPTCUT_AGENT_DATA=<数据目录> node server/agent-service/import-key.mjs --file <密文文件> [--service model|voice]
 *   PROMPTCUT_AGENT_DATA=<数据目录> node server/agent-service/import-key.mjs [--service …] < <密文文件>    (密文从标准输入读)
 *
 *   --file <路径>     密文存在这个文件里(`PCAI1.` 开头的一整段;换行、空格会被忽略)
 *   --service <名>    哪个服务的 Key:`model`(缺省,对话用的模型)或 `voice`(配音);以后加服务只改 `service-keys.mjs` 的服务表
 *   --stdin           明说从标准输入读(没给 --file 且标准输入不是终端时也是它)
 *
 * 解开用的是**这台机器自己的识别码**,密文不是按它生成的、格式不对、被截断或被改过,都给出各自的原因并退出,什么都不写。
 * 输出只有:服务、厂商、模型清单、Key 的末四位;不打印 Key、不打印密文、不写日志。运行中的服务每一轮开始时现读配置,导入后不用重启。
 * 退出码:0 成功;1 没做成(原因在输出里);2 命令行用法不对。
 *
 * 本文件不引用 `src/`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ImportKeyError, importServiceKey, KEY_SERVICE_NAMES, ShareBlobError } from './service-keys.mjs';

/** 密文最大多少字节:正常的只有几百字节,给个宽松的上限挡住误指到大文件 */
const MAX_BLOB_BYTES = 64 * 1024;

class Usage extends Error {}

function readAll(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    stream.on('data', (c) => { size += c.length; if (size > MAX_BLOB_BYTES) { reject(new Usage('标准输入的内容太大,不像是一份密文。')); stream.destroy?.(); return; } chunks.push(c); });
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', reject);
  });
}

/**
 * @param {object} o
 * @param {string[]} o.argv 命令行参数(不含 node 与脚本名)
 * @param {Record<string, string | undefined>} o.env
 * @param {string} [o.code] 测试用:换一个识别码模拟别的机器
 * @returns {Promise<number>} 退出码
 */
export async function runImportKey({ argv = [], env = process.env, stdin = process.stdin, stdout = process.stdout, code } = {}) {
  const say = (line) => stdout.write(`${line}\n`);
  try {
    let file = null;
    let service = 'model';
    let fromStdin = false;
    for (let i = 0; i < argv.length; i += 1) {
      const a = argv[i];
      if (a === '--file' || a === '--service') {
        const v = argv[i += 1];
        if (v === undefined || v.startsWith('--')) throw new Usage(`${a} 要跟一个值。`);
        if (a === '--file') file = v; else service = v;
      } else if (a === '--stdin') fromStdin = true;
      else if (a === '--help' || a === '-h') {
        say('用法:PROMPTCUT_AGENT_DATA=<数据目录> node server/agent-service/import-key.mjs [--file <密文文件> | --stdin] [--service model|voice]');
        return 0;
      } else throw new Usage(`不认识的参数「${a.slice(0, 12)}${a.length > 12 ? '…' : ''}」(密文不能写在命令行上:请用 --file 指一个文件,或从标准输入给)。`);
    }
    if (!KEY_SERVICE_NAMES.includes(service)) throw new Usage(`不认识的服务名「${service}」,可用:${KEY_SERVICE_NAMES.join('、')}。`);
    const dataDir = env.PROMPTCUT_AGENT_DATA;
    if (!dataDir) throw new Usage('请用环境变量 PROMPTCUT_AGENT_DATA 指出 Agent 服务的数据目录。');
    if (file && fromStdin) throw new Usage('--file 与 --stdin 只能给一个。');
    let blob;
    if (file) {
      let st;
      try { st = fs.statSync(file); } catch (err) { throw new Usage(`读不了密文文件:${err?.message ?? err}`); }
      if (!st.isFile() || st.size > MAX_BLOB_BYTES) throw new Usage('这个路径不是一份密文文件(不是普通文件,或大得不像密文)。');
      blob = fs.readFileSync(file, 'utf8');
    } else if (fromStdin || !stdin.isTTY) {
      blob = await readAll(stdin);
    } else {
      throw new Usage('没有给密文:用 --file 指一个密文文件,或从标准输入给(如 node … import-key.mjs < 密文.txt)。');
    }
    const r = importServiceKey({ dataDir: path.resolve(dataDir), blob, service, ...(code ? { code } : {}) });
    say(`已导入${r.label} Key${r.replaced ? '(替换了原来的)' : ''}。`);
    if (r.vendor) say(`厂商:${r.vendor}`);
    say(`${service === 'voice' ? '配音提供方' : '模型'}:${r.models.join('、')}${r.models.length > 1 ? `(缺省 ${r.defaultModel})` : ''}`);
    say(`Key 末四位:${r.tail}`);
    if (r.note) say(`留言:${r.note}`);
    say('运行中的服务下一轮起就用它,不用重启。');
    return 0;
  } catch (err) {
    if (err instanceof Usage) { say(`用法不对:${err.message}`); return 2; }
    if (err instanceof ImportKeyError || err instanceof ShareBlobError) { say(`没有导入:${err.message}`); return 1; }
    say(`没有导入:${String(err?.message ?? err)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runImportKey({ argv: process.argv.slice(2) }).then((c) => { process.exitCode = c; });
}
