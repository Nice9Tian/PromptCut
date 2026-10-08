/**
 * `scripts/remote/docservice.mjs` 的两个模型 Key 子命令的计划(任务书 F;纯函数,`--dry-run` 与单测都走这里,不连任何远端):
 *
 *   machine-id-agent                                      在节点上跑 `machine-id.mjs`,把机器识别码取回来
 *   import-key-agent --file <本机的密文文件> [--service model|voice]   把密文送到节点,在节点本机解开并导入(`import-key.mjs`)
 *
 * 密文经 ssh 的标准输入进远端脚本,写到节点数据目录的 `tmp/` 里(0600),导入完(成功或失败)都删掉;不上命令行、不进 PM2 配置。
 * **脚本里没有明文 Key**:明文只在用户自己的电脑上、`make-api-share.bat` 里出现过。`--dry-run` 打印的预览里密文也只显示开头与长度。
 * 部署参数(部署目录、数据目录)与 `deploy-agent` 同一套(`deploy.mjs` 的 `agentInstance`)。本文件不引用 `src/`。
 */
import fs from 'node:fs';
import { DeployUsageError, shq } from '../hosted-render/deploy.mjs';
import { agentInstance } from './deploy.mjs';

export const KEY_COMMANDS = Object.freeze(['machine-id-agent', 'import-key-agent']);

const BLOB_SHAPE = /^PCAI1\.[A-Za-z0-9_-]+$/;
const MAX_BLOB_BYTES = 64 * 1024;
const SERVICE_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const HEREDOC = 'PROMPTCUT_KEY_BLOB_EOF';
const preamble = (extra = []) => ['set -euo pipefail', 'set +x', ...extra];

export function machineIdScript(inst) {
  return `${preamble([`cd ${shq(inst.current)}`]).concat([
    'if [ ! -f server/agent-service/machine-id.mjs ]; then echo "检出目录里没有 machine-id.mjs(先 deploy-render 到包含它的提交)" >&2; exit 4; fi',
    'node server/agent-service/machine-id.mjs',
  ]).join('\n')}\n`;
}

/** @param {string} blob 已校验过形状的密文(一整段,无空白) */
export function importKeyScript(inst, { blob, service = 'model' }) {
  if (!BLOB_SHAPE.test(blob)) throw new DeployUsageError('不是一份 PCAI1. 开头的密文。');
  return `${preamble([`DATA=${shq(inst.data)}`, `cd ${shq(inst.current)}`]).concat([
    'if [ ! -f server/agent-service/import-key.mjs ]; then echo "检出目录里没有 import-key.mjs(先 deploy-render 到包含它的提交)" >&2; exit 4; fi',
    'if [ ! -d "$DATA" ]; then echo "数据目录 $DATA 不存在(先 deploy-agent --no-start)" >&2; exit 4; fi',
    'umask 077',
    'mkdir -p "$DATA/tmp"',
    'BLOB="$DATA/tmp/incoming-key-$$.txt"',
    `trap 'rm -f "$BLOB"' EXIT`,
    `cat > "$BLOB" <<'${HEREDOC}'`,
    blob,
    HEREDOC,
    `PROMPTCUT_AGENT_DATA="$DATA" node server/agent-service/import-key.mjs --file "$BLOB" --service ${shq(service)}`,
  ]).join('\n')}\n`;
}

/** 子命令的计划:参数解析与校验在这里。`deps.readFile` 测试用 */
export function planKeyCommand(cmd, argv, env = process.env, deps = {}) {
  if (!KEY_COMMANDS.includes(cmd)) throw new DeployUsageError(`不认识的命令 ${cmd}`);
  const inst = agentInstance(env);
  const opts = {};
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') dryRun = true;
    else if ((a === '--file' || a === '--service') && cmd === 'import-key-agent') {
      const v = argv[i += 1];
      if (v === undefined || v.startsWith('--')) throw new DeployUsageError(`${a} 要跟一个值`);
      opts[a] = v;
    } else throw new DeployUsageError(`${cmd} 不认识的参数 ${a}`);
  }
  const common = { cmd, inst, dryRun };
  if (cmd === 'machine-id-agent') {
    const script = machineIdScript(inst);
    return { ...common, script, preview: script };
  }
  if (!opts['--file']) throw new DeployUsageError('import-key-agent 要 --file <本机的密文文件>(make-api-share.bat 生成、用户交回的那一整段)');
  const service = opts['--service'] ?? 'model';
  if (!SERVICE_NAME.test(service)) throw new DeployUsageError(`--service 要是服务名(小写字母开头,只含小写字母、数字、-):${service}`);
  const readFile = deps.readFile ?? ((p) => { const st = fs.statSync(p); if (!st.isFile() || st.size > MAX_BLOB_BYTES) throw new Error('不是普通文件,或大得不像密文'); return fs.readFileSync(p, 'utf8'); });
  let raw;
  try { raw = readFile(opts['--file']); } catch (err) { throw new DeployUsageError(`读不了密文文件:${err?.message ?? err}`); }
  const blob = String(raw).replace(/\s+/g, '');
  if (!BLOB_SHAPE.test(blob)) throw new DeployUsageError('这个文件不是一份 PCAI1. 开头的密文(只该含密文那一整段;换行与空格可以有)。');
  const script = importKeyScript(inst, { blob, service });
  return { ...common, script, preview: script.replace(blob, `PCAI1.…(密文 ${blob.length} 字符,预览里不显示)`) };
}
