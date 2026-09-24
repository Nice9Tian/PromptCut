/**
 * 远程主机上的独立文档服务骨架：探测环境、装 Node 与 PM2、部署、查状态。全部经本机的 ssh / scp 完成。
 *
 * 用法：
 *   PROMPTCUT_REMOTE=<user@host> [PROMPTCUT_REMOTE_KEY=<私钥路径>] node scripts/remote/docservice.mjs <命令>
 *
 * 命令：
 *   probe    探测远端：Node 是不是 LTS（偶数大版本且 >= 20）、有没有 PM2、UFW 状态。就绪退出码 0，没就绪 1，连不上 2
 *   install  缺什么装什么：Node 取 nodejs.org 当前最新 LTS 的官方二进制（校验 SHA256 后装到 /usr/local），PM2 用 npm 全局装
 *   deploy   拷 server/docservice（含 modules/）与 server/render-queue 到远端，PM2 启动或重载，放行 SSH 与服务端口后启用 UFW，
 *            最后查 /healthz。远端绑 0.0.0.0，必须带集群令牌：从本机环境变量 PROMPTCUT_CLUSTER_TOKEN 读，没设或格式不对就拒绝部署。
 *            令牌只经 ssh 的标准输入进远端脚本，由它 export 后 pm2 startOrReload --update-env；不上命令行、不回显、不写进仓库
 *            （契约 docs/plan/render-queue-contract.md G.5）。令牌的生成方法见 server/docservice/main.mjs 文件头
 *   status   PM2 里的进程状态、/healthz、UFW 规则
 *
 * 其它环境变量：PROMPTCUT_REMOTE_DIR（远端部署目录，缺省 /opt/promptcut-docservice）、
 * PROMPTCUT_DOCSERVICE_PORT（缺省 8787）。远端需要 root，或能免密 sudo 的用户（install / deploy 里的命令按 root 写）。
 * 具体主机地址与私钥位置是本机信息，写在 docs/local.md，不进仓库。
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { checkTokenFormat } from '../../server/docservice/auth.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const target = process.env.PROMPTCUT_REMOTE;
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
  const sources = ['server/docservice', 'server/render-queue'];
  console.log(`== scp ${sources.join(' ')} -> ${target}:${dir}/`);
  const scp = spawnSync('scp', [...baseOpts, '-r', '-q', ...sources, `${target}:${dir}/.incoming/server/`], { cwd: ROOT, stdio: 'inherit', timeout: 120_000 });
  if (scp.status !== 0) return scp.status ?? 1;
  return sshScript(deployScript(token));
}

const STATUS = String.raw`
pm2 jlist | node -e 'const l=JSON.parse(require("fs").readFileSync(0,"utf8")); for (const p of l) console.log(p.name, p.pm2_env.status, "pid="+p.pid, "restarts="+p.pm2_env.restart_time, "uptime="+Math.round((Date.now()-p.pm2_env.pm_uptime)/1000)+"s")'
echo "== healthz"; curl -fsS "http://127.0.0.1:${port}/healthz"; echo
echo "== ufw"; ufw status
`;

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
  default:
    console.error('命令：probe | install | deploy | status');
    process.exit(2);
}
