/**
 * 远程主机上的独立文档服务骨架：探测环境、装 Node 与 PM2、部署、查状态。全部经本机的 ssh / scp 完成。
 *
 * 云端 Agent 服务（契约 docs/plan/cloud-agent-contract.md 第 2.2 节；参数、模板与远端脚本在 server/agent-service/deploy.mjs）。
 * PM2 应用 promptcut-agent。与渲染服务共用同一份检出（deploy-render 放上去的 current），所以没有上传代码的一步；三者同一个提交。
 *   keygen-agent [--list | --retire <kid>] [--instance-name <名>]   在节点上给服务名 agent 生成并登记密钥（私钥不离开节点、不打印）
 *   deploy-agent [--save] [--no-start]   建数据目录与私钥目录、写 PM2 配置、启动或重载、等 /healthz。--no-start：只建目录写配置
 *   status-agent     PM2、/healthz、与渲染服务的代码版本并排（不一致标红）、数据目录、有没有配模型（不读 Key）
 *   stop-agent [--delete]   pm2 stop 并 pm2 save；托管服务与渲染服务不动
 *   四个都收 --dry-run：只打印要交给远端的脚本，不连任何远端。
 *   模型 Key（及配音等别的外部服务的 Key）走加密分发（任务书 F；步骤与原理在 server/agent-service/service-keys.mjs 文件头）：
 *   machine-id-agent                                       在节点上跑 machine-id.mjs，取回节点的机器识别码（用户用它在自己的电脑上、用 make-api-share.bat 生成密文）
 *   import-key-agent --file <本机的密文文件> [--service model|voice]   把用户交回的密文经 ssh 标准输入送到节点、在节点本机解开并导入（import-key.mjs），导入完删掉临时文件
 *   这两个也收 --dry-run（预览里密文只显示开头与长度）。全程只接触密文：明文 Key 不经本脚本，不进命令行、日志与仓库。
 *
 * 用法：
 *   PROMPTCUT_REMOTE=<user@host> [PROMPTCUT_REMOTE_KEY=<私钥路径>] node scripts/remote/docservice.mjs <命令>
 *
 * 命令：
 *   probe    探测远端：Node 是不是 LTS（偶数大版本且 >= 20）、有没有 PM2、UFW 状态。就绪退出码 0，没就绪 1，连不上 2
 *   install  缺什么装什么：Node 取 nodejs.org 当前最新 LTS 的官方二进制（校验 SHA256 后装到 /usr/local），PM2 用 npm 全局装
 *   deploy   拷 server/docservice（含 modules/）、server/auth 与 server/render-queue 到远端，PM2 启动或重载，放行 SSH 与服务端口后启用 UFW，
 *            最后查 /healthz。远端绑 0.0.0.0，必须带集群令牌：从本机环境变量 PROMPTCUT_CLUSTER_TOKEN 读，没设或格式不对就拒绝部署。
 *            令牌只经 ssh 的标准输入进远端脚本，由它 export 后 pm2 startOrReload --update-env；不上命令行、不回显、不写进仓库
 *            （契约 docs/plan/render-queue-contract.md G.5）。令牌的生成方法见 server/docservice/main.mjs 文件头
 *   status   PM2 里的进程状态、/healthz、UFW 规则
 *
 * 托管组合（SP，契约 docs/plan/shared-project-contract.md 第 1、2 节；文件清单见 server/hosted/files.mjs 与契约第 10 节）：
 *   deploy-hosted [--instance drill] [--save] [--replace-docservice] [--write-token]
 *                 [--editor <dist-online 目录>] [--doc-public-url <url>] [--asset-public-url <url>] [--stage-origins <A>,<B>]
 *            在本机按清单拼暂存目录，整个拷到远端 <部署目录>/.incoming 再换成 <部署目录>/app；
 *            在部署目录里写 PM2 配置 <部署目录>/pm2.config.cjs（仓库外，不含任何秘密），pm2 startOrReload，
 *            最后查两个端口的 /healthz。**不改防火墙**：UFW 放行由主会话在服务器上手工加。
 *            - 缺省实例：app promptcut-hosted，端口 8787 / 8788，部署目录 /opt/promptcut-hosted，
 *              数据目录 /var/lib/promptcut/hosted，max_memory_restart 700M；
 *            - --instance drill（M8 迁移演练）：app promptcut-drill，端口 8777 / 8778，部署目录 /opt/promptcut-drill，
 *              数据目录 /var/lib/promptcut/drill，max_memory_restart 400M；
 *            - 数据目录与 secrets/ 不存在就建（0700）；已有的不动。集群令牌放在 <数据目录>/secrets/cluster-token（0600），
 *              随数据目录迁移，不进 PM2 配置。--write-token：把本机环境变量 PROMPTCUT_CLUSTER_TOKEN 经 ssh 标准输入写进这个文件；
 *            - PM2 配置写 PROMPTCUT_TRUST_LOOPBACK=0（docs/plan/http-transport-contract.md 第 10、12 节：托管端在 nginx 之后，
 *              代理转进来的请求看上去都是回环，关掉本机信任）。这时必须有集群令牌：远端没有 secrets/cluster-token、
 *              也没给 --write-token 时部署脚本在换进程之前停手（退出码 5）；
 *            - 旧的独立文档服务（app promptcut-docservice）还在 PM2 里时拒绝部署缺省实例（退出码 3），
 *              加 --replace-docservice 才先 pm2 delete 它（它的部署目录与数据不动）；
 *            - --save：成功后 pm2 save。
 *            - --editor <目录>（C10a 契约第 3 节）：把在线构建（`npx vite build --mode online` 的 dist-online/）拷成
 *              <部署目录>/.incoming-editor，远端再整体换名成 <部署目录>/editor/；旧版 assets/ 保留一代（server/hosted/deploy.mjs 的
 *              editorSwapLines）。拷之前在本机暂存目录里给 assets/ 下大于 1 KB 的 js/mjs/css/json/svg/wasm 生成同名 .gz
 *              （stageEditorBuild；nginx 的 /editor/assets/ 开 gzip_static，带 Content-Length 发、不分块）。nginx 的 /editor 路由由主会话手工加；
 *            - --doc-public-url / --asset-public-url（C10a 契约第 3 节）：写进 PM2 配置的两个公网地址（阿里云上是
 *              wss://<域名>/hosted/ 与 https://<域名>/media/api/asset）；不给才按 PROMPTCUT_PUBLIC_HOST 拼 ws://…:8787、http://…:8788/api/asset。
 *              文档服务公网地址的源也是邀请链接的源（<源>/editor#invite=…）。
 *            - --stage-origins <A>,<B>（C10 契约第 2 节）：在线普通档两个舞台的源（阿里云上是 https://s1.<主机>,https://s2.<主机>），
 *              写进 <部署目录>/editor/runtime-config.json（`{ v: 1, stageOrigins: [A, B] }`），页面从这里取舞台源；之后只给 --editor 换代时
 *              这个文件照样保留。只改脚本与运行配置：两个子域的 DNS、证书、nginx（舞台页与 /media 反代、三方的 Origin-Agent-Cluster: ?1）
 *              由主会话部署时做；
 *            环境变量：PROMPTCUT_HOSTED_DIR、PROMPTCUT_HOSTED_DATA 覆盖部署目录与数据目录；
 *            PROMPTCUT_PUBLIC_HOST 是写进公网地址的主机名，缺省取 PROMPTCUT_REMOTE 里 @ 后面的部分。
 *   status-hosted [--instance drill]   PM2 里这个 app 的状态、两个端口的 /healthz、数据目录占用、UFW 里这两个端口的规则
 *   stage-hosted <本机目录>   只在本机按清单拼暂存目录（不连远端），用来核对清单
 *
 * 托管方的渲染服务（契约 docs/plan/hosted-render-contract.md 第 7 节；参数、模板与远端脚本在 server/hosted-render/deploy.mjs，
 * 模板在 server/hosted/deploy/）。PM2 应用 promptcut-render，部署目录 /opt/promptcut-render，按提交分目录、切 current 链接升级与回退。
 * 所有子命令都收 --dry-run：只在本机打出会做什么与要交给远端的脚本，不连任何远端（也不需要 PROMPTCUT_REMOTE）。
 *   install-render [--with-build-tools]   装系统包（中文字体、ffmpeg、Chrome 的运行库）、建服务用户 promptcut-render 与目录、写 systemd slice
 *            （没有 systemd 的机器跳过 slice，打一行说明）。可反复跑。--with-build-tools：npm ci 要编译原生模块时才加
 *   deploy-render [--commit <引用>] [--save] [--no-start] [--keep <n>]
 *            把仓库在这个提交（缺省 HEAD）的完整内容 git archive 打包传到远端 <部署目录>/releases/<提交前 12 位>/（工作区未提交的改动不上传），
 *            远端 npm ci、装 chrome-headless-shell、用新的 PM2 配置跑 --check；**自检过了才换 current 并 pm2 startOrReload**，
 *            没过（退出码 78）什么都不换。--save：成功后 pm2 save（节点重启后自动起来要靠它）；pm2-<用户>.service 没装时装一个（有 systemd 才装）。
 *            --no-start：只解包装依赖、换 current、写配置，不跑也不卡自检、不动 PM2（第一次部署：先这样，再 keygen-render，再不带 --no-start 部署一次）。
 *            **渲染服务必须与在线页面出自同一个提交**，否则它一个任务也认领不了（诊断口的 codeVersion 与 status-render 会标出）。
 *   status-render    PM2、发布目录（current / previous）、诊断口 /status（代码版本并排，不一致标红）、资源组、产物容量记账
 *   stop-render [--delete]   pm2 stop（--delete：连登记一起删）并 pm2 save；托管服务不动
 *   rollback-render [--to <发布目录名>]   current 换回上一份（或指定的一份）再重载
 *   keygen-render [--list | --retire <kid>] [--instance-name <名>] [--release <发布目录名>]
 *            在节点上生成服务密钥并登记公钥（私钥不离开节点、不打印）；--retire 撤旧钥；--list 看登记表
 *   环境变量：PROMPTCUT_RENDER_DIR、PROMPTCUT_RENDER_DATA、PROMPTCUT_RENDER_SECRETS、PROMPTCUT_HOSTED_DATA、PROMPTCUT_RENDER_DOC_URL、
 *            PROMPTCUT_RENDER_PORT、PROMPTCUT_RENDER_STATUS_PORT、PROMPTCUT_RENDER_MAX_CONCURRENT、PROMPTCUT_RENDER_MAX_PROJECTS、
 *            PROMPTCUT_RENDER_MEMORY_MAX / _MEMORY_HIGH、PROMPTCUT_RENDER_CPU_QUOTA、PROMPTCUT_RENDER_USER、PROMPTCUT_RENDER_USER_CARDS、
 *            PROMPTCUT_RENDER_EDITOR_DIR（见 deploy.mjs 的 renderInstance）
 *
 * 其它环境变量：PROMPTCUT_REMOTE_DIR（远端部署目录，缺省 /opt/promptcut-docservice）、
 * PROMPTCUT_DOCSERVICE_PORT（缺省 8787）。远端需要 root，或能免密 sudo 的用户（install / deploy 里的命令按 root 写）。
 * 具体主机地址与私钥位置是本机信息，写在 docs/local.md，不进仓库。
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { checkTokenFormat } from '../../server/docservice/auth.mjs';
import { stageHostedFiles } from '../../server/hosted/files.mjs';
import { hostedInstance, hostedPm2Config, hostedDeployScript, checkPublicUrl, checkStageOrigins, stageEditorBuild, shq } from '../../server/hosted/deploy.mjs';
import { planRenderCommand, RENDER_COMMANDS, DeployUsageError } from '../../server/hosted-render/deploy.mjs';
import { planAgentCommand, AGENT_COMMANDS } from '../../server/agent-service/deploy.mjs';
import { planKeyCommand, KEY_COMMANDS } from '../../server/agent-service/key-deploy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const target = process.env.PROMPTCUT_REMOTE;
const argv = process.argv.slice(3);
const flag = (name) => argv.includes(name);
const option = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const key = process.env.PROMPTCUT_REMOTE_KEY;
const dir = process.env.PROMPTCUT_REMOTE_DIR ?? '/opt/promptcut-docservice';
const port = Number(process.env.PROMPTCUT_DOCSERVICE_PORT ?? 8787);
const cmd = process.argv[2];

const baseOpts = [
  ...(key ? ['-i', key, '-o', 'IdentitiesOnly=yes'] : []),
  '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=accept-new',
];

/** 跑一条远端命令，输出收回来 */
function ssh(remoteCmd, { timeout = 30_000 } = {}) {
  const r = spawnSync('ssh', [...baseOpts, target, remoteCmd], { encoding: 'utf8', timeout });
  return { code: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

/** 把一段 bash 脚本经 stdin 交给远端执行，输出直接打到本机终端 */
function sshScript(script, { timeout = 600_000 } = {}) {
  const r = spawnSync('ssh', [...baseOpts, target, 'bash -s'], { input: script, stdio: ['pipe', 'inherit', 'inherit'], timeout });
  return r.status ?? 1;
}

function probe() {
  const conn = ssh('echo ok; uname -srm; . /etc/os-release && echo "$PRETTY_NAME"; id -un');
  if (conn.code !== 0 || !conn.out.startsWith('ok')) {
    return { stage: 'connect', ok: false, code: conn.code, stderr: conn.err };
  }
  const [, kernel, os, user] = conn.out.split('\n');
  const node = ssh('command -v node >/dev/null && node -v || echo MISSING').out;
  const npm = ssh('command -v npm >/dev/null && npm -v || echo MISSING').out;
  const pm2 = ssh('command -v pm2 >/dev/null && pm2 -v 2>/dev/null | tail -n1 || echo MISSING').out;
  const ufw = ssh('command -v ufw >/dev/null && ufw status | head -n1 || echo MISSING').out;
  const major = Number(/^v(\d+)\./.exec(node)?.[1]);
  const nodeLts = major >= 20 && major % 2 === 0;
  return { stage: 'probe', ok: true, target, kernel, os, user, node, nodeLts, npm, pm2, ufw, ready: nodeLts && pm2 !== 'MISSING' };
}

const INSTALL = String.raw`
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
command -v curl >/dev/null && command -v xz >/dev/null || { apt-get update -qq && apt-get install -y -qq curl xz-utils ca-certificates; }
major=$(command -v node >/dev/null && node -p 'process.versions.node.split(".")[0]' || echo 0)
if [ "$major" -lt 20 ] || [ $((major % 2)) -ne 0 ]; then
  # 最新 LTS：index.json 里第一条 lts 不为 false 的
  VER=$(curl -fsSL https://nodejs.org/dist/index.json | python3 -c 'import json,sys; print(next(r["version"] for r in json.load(sys.stdin) if r["lts"]))')
  TAR="node-$VER-linux-x64.tar.xz"
  echo "== installing Node $VER"
  cd /tmp
  curl -fsSLO "https://nodejs.org/dist/$VER/$TAR"
  curl -fsSLO "https://nodejs.org/dist/$VER/SHASUMS256.txt"
  grep " $TAR\$" SHASUMS256.txt | sha256sum -c -
  tar -xJf "$TAR" -C /usr/local --strip-components=1 --no-same-owner
  rm -f "$TAR" SHASUMS256.txt
  hash -r
fi
echo "node $(node -v)  npm $(npm -v)"
if ! command -v pm2 >/dev/null; then
  echo "== installing pm2"
  npm install -g pm2@latest --no-fund --no-audit --loglevel=error
fi
echo "pm2 $(pm2 -v | tail -n1)"
`;

/** 经 ssh 标准输入交给远端 bash 的部署脚本。令牌只出现在这段文本里（已校验只含 base64url 字符，放进单引号是安全的） */
function deployScript(token) {
  return String.raw`
set -euo pipefail
set +x
cd '${dir}'
# 新代码先落在 .incoming，整目录换上去，避免 PM2 重载时读到拷了一半的文件
rm -rf server.prev
if [ -d server ]; then mv server server.prev; fi
mv .incoming/server server
rmdir .incoming
rm -rf server.prev

export PROMPTCUT_DOCSERVICE_PORT=${port}
export PROMPTCUT_CLUSTER_TOKEN='${token}'
pm2 startOrReload server/docservice/ecosystem.config.cjs --update-env
pm2 save
# 开机自启：systemd 里还没有 pm2 的单元就装一个
if ! systemctl is-enabled "pm2-$(id -un)" >/dev/null 2>&1; then
  pm2 startup systemd -u "$(id -un)" --hp "$HOME" >/dev/null
  echo "pm2 startup: installed pm2-$(id -un).service"
fi

echo "== listening TCP ports before firewall change"
ss -ltnH | awk '{print $4}' | sort -u
# 防火墙：先放行当前这条 SSH 用的端口，再启用，否则会把自己锁在外面
SSH_PORT="${'$'}{SSH_CONNECTION##* }"
ufw allow "${'$'}SSH_PORT/tcp" comment 'ssh' >/dev/null
ufw allow ${port}/tcp comment 'promptcut-docservice' >/dev/null
ufw --force enable >/dev/null
ufw status numbered

echo "== healthz"
for i in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:${port}/healthz"; then echo; exit 0; fi
  sleep 0.5
done
echo "healthz did not respond" >&2
pm2 logs promptcut-docservice --lines 40 --nostream >&2 || true
exit 1
`;
}

function deploy() {
  const token = process.env.PROMPTCUT_CLUSTER_TOKEN;
  if (token === undefined || token === '') {
    console.error('缺 PROMPTCUT_CLUSTER_TOKEN：远端绑 0.0.0.0，没有集群令牌不部署（生成方法见 server/docservice/main.mjs 文件头）');
    return 1;
  }
  if (!checkTokenFormat(token)) {
    console.error('PROMPTCUT_CLUSTER_TOKEN 格式不对：要 32～256 个 base64url 字符');
    return 1;
  }
  const p = probe();
  if (!p.ready) {
    console.log(JSON.stringify(p, null, 2));
    console.error('远端环境没就绪，先跑 install');
    return 1;
  }
  const prep = ssh(`mkdir -p '${dir}' && rm -rf '${dir}/.incoming' && mkdir -p '${dir}/.incoming/server'`);
  if (prep.code !== 0) {
    console.error(prep.err);
    return 1;
  }
  // 相对路径 + cwd：Windows 的绝对路径带盘符冒号，scp 会把 `C:` 当成主机名
  const sources = ['server/docservice', 'server/auth', 'server/render-queue'];
  console.log(`== scp ${sources.join(' ')} -> ${target}:${dir}/`);
  const scp = spawnSync('scp', [...baseOpts, '-r', '-q', ...sources, `${target}:${dir}/.incoming/server/`], { cwd: ROOT, stdio: 'inherit', timeout: 120_000 });
  if (scp.status !== 0) return scp.status ?? 1;
  return sshScript(deployScript(token));
}

/* ------------------------------------------------------------------ *
 * 托管组合（SP）：参数与远端脚本在 server/hosted/deploy.mjs
 * ------------------------------------------------------------------ */

/** `--editor <目录>`：在线构建目录要有 index.html 与 assets/（`vite build --mode online` 的产物） */
function editorDirOf(dirArg) {
  if (dirArg === undefined) return null;
  const abs = path.resolve(dirArg);
  if (!fs.existsSync(path.join(abs, 'index.html')) || !fs.existsSync(path.join(abs, 'assets'))) {
    throw new Error(`--editor ${abs} 不像在线构建（要有 index.html 与 assets/；先跑 npx vite build --mode online）`);
  }
  return abs;
}

function deployHosted() {
  const inst = hostedInstance(option('--instance', 'main'));
  const publicHost = process.env.PROMPTCUT_PUBLIC_HOST || String(target).split('@').pop();
  let urls;
  let editorDir;
  let runtimeConfig;
  try {
    urls = {
      docPublicUrl: checkPublicUrl(option('--doc-public-url'), 'doc'),
      assetPublicUrl: checkPublicUrl(option('--asset-public-url'), 'asset'),
    };
    editorDir = editorDirOf(option('--editor'));
    runtimeConfig = checkStageOrigins(option('--stage-origins')) ?? null;
  } catch (err) {
    console.error(err.message);
    return 1;
  }
  let token = null;
  if (flag('--write-token')) {
    token = process.env.PROMPTCUT_CLUSTER_TOKEN ?? '';
    if (!checkTokenFormat(token)) {
      console.error('--write-token 要本机环境变量 PROMPTCUT_CLUSTER_TOKEN（32～256 个 base64url 字符）');
      return 1;
    }
  }
  const p = probe();
  if (!p.ready) {
    console.log(JSON.stringify(p, null, 2));
    console.error('远端环境没就绪，先跑 install');
    return 1;
  }
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-hosted-stage-'));
  try {
    const files = stageHostedFiles(ROOT, path.join(stage, '.incoming'));
    const prep = ssh(`mkdir -p ${shq(inst.dir)} && rm -rf ${shq(`${inst.dir}/.incoming`)} ${shq(`${inst.dir}/.incoming-editor`)}`);
    if (prep.code !== 0) {
      console.error(prep.err);
      return 1;
    }
    console.log(`== scp ${files.length} 个文件 -> ${target}:${inst.dir}/.incoming（实例 ${inst.name}，app ${inst.app}）`);
    // 相对路径 + cwd：Windows 的绝对路径带盘符冒号，scp 会把 C: 当成主机名
    const scp = spawnSync('scp', [...baseOpts, '-r', '-q', '.incoming', `${target}:${inst.dir}/`], { cwd: stage, stdio: 'inherit', timeout: 180_000 });
    if (scp.status !== 0) return scp.status ?? 1;
    if (editorDir) {
      // 在线构建：先在本机暂存目录里拷一份、给 assets/ 生成 .gz（stageEditorBuild），再拷成 .incoming-editor，远端脚本再整体换名（C10a 契约第 3 节）
      const { gz } = stageEditorBuild(editorDir, path.join(stage, '.incoming-editor'));
      console.log(`== 预压缩 ${gz.length} 个 assets（.gz）`);
      console.log(`== scp 在线构建 ${editorDir} -> ${target}:${inst.dir}/.incoming-editor`);
      const up = spawnSync('scp', [...baseOpts, '-r', '-q', '.incoming-editor', `${target}:${inst.dir}/.incoming-editor`], { cwd: stage, stdio: 'inherit', timeout: 180_000 });
      if (up.status !== 0) return up.status ?? 1;
    }
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
  return sshScript(hostedDeployScript(inst, {
    pm2Config: hostedPm2Config(inst, publicHost, urls),
    save: flag('--save'),
    replaceDocservice: flag('--replace-docservice'),
    token,
    editor: !!editorDir,
    runtimeConfig,
  }));
}

function statusHosted() {
  const inst = hostedInstance(option('--instance', 'main'));
  const script = [
    `pm2 describe ${shq(inst.app)} | grep -E "status|restarts|uptime|memory|script path|exec mode" || echo "${inst.app}: not in pm2"`,
    `echo "== docservice healthz"; curl -fsS "http://127.0.0.1:${inst.docPort}/healthz"; echo`,
    `echo "== asset healthz"; curl -fsS "http://127.0.0.1:${inst.assetPort}/healthz"; echo`,
    `echo "== disk"; du -sh ${shq(inst.data)} 2>/dev/null || true; df -h ${shq(inst.data)} 2>/dev/null | tail -n1 || true`,
    `echo "== ufw"; ufw status | grep -E "${inst.docPort}|${inst.assetPort}" || echo "(UFW 里没有这两个端口的规则)"`,
  ].join('\n');
  return sshScript(`${script}\n`, { timeout: 30_000 });
}

/* ------------------------------------------------------------------ *
 * 托管方的渲染服务：参数、模板与远端脚本在 server/hosted-render/deploy.mjs
 * ------------------------------------------------------------------ */

/** 本机把 `--commit` 的引用解析成完整提交号（git 在仓库根里跑） */
function resolveCommit(ref) {
  const r = spawnSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new DeployUsageError(`解析不了提交 ${ref}：${(r.stderr ?? '').trim()}`);
  return r.stdout.trim();
}

function printDryRun(plan) {
  const show = (title, body) => console.log(`\n=== ${title} ===\n${body}`);
  console.log(`[dry-run] ${plan.cmd}（不连任何远端）`);
  console.log(JSON.stringify({ app: plan.inst.app, dir: plan.inst.dir, data: plan.inst.data, secrets: plan.inst.secrets, user: plan.inst.user, slice: plan.inst.slice, statusPort: plan.inst.statusPort, workerPort: plan.inst.workerPort, ...(plan.id ? { commit: plan.commit, release: plan.id } : {}) }, null, 2));
  if (plan.upload) {
    show('本机要做的', [
      `git archive --format=tar.gz -o <暂存目录>/${plan.upload.archive} ${plan.commit}`,
      `scp <暂存目录>/${plan.upload.archive} <user@host>:${plan.upload.remote}`,
    ].join('\n'));
  }
  show('经 ssh 标准输入交给远端 bash 的脚本', plan.script.trimEnd());
}

/** 渲染服务的六个子命令：解析在 planRenderCommand 里，这里只负责执行 */
function runRender(cmd) {
  let plan;
  try {
    plan = planRenderCommand(cmd, argv, process.env, { resolveCommit });
  } catch (err) {
    if (err instanceof DeployUsageError) { console.error(err.message); return 2; }
    throw err;
  }
  if (plan.dryRun) { printDryRun(plan); return 0; }
  if (cmd === 'deploy-render') {
    const p = probe();
    if (!p.ready) {
      console.log(JSON.stringify(p, null, 2));
      console.error('远端环境没就绪（要 Node LTS 与 PM2），先跑 install');
      return 1;
    }
    console.log(`== 提交 ${plan.commit}（发布目录 ${plan.id}）；按提交部署，工作区没提交的改动不会上传。渲染服务必须与在线页面出自同一个提交。`);
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-render-stage-'));
    try {
      const made = spawnSync('git', ['archive', '--format=tar.gz', '-o', path.join(stage, plan.upload.archive), plan.commit], { cwd: ROOT, stdio: 'inherit', windowsHide: true, timeout: 300_000 });
      if (made.status !== 0) { console.error('git archive 失败'); return made.status ?? 1; }
      const size = fs.statSync(path.join(stage, plan.upload.archive)).size;
      const prep = ssh(`mkdir -p ${shq(plan.inst.dir)}`);
      if (prep.code !== 0) { console.error(prep.err); return 1; }
      console.log(`== scp ${plan.upload.archive}（${(size / 1048576).toFixed(1)} MB）-> ${target}:${plan.inst.dir}/`);
      // 相对路径 + cwd：Windows 的绝对路径带盘符冒号，scp 会把 C: 当成主机名
      const up = spawnSync('scp', [...baseOpts, '-q', plan.upload.archive, `${target}:${plan.inst.dir}/`], { cwd: stage, stdio: 'inherit', timeout: 600_000, windowsHide: true });
      if (up.status !== 0) return up.status ?? 1;
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
    return sshScript(plan.script, { timeout: 1_800_000 });
  }
  return sshScript(plan.script, { timeout: cmd === 'install-render' ? 900_000 : 120_000 });
}

/**
 * 云端 Agent 服务的四个子命令(契约 docs/plan/cloud-agent-contract.md 第 2.2 节;参数、模板与远端脚本在 server/agent-service/deploy.mjs)。
 * 代码不在这里上传:Agent 服务与渲染服务共用 deploy-render 放上去的那份检出(同一个提交)。
 */
function runAgent(cmd) {
  let plan;
  try {
    plan = planAgentCommand(cmd, argv, process.env);
  } catch (err) {
    if (err instanceof DeployUsageError) { console.error(err.message); return 2; }
    throw err;
  }
  if (plan.dryRun) {
    console.log(`[dry-run] ${plan.cmd}(不连任何远端)`);
    console.log(JSON.stringify({ app: plan.inst.app, checkout: plan.inst.current, data: plan.inst.data, secrets: plan.inst.secrets, port: plan.inst.port, docUrl: plan.inst.docUrl, heapMb: plan.inst.heapMb, maxMemoryRestart: plan.inst.maxMemoryRestart }, null, 2));
    console.log(`
=== 经 ssh 标准输入交给远端 bash 的脚本 ===
${plan.script.trimEnd()}`);
    return 0;
  }
  return sshScript(plan.script, { timeout: 180_000 });
}

/** 模型 Key 的两个子命令（任务书 F；计划在 server/agent-service/key-deploy.mjs）。密文只经 ssh 标准输入进远端脚本 */
function runKey(cmd) {
  let plan;
  try {
    plan = planKeyCommand(cmd, argv, process.env);
  } catch (err) {
    if (err instanceof DeployUsageError) { console.error(err.message); return 2; }
    throw err;
  }
  if (plan.dryRun) {
    console.log(`[dry-run] ${plan.cmd}(不连任何远端)`);
    console.log(JSON.stringify({ app: plan.inst.app, checkout: plan.inst.current, data: plan.inst.data }, null, 2));
    console.log(`
=== 经 ssh 标准输入交给远端 bash 的脚本(预览:密文只显示开头与长度) ===
${plan.preview.trimEnd()}`);
    return 0;
  }
  return sshScript(plan.script, { timeout: 120_000 });
}

const STATUS = String.raw`
pm2 jlist | node -e 'const l=JSON.parse(require("fs").readFileSync(0,"utf8")); for (const p of l) console.log(p.name, p.pm2_env.status, "pid="+p.pid, "restarts="+p.pm2_env.restart_time, "uptime="+Math.round((Date.now()-p.pm2_env.pm_uptime)/1000)+"s")'
echo "== healthz"; curl -fsS "http://127.0.0.1:${port}/healthz"; echo
echo "== ufw"; ufw status
`;

if (cmd === 'stage-hosted') {
  const out = process.argv[3];
  if (!out) {
    console.error('用法：node scripts/remote/docservice.mjs stage-hosted <本机目录>');
    process.exit(2);
  }
  const files = stageHostedFiles(ROOT, out);
  console.log(JSON.stringify({ ok: true, dir: path.resolve(out), files: files.length }));
  process.exit(0);
}
if (RENDER_COMMANDS.includes(cmd) && flag('--dry-run')) process.exit(runRender(cmd));
if (AGENT_COMMANDS.includes(cmd) && flag('--dry-run')) process.exit(runAgent(cmd));
if (KEY_COMMANDS.includes(cmd) && flag('--dry-run')) process.exit(runKey(cmd));
if (!target) {
  console.error('缺 PROMPTCUT_REMOTE（形如 root@1.2.3.4），用法见文件头');
  process.exit(2);
}
switch (cmd) {
  case 'probe': {
    const p = probe();
    console.log(JSON.stringify(p, null, 2));
    process.exit(p.ok ? (p.ready ? 0 : 1) : 2);
    break;
  }
  case 'install':
    process.exit(sshScript(INSTALL));
    break;
  case 'deploy':
    process.exit(deploy());
    break;
  case 'status':
    process.exit(sshScript(STATUS, { timeout: 30_000 }));
    break;
  case 'deploy-hosted':
    process.exit(deployHosted());
    break;
  case 'status-hosted':
    process.exit(statusHosted());
    break;
  case 'install-render':
  case 'deploy-render':
  case 'status-render':
  case 'stop-render':
  case 'rollback-render':
  case 'keygen-render':
    process.exit(runRender(cmd));
    break;
  case 'deploy-agent':
  case 'status-agent':
  case 'stop-agent':
  case 'keygen-agent':
    process.exit(runAgent(cmd));
    break;
  case 'machine-id-agent':
  case 'import-key-agent':
    process.exit(runKey(cmd));
    break;
  default:
    console.error('命令：probe | install | deploy | status | deploy-hosted [--instance drill] | status-hosted [--instance drill] | stage-hosted <目录> | install-render | deploy-render | status-render | stop-render | rollback-render | keygen-render（渲染服务的都收 --dry-run）| deploy-agent | status-agent | stop-agent | keygen-agent（Agent 服务的都收 --dry-run）| machine-id-agent | import-key-agent --file <密文文件> [--service model|voice]（模型 Key 的加密分发，都收 --dry-run）');
    process.exit(2);
}
