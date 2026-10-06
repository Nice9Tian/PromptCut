/**
 * 云端 Agent 服务的部署参数、模板填充与远端脚本(契约 `docs/plan/cloud-agent-contract.md` 第 2.2、10.1、11 节)。
 * 纯函数:`scripts/remote/docservice.mjs` 的 `*-agent` 子命令只负责执行;`--dry-run` 与单测都走这里,不连任何远端。
 *
 * Agent 服务**与渲染服务共用同一份检出**(`<渲染服务的部署目录>/current`,由 `deploy-render` 上传、装依赖、换链接):
 * 它要完整的仓库加依赖(vite 与 `src/`),并且必须与渲染服务、在线页面出自同一个提交(补渲计划的代码版本要对得上)。
 * 所以这里没有上传代码的一步;升级与回退跟着渲染服务的 `current` 走,换完链接再 `deploy-agent` 重载一次。
 *
 * 不含任何秘密:服务私钥在节点上由 `keygen-agent` 生成(不离开节点、不打印),模型 Key 由用户在节点上运行 `set-key.mjs` 录入。
 * 本文件不引用 `src/`。
 */
import { DeployUsageError, renderInstance, fillTemplate, readTemplate, shq } from '../hosted-render/deploy.mjs';

export const AGENT_PM2_TEMPLATE = 'pm2-promptcut-agent.config.cjs';
export const AGENT_COMMANDS = Object.freeze(['deploy-agent', 'status-agent', 'stop-agent', 'keygen-agent']);

const ABS_PATH = /^\/[A-Za-z0-9_./-]*$/;
const path$ = (name, value) => {
  if (typeof value !== 'string' || !ABS_PATH.test(value) || value.includes('..') || value.length > 200) throw new DeployUsageError(`${name} 要是绝对路径(只含字母、数字、_ . / -):${value}`);
  return value.replace(/\/+$/, '') || '/';
};
const preamble = (extra = []) => ['set -euo pipefail', 'set +x', ...extra];

/**
 * 部署参数。缺省值与服务的缺省一致,可用本机的环境变量覆盖:`PROMPTCUT_AGENT_DATA`、`PROMPTCUT_AGENT_SECRETS`、`PROMPTCUT_AGENT_PORT`、
 * `PROMPTCUT_AGENT_DOC_URL`、`PROMPTCUT_AGENT_PUBLIC_ORIGIN`(可空);检出目录与托管数据目录取渲染服务那一套
 * (`PROMPTCUT_RENDER_DIR`、`PROMPTCUT_HOSTED_DATA`)。
 */
export function agentInstance(env = process.env) {
  const render = renderInstance(env);
  const e = (name, fallback) => (env[name] === undefined ? fallback : env[name]);
  const port = Number(e('PROMPTCUT_AGENT_PORT', 8790));
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new DeployUsageError(`PROMPTCUT_AGENT_PORT 要是 1024～65535 的整数:${e('PROMPTCUT_AGENT_PORT')}`);
  const docUrl = e('PROMPTCUT_AGENT_DOC_URL', render.docUrl);
  if (!/^wss?:\/\/[A-Za-z0-9.:[\]-]+(\/[A-Za-z0-9_./-]*)?$/.test(docUrl)) throw new DeployUsageError(`PROMPTCUT_AGENT_DOC_URL 要是 ws:// 或 wss:// 开头的地址:${docUrl}`);
  const origin = e('PROMPTCUT_AGENT_PUBLIC_ORIGIN', '');
  if (origin !== '' && !/^https?:\/\/[A-Za-z0-9.:[\]-]+$/.test(origin)) throw new DeployUsageError(`PROMPTCUT_AGENT_PUBLIC_ORIGIN 要是 http(s)://主机[:端口],不带路径:${origin}`);
  return {
    app: 'promptcut-agent',
    dir: render.dir,
    current: render.current,
    data: path$('PROMPTCUT_AGENT_DATA', e('PROMPTCUT_AGENT_DATA', '/var/lib/promptcut/agent')),
    secrets: path$('PROMPTCUT_AGENT_SECRETS', e('PROMPTCUT_AGENT_SECRETS', '/var/lib/promptcut/agent-secrets')),
    hostedData: render.hostedData,
    docUrl,
    port,
    publicOrigin: origin,
    /** 契约第 11 节:V8 老生代 1536 MiB;常驻内存超过 2 GB 由 PM2 重启;重启前给 8 秒收尾 */
    heapMb: 1536,
    maxMemoryRestart: '2G',
    killTimeoutMs: 8000,
    renderStatusPort: render.statusPort,
  };
}

