/**
 * 托管方管理云端 Agent 的额度、查用量的命令(契约 `docs/plan/cloud-agent-contract.md` 第 6.1、6.3 节)。
 * 它只改 `<数据目录>/config/limits.json`、只读 `<数据目录>/usage/` 下的流水;运行中的服务每次过闸前看文件有没有变,
 * 所以**发上限、撤上限都不用重启服务**。
 *
 *   PROMPTCUT_AGENT_DATA=<数据目录> node server/agent-service/admin.mjs <命令>
 *
 *   quota show [<projectId>]                              看额度配置(不给项目就看整份)
 *   quota set <projectId> --tokens <N> [--window total|month|day] [--runs <同时进行的一轮数>]
 *   quota clear <projectId>                               去掉这个项目的额度(回到缺省:不限)
 *   usage [--project <projectId>] [--since <日期或毫秒>] [--json]
 *                                                         按项目、成员、模型汇总用量(可跨项目)
 *
 * 额度按输入加输出的 token 数算;窗口 total 是累计,month、day 按 UTC。本文件不引用 `src/`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { limitsFileOf, QUOTA_WINDOWS, readLimitsFile, writeLimitsFile } from '../agent/service/gate.mjs';
import { queryUsage } from '../agent/service/usage.mjs';

const PROJECT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

class Quit extends Error {}

function flags(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--json') out.json = true;
    else if (a.startsWith('--')) { out[a.slice(2)] = args[i + 1]; i += 1; }
    else out._.push(a);
  }
  return out;
}

function sinceOf(text) {
  if (text === undefined) return null;
  const n = /^\d{10,}$/.test(text) ? Number(text) : Date.parse(text);
  if (!Number.isFinite(n)) throw new Quit(`--since 看不懂:${text}(写日期如 2026-10-01,或毫秒时间戳)`);
  return n;
}

/**
 * @param {string[]} argv 命令行参数(不含 node 与脚本名)
 * @returns {number} 退出码
 */
export function runAdmin(argv, { env = process.env, stdout = process.stdout } = {}) {
  const say = (line) => stdout.write(`${line}\n`);
  try {
    const dataDir = env.PROMPTCUT_AGENT_DATA;
    if (!dataDir) throw new Quit('请用环境变量 PROMPTCUT_AGENT_DATA 指出 Agent 服务的数据目录。');
    if (!fs.existsSync(dataDir)) throw new Quit(`数据目录不存在:${dataDir}`);
    const [cmd, ...rest] = argv;
    const file = limitsFileOf(dataDir);

    if (cmd === 'quota') {
      const [sub, ...more] = rest;
      const f = flags(more);
      const projectId = f._[0];
      if (sub === 'show') {
        const raw = readLimitsFile(file);
        say(JSON.stringify(projectId ? (raw.projects?.[projectId] ?? null) : raw, null, 2));
        return 0;
      }
      if (!projectId || !PROJECT_ID_RE.test(projectId)) throw new Quit('要给项目号。');
      const raw = readLimitsFile(file);
      raw.projects = raw.projects && typeof raw.projects === 'object' ? raw.projects : {};
      if (sub === 'set') {
        const tokens = Number(f.tokens);
        if (!Number.isSafeInteger(tokens) || tokens < 0) throw new Quit('--tokens 要是非负整数。');
        const window = f.window ?? raw.projects[projectId]?.window ?? 'total';
        if (!QUOTA_WINDOWS.includes(window)) throw new Quit(`--window 只能是 ${QUOTA_WINDOWS.join(' / ')}。`);
        const next = { ...(raw.projects[projectId] ?? {}), limitTokens: tokens, window };
        if (f.runs !== undefined) {
          const runs = Number(f.runs);
          if (!Number.isSafeInteger(runs) || runs < 1) throw new Quit('--runs 要是正整数。');
          next.maxRuns = runs;
        }
        raw.projects[projectId] = next;
        writeLimitsFile(file, raw);
        say(`已设:项目 ${projectId} 的额度 ${tokens} token(窗口 ${window})。运行中的服务下一次请求起生效。`);
        return 0;
      }
      if (sub === 'clear') {
        delete raw.projects[projectId];
        writeLimitsFile(file, raw);
        say(`已清:项目 ${projectId} 回到缺省(不限)。运行中的服务下一次请求起生效。`);
        return 0;
      }
      throw new Quit('quota 后面跟 show、set 或 clear。');
    }

    if (cmd === 'usage') {
      const f = flags(rest);
      const q = queryUsage(path.join(dataDir, 'usage'), { projectId: f.project ?? null, since: sinceOf(f.since) });
      if (f.json) { say(JSON.stringify({ calls: q.calls, tokens: q.tokens, projects: q.projects })); return 0; }
      say(`共 ${q.calls} 次模型请求,${q.tokens} token`);
      for (const [id, p] of Object.entries(q.projects)) {
        say(`项目 ${id}:${p.calls} 次,${p.tokens} token(输入 ${p.input},输出 ${p.output})`);
        for (const [userId, m] of Object.entries(p.members)) say(`  成员 ${m.username || userId}(${userId}):${m.calls} 次,${m.tokens} token`);
        for (const [model, m] of Object.entries(p.models)) say(`  模型 ${model}:${m.calls} 次,${m.tokens} token`);
      }
      return 0;
    }

    say('用法:admin.mjs quota show [<projectId>] | quota set <projectId> --tokens <N> [--window total|month|day] [--runs <N>] | quota clear <projectId> | usage [--project <id>] [--since <日期>] [--json]');
    return cmd ? 1 : 0;
  } catch (err) {
    say(err instanceof Quit ? err.message : `出错:${String(err?.message ?? err)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = runAdmin(process.argv.slice(2));
}