export function agentTemplateValues(inst) {
  return {
    DIR: inst.dir, DATA: inst.data, SECRETS: inst.secrets, DOC_URL: inst.docUrl, AGENT_PORT: String(inst.port), PUBLIC_ORIGIN: inst.publicOrigin,
    HEAP_MB: String(inst.heapMb), MAX_MEMORY_RESTART: inst.maxMemoryRestart, KILL_TIMEOUT_MS: String(inst.killTimeoutMs),
  };
}

/** PM2 配置(写进 `<检出目录>/pm2-agent.config.cjs`,仓库外;不含任何秘密) */
export function agentPm2Config(inst, { read = readTemplate } = {}) {
  return fillTemplate(read(AGENT_PM2_TEMPLATE), agentTemplateValues(inst));
}

/**
 * `deploy-agent`:建数据目录与私钥目录(0700)、写 PM2 配置、启动或重载、等 `/healthz`。代码不在这里上传(见文件头)。
 * `noStart`:只建目录、写配置(第一次部署:先这样,再 `keygen-agent`,再不带 `--no-start` 跑一次)。
 */
export function agentDeployScript(inst, { save = false, noStart = false, read } = {}) {
  const config = agentPm2Config(inst, { read });
  const lines = preamble([`DIR=${shq(inst.dir)}`, `APP=${shq(inst.app)}`, `DATA=${shq(inst.data)}`, `SECRETS=${shq(inst.secrets)}`, `PORT=${inst.port}`]);
  lines.push(
    'if [ ! -f "$DIR/current/server/agent-service/main.mjs" ]; then echo "检出目录 $DIR/current 里没有 Agent 服务(先 deploy-render:两者共用同一份检出、同一个提交)" >&2; exit 4; fi',
    'if [ ! -d "$DIR/current/node_modules/vite" ]; then echo "检出目录里没有装依赖(deploy-render 没跑完?)" >&2; exit 4; fi',
    'umask 077',
    'mkdir -p "$DATA" "$DATA/tmp" "$SECRETS"',
    'chmod 700 "$DATA" "$SECRETS"',
    `cat > "$DIR/pm2-agent.config.cjs" <<'PROMPTCUT_AGENT_PM2_EOF'`,
    config.trimEnd(),
    'PROMPTCUT_AGENT_PM2_EOF',
    'chmod 600 "$DIR/pm2-agent.config.cjs"',
    'echo "已写 $DIR/pm2-agent.config.cjs;数据目录 $DATA,私钥目录 $SECRETS"',
  );
  if (noStart) {
    lines.push('echo "deploy-agent --no-start:没有动 PM2。接着 keygen-agent,再不带 --no-start 部署一次。"');
    return `${lines.join('\n')}\n`;
  }
  lines.push(
    'if [ ! -f "$SECRETS/service-key.json" ]; then echo "还没有服务私钥($SECRETS/service-key.json):先 keygen-agent" >&2; exit 5; fi',
    'pm2 startOrReload "$DIR/pm2-agent.config.cjs" --update-env',
    'ok=""',
    'for i in $(seq 1 60); do if curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then ok=1; break; fi; sleep 1; done',
    'if [ -z "$ok" ]; then echo "Agent 服务 60 秒内没有应答 /healthz:" >&2; pm2 logs "$APP" --lines 40 --nostream >&2 || true; exit 6; fi',
    'echo "== healthz"; curl -fsS "http://127.0.0.1:$PORT/healthz"; echo',
    'if [ ! -f "$DATA/config/ai.json" ]; then echo "还没有配置模型:对话请求会回 no-model-key。由用户在节点上运行 set-key.mjs 录入(见 README「Agent 服务」)。"; fi',
  );
  if (save) lines.push('pm2 save >/dev/null && echo "pm2 save:已保存(节点重启后自启)"');
  else lines.push('echo "没有 pm2 save:确认运行正常后加 --save 再跑一次,或手工 pm2 save"');
  lines.push('echo "deploy-agent:完成"');
  return `${lines.join('\n')}\n`;
}

/** `status-agent`:PM2、healthz、与渲染服务的代码版本并排、数据目录的占用、有没有配模型(不读 Key) */
export function agentStatusScript(inst) {
  const lines = preamble([`DIR=${shq(inst.dir)}`, `APP=${shq(inst.app)}`, `DATA=${shq(inst.data)}`, `SECRETS=${shq(inst.secrets)}`, `PORT=${inst.port}`, `RENDER_STATUS_PORT=${inst.renderStatusPort}`]);
  lines.push(
    'echo "== pm2"',
    'pm2 describe "$APP" 2>/dev/null | grep -E "status|restarts|uptime|memory|script path|exec cwd" || echo "$APP: not in pm2"',
    'echo "== 检出目录"; echo "current -> $(readlink "$DIR/current" 2>/dev/null || echo 无)"',
    'echo "== healthz"',
    'H="$(curl -fsS "http://127.0.0.1:$PORT/healthz" 2>/dev/null || true)"',
    'if [ -n "$H" ]; then echo "$H"; else echo "端口 $PORT 没回应(pm2 logs $APP --lines 40 --nostream)"; fi',
    'echo "== 代码版本(要与渲染服务、在线页面相同)"',
    'R="$(curl -fsS "http://127.0.0.1:$RENDER_STATUS_PORT/status" 2>/dev/null || true)"',
    'H="$H" R="$R" node -e \'const j=(t)=>{try{return JSON.parse(t)}catch{return null}};const a=j(process.env.H)?.codeVersion??null;const r=j(process.env.R)?.codeVersion?.self??null;const line="agent="+(a??"?")+"  render="+(r??"?");console.log(a&&r&&a!==r?"\\x1b[31m!! "+line+"  不一致:补渲计划渲染服务不会认领,重新部署同一个提交\\x1b[0m":line)\'',
    'echo "== 数据目录"',
    'if [ -d "$DATA" ]; then du -sh "$DATA" 2>/dev/null | cut -f1; echo "对话所在的项目数:$(ls -1 "$DATA/tenants" 2>/dev/null | wc -l)"; ls -1 "$DATA/usage" 2>/dev/null | tail -n 3 || true; else echo "$DATA 不存在"; fi',
    'if [ -f "$DATA/config/ai.json" ]; then echo "模型配置:有($(node -e \'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log((c.vendor??"?")+" / "+String(c.model??"?").split("|")[0])\' "$DATA/config/ai.json" 2>/dev/null || echo 读不了))"; else echo "模型配置:还没有(set-key.mjs)"; fi',
    'if [ -f "$SECRETS/service-key.json" ]; then echo "服务私钥:有"; else echo "服务私钥:没有(keygen-agent)"; fi',
  );
  return `${lines.join('\n')}\n`;
}

/** `stop-agent`:停掉 Agent 服务(`remove`:连 PM2 的登记一起删)。托管服务与渲染服务不动;进行中的对话会记「中断」 */
export function agentStopScript(inst, { remove = false } = {}) {
  return `${preamble([`APP=${shq(inst.app)}`]).concat([
    'if ! pm2 describe "$APP" >/dev/null 2>&1; then echo "$APP 不在 PM2 里"; exit 0; fi',
    remove ? 'pm2 delete "$APP"; echo "$APP:已从 PM2 删除"' : 'pm2 stop "$APP"; echo "$APP:已停(进行中的对话记为中断;pm2 start $APP 或 deploy-agent 可起)"',
    'pm2 save >/dev/null && echo "pm2 save:已保存(节点重启后保持这个状态)"',
  ]).join('\n')}\n`;
}

/** `keygen-agent`:在节点上给服务名 `agent` 生成并登记密钥(私钥不离开节点、不打印);`retire` 撤一把公钥;`list` 看登记表 */
export function agentKeygenScript(inst, { retire = null, list = false, instanceName = null } = {}) {
  if (retire !== null && !/^[A-Za-z0-9_-]{8}$/.test(retire)) throw new DeployUsageError(`--retire 要是 8 个字符的 kid:${retire}`);
  if (instanceName !== null && !/^[^\s'"\\${}`][^'"\\${}`]{0,63}$/.test(instanceName)) throw new DeployUsageError('--instance-name 要是 1～64 个字符,不含引号、反斜杠、$、花括号');
  const args = retire !== null
    ? `--hosted-data ${shq(inst.hostedData)} --service agent --retire ${shq(retire)}`
    : list
      ? `--hosted-data ${shq(inst.hostedData)} --list`
      : `--hosted-data ${shq(inst.hostedData)} --secrets ${shq(inst.secrets)} --service agent${instanceName ? ` --instance-name ${shq(instanceName)}` : ''}`;
  const lines = preamble([`cd ${shq(inst.current)}`]);
  lines.push(
    'if [ ! -f server/hosted-render/keygen.mjs ]; then echo "这个目录里没有 keygen(先 deploy-render --no-start)" >&2; exit 4; fi',
    'umask 077',
    `node server/hosted-render/keygen.mjs ${args}`,
  );
  if (retire === null && !list) {
    lines.push(
      `echo "新的公钥已登记进 ${inst.hostedData}/secrets/services.json(文档服务按文件修改时刻重读,不用重启)。"`,
      'echo "Agent 服务要重启才用新私钥:pm2 restart promptcut-agent(换钥时旧公钥并存,确认新钥生效后 keygen-agent --retire <旧 kid>)"',
    );
  }
  return `${lines.join('\n')}\n`;
}

/** 子命令的计划:参数解析与校验在这里 */
export function planAgentCommand(cmd, argv, env = process.env, deps = {}) {
  const inst = agentInstance(env);
  const flags = new Set();
  const opts = {};
  const valued = new Set(['--retire', '--instance-name']);
  const boolean = new Set(['--save', '--no-start', '--delete', '--list', '--dry-run']);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (valued.has(a)) {
      const v = argv[i += 1];
      if (v === undefined || v.startsWith('--')) throw new DeployUsageError(`${a} 要跟一个值`);
      opts[a] = v;
    } else if (boolean.has(a)) flags.add(a);
    else throw new DeployUsageError(`不认识的参数 ${a}`);
  }
  const allow = {
    'deploy-agent': ['--save', '--no-start', '--dry-run'],
    'status-agent': ['--dry-run'],
    'stop-agent': ['--delete', '--dry-run'],
    'keygen-agent': ['--retire', '--list', '--instance-name', '--dry-run'],
  }[cmd];
  if (!allow) throw new DeployUsageError(`不认识的命令 ${cmd}`);
  for (const a of [...flags, ...Object.keys(opts)]) if (!allow.includes(a)) throw new DeployUsageError(`${cmd} 不收 ${a}`);
  const common = { cmd, inst, dryRun: flags.has('--dry-run') };
  switch (cmd) {
    case 'deploy-agent': return { ...common, script: agentDeployScript(inst, { save: flags.has('--save'), noStart: flags.has('--no-start'), read: deps.read }) };
    case 'status-agent': return { ...common, script: agentStatusScript(inst) };
    case 'stop-agent': return { ...common, script: agentStopScript(inst, { remove: flags.has('--delete') }) };
    default: return { ...common, script: agentKeygenScript(inst, { retire: opts['--retire'] ?? null, list: flags.has('--list'), instanceName: opts['--instance-name'] ?? null }) };
  }
}
