/**
 * 四段连做的最终验收运行器的纯逻辑部分(命令行解析、清单校验、按级别选取与续跑、判定、占位符、小结、发版耗时记录的文本)。
 * 两条规则都照 `docs/semantics/guide_files/verification.md`:耗时只记录、不当闸门;验证分本地验证与真实网络验证两级。
 * 不起进程、不碰网络,单测在 `server/test/four-stage-acceptance.test.mjs`。
 * 运行器本体见 `four-stage-acceptance.mjs`,清单(数据)见 `four-stage-manifest.mjs`。
 */

/** 清单里允许的类别(显示顺序) */
export const CATEGORIES = ['G0', 'G0-R', '探针', '第一段', '第二段', '第三段', '第四段'];

/** 一项的最终判定。时间数字不参与判定(只记录),所以没有「参考」一档;remote = 真实网络验证的项,脚本不跑 */
export const VERDICTS = ['pass', 'fail', 'flaky', 'manual', 'remote', 'missing', 'blocked', 'skipped'];

/** 这些判定在续跑时不再重跑 */
export const DONE_VERDICTS = new Set(['pass']);

/** 验证的两级(verification.md「本地验证与真实网络验证」)。local 合入 main 前跑;network 只在往节点部署时、或改到网络这一层时跑 */
export const LEVELS = ['local', 'network'];
export const LEVEL_LABEL = { local: '本地验证', network: '真实网络验证' };
/** 清单项的级别:写了 level 的照写的;没写时带 remoteOnly 的是 network,其余 local */
export const levelOf = (item) => item.level || (item.remoteOnly ? 'network' : 'local');

/** 运行器能起的前置服务 */
export const SERVICES = ['dev', 'dev-main', 'main-worktree', 'online-build'];

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * 命令行。返回 { ...选项 } 或抛 Error(带可读的中文原因)。
 * 选项:list, only[], from, resume, out, mainRef, flakyRerun, devPort, devMainPort, json, checkCoverage, help, forceResume, keepMainWorktree,
 *      level(local | network | all;跑的时候缺省 local,--list 缺省 all)、releaseTimings(版本号文字)、timingsFrom(已有的 results.json)
 */
export function parseArgs(argv) {
  const o = {
    list: false, only: [], from: null, resume: false, forceResume: false, out: null, mainRef: 'main',
    flakyRerun: 0, devPort: 5690, devMainPort: 5693, json: false, checkCoverage: false, help: false,
    keepMainWorktree: false, includeOptional: false, dryRun: false, matrix: false, portShift: 0,
    level: null, releaseTimings: null, timingsFrom: null, machineName: null,
  };
  const need = (i, name) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${name} 缺少参数`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--list': o.list = true; break;
      case '--json': o.json = true; break;
      case '--resume': o.resume = true; break;
      case '--force-resume': o.forceResume = true; break;
      case '--check-coverage': o.checkCoverage = true; break;
      case '--keep-main-worktree': o.keepMainWorktree = true; break;
      case '--include-optional': o.includeOptional = true; break;
      case '--dry-run': o.dryRun = true; break;
      case '--matrix': o.matrix = true; break;
      case '--help': case '-h': o.help = true; break;
      case '--only': o.only.push(...need(i, a).split(',').map((s) => s.trim()).filter(Boolean)); i++; break;
      case '--from': o.from = need(i, a); i++; break;
      case '--out': o.out = need(i, a); i++; break;
      case '--main-ref': o.mainRef = need(i, a); i++; break;
      case '--level': {
        const v = need(i, a);
        if (![...LEVELS, 'all'].includes(v)) throw new Error('--level 要 local、network 或 all');
        o.level = v; i++; break;
      }
      case '--release-timings': o.releaseTimings = need(i, a); i++; break;
      case '--timings-from': o.timingsFrom = need(i, a); i++; break;
      case '--machine-name': o.machineName = need(i, a); i++; break;
      case '--flaky-rerun': {
        const n = Number(need(i, a));
        if (!Number.isInteger(n) || n < 0 || n > 10) throw new Error('--flaky-rerun 要 0～10 的整数');
        o.flakyRerun = n; i++; break;
      }
      case '--port-shift': {
        const n = Number(need(i, a));
        if (!Number.isInteger(n) || Math.abs(n) > 3000) throw new Error('--port-shift 要 -3000～3000 的整数');
        o.portShift = n; i++; break;
      }
      case '--dev-port': case '--dev-main-port': {
        const n = Number(need(i, a));
        if (!Number.isInteger(n) || n < 1024 || n > 65000) throw new Error(`${a} 要端口号`);
        if (a === '--dev-port') o.devPort = n; else o.devMainPort = n;
        i++; break;
      }
      default: throw new Error(`看不懂的参数:${a}`);
    }
  }
  if (o.resume && !o.out) throw new Error('--resume 要同时给 --out(上次的输出目录)');
  if (o.timingsFrom && !o.releaseTimings) throw new Error('--timings-from 要同时给 --release-timings <版本>');
  return o;
}

export const USAGE = `用法:node scripts/acceptance/four-stage-acceptance.mjs [选项]
  --list                  打印清单(按级别分两段:本地验证、真实网络验证;编号、类别、命令、通过标准、记哪些耗时)后退出
  --level <级别>          local(本地验证,跑的时候的缺省)、network(真实网络验证:只在往节点部署时或改到网络这一层时跑)、all;--list 缺省 all
  --only <编号|类别|通配>  只跑这些(逗号分隔或重复给);类别如 G0、G0-R、探针、第一段;编号可带 * 通配,如 GR-*
  --from <编号>           从这一项起往后跑(按清单顺序)
  --resume                跳过上次(同一个 --out 里)已过的项;提交哈希变了要加 --force-resume
  --out <目录>            输出目录(缺省 <主工作区>/work/four-stage/final-prep/<时间戳>);--resume 必须给
  --main-ref <引用>       像素比对的 main 基准(缺省 main)
  --flaky-rerun <N>       全部跑完后,每个失败项再重跑至多 N 次定稳定性(过一次就记 flaky)
  --port-shift <N>        把清单命令里 5xxx 的端口(端口类参数,5600～5999)整体平移 N(另一台机器分到的端口段不同时用,如给 -110 并配 --dev-port 5580 --dev-main-port 5583);8xxx 的文档与素材服务端口不动
  --dev-port <端口>       共享 dev server 的编辑器端口(缺省 5690,另占 +1、+2)
  --dev-main-port <端口>  main 基准树的 dev server(缺省 5693,另占 +1、+2)
  --include-optional      连带跑标了 optional 的补充项(缺省不跑)
  --keep-main-worktree    结束时不删 main 基准 worktree
  --check-coverage        对照 scripts/probes/ 下的文件,列出清单没登记也没写明排除原因的探针后退出
  --dry-run               只打印将要跑哪些项与命令,不执行
  --release-timings <版本> 跑完后按这次的结果出一节发版耗时记录(版本与提交、机器配置、各项耗时),写到 <out>/release-timings-section.md 并打印;贴进 docs/reports/release-timings.md
  --timings-from <文件>   不跑任何项,直接用已有的 results.json 出那一节(配 --release-timings)
  --machine-name <名字>   那一节里「哪台」写什么(缺省主机名)
  --matrix                打印两份任务书的每一条编号验收由哪些项覆盖(R<n> 任务书一、C<n> 任务书二完成条件、U<n> 用户体验验收)后退出
  --json                  --list 时输出 JSON`;

/**
 * 校验清单(数据)。返回错误字符串数组,空数组表示合格。
 */
export function validateManifest(items) {
  const errs = [];
  if (!Array.isArray(items) || !items.length) return ['清单为空'];
  const seen = new Set();
  const ids = new Set(items.map((x) => x && x.id));
  items.forEach((it, idx) => {
    const at = `第 ${idx + 1} 项(${it && it.id})`;
    if (!it || typeof it !== 'object') { errs.push(`${at}:不是对象`); return; }
    if (typeof it.id !== 'string' || !ID_RE.test(it.id)) errs.push(`${at}:编号不合法`);
    else if (seen.has(it.id)) errs.push(`${at}:编号重复`);
    seen.add(it.id);
    if (typeof it.name !== 'string' || !it.name.trim()) errs.push(`${at}:缺名字`);
    if (!CATEGORIES.includes(it.category)) errs.push(`${at}:类别 ${it.category} 不在 ${CATEGORIES.join('/')} 里`);
    if (typeof it.taskRef !== 'string' || !it.taskRef.trim()) errs.push(`${at}:缺 taskRef(对应任务书哪一条)`);
    const kinds = ['cmd', 'steps', 'manual', 'remoteOnly'].filter((k) => it[k]);
    const runnable = !!(it.cmd || it.steps);
    if (!runnable && !it.manual && !it.remoteOnly) errs.push(`${at}:既没有命令也没有 manual / remoteOnly`);
    if (it.cmd && it.steps) errs.push(`${at}:cmd 与 steps 只能写一个`);
    if ((it.manual || it.remoteOnly) && runnable) errs.push(`${at}:manual / remoteOnly 的项不能带命令(${kinds.join(',')})`);
    if (it.manual && typeof it.manual !== 'string') errs.push(`${at}:manual 要写明怎么验(字符串)`);
    if (it.remoteOnly && typeof it.remoteOnly !== 'string') errs.push(`${at}:remoteOnly 要写明怎么验(字符串)`);
    const stepList = it.cmd ? [it.cmd] : it.steps ? it.steps.map((s) => s.cmd || s) : [];
    for (const c of stepList) {
      if (!Array.isArray(c) || !c.length || c.some((p) => typeof p !== 'string')) errs.push(`${at}:命令要是字符串数组`);
    }
    if (runnable && !it.pass) errs.push(`${at}:缺 pass(通过标准)`);
    if (it.pass) {
      const p = it.pass;
      if (p.exit !== undefined && !Number.isInteger(p.exit) && !(Array.isArray(p.exit) && p.exit.every(Number.isInteger))) errs.push(`${at}:pass.exit 要整数或整数数组`);
      for (const k of ['must', 'mustNot']) {
        if (p[k] !== undefined && !(Array.isArray(p[k]) && p[k].every((r) => typeof r === 'string'))) errs.push(`${at}:pass.${k} 要正则字符串数组`);
        else for (const r of p[k] || []) { try { new RegExp(r); } catch { errs.push(`${at}:pass.${k} 里 ${r} 不是合法正则`); } }
      }
      if (p.metrics) for (const [k, r] of Object.entries(p.metrics)) { try { new RegExp(r); } catch { errs.push(`${at}:pass.metrics.${k} 不是合法正则`); } }
      if (p.limits) for (const [k, lim] of Object.entries(p.limits)) {
        if (!p.metrics || !(k in p.metrics)) errs.push(`${at}:pass.limits.${k} 没有对应的 metrics`);
        if (!lim || (lim.eq === undefined && lim.max === undefined && lim.min === undefined)) errs.push(`${at}:pass.limits.${k} 要 eq / max / min`);
      }
    }
    if (it.timing !== undefined && it.timing !== false && it.timing !== 'record') errs.push(`${at}:timing 只能是 false 或 'record'(耗时只记录,不当通过条件)`);
    if (it.timing === 'record' && !it.timingNote) errs.push(`${at}:timing 为 record 时要写 timingNote(记哪些耗时)`);
    if (it.timing === 'record' && !runnable) errs.push(`${at}:timing 为 record 的项要有命令(不跑就没有耗时可记)`);
    if (!LEVELS.includes(it.level)) errs.push(`${at}:level 要写 local(本地验证)或 network(真实网络验证)`);
    if (it.remoteOnly && it.level !== 'network') errs.push(`${at}:remoteOnly 的项属于真实网络验证,level 要是 network`);
    if (it.level === 'network' && runnable) errs.push(`${at}:真实网络验证的项不带本机命令(照部署清单在节点上做),写 remoteOnly`);
    if (it.needs !== undefined) {
      if (!Array.isArray(it.needs) || it.needs.some((s) => !SERVICES.includes(s))) errs.push(`${at}:needs 只能是 ${SERVICES.join('/')}`);
    }
    if (it.prereq !== undefined) {
      if (!Array.isArray(it.prereq)) errs.push(`${at}:prereq 要数组`);
      else for (const p of it.prereq) if (!ids.has(p)) errs.push(`${at}:prereq ${p} 不在清单里`);
    }
    if (it.timeoutMin !== undefined && !(it.timeoutMin > 0 && it.timeoutMin <= 240)) errs.push(`${at}:timeoutMin 要 (0,240]`);
    if (it.idleKillMin !== undefined && !(it.idleKillMin > 0)) errs.push(`${at}:idleKillMin 要正数`);
    if (it.requires !== undefined && !(Array.isArray(it.requires) && it.requires.every((s) => typeof s === 'string'))) errs.push(`${at}:requires 要字符串数组`);
    if (it.requiresText !== undefined && !(Array.isArray(it.requiresText) && it.requiresText.every((r) => r && typeof r.file === 'string' && typeof r.text === 'string'))) errs.push(`${at}:requiresText 要 [{ file, text }]`);
    if (it.tasks !== undefined && !(Array.isArray(it.tasks) && it.tasks.every((t) => /^[RCUKJ]\d+[a-z]?$/.test(t)))) errs.push(`${at}:tasks 要 R<n> / C<n> / U<n> / K<n> / J<n>(可带小写字母后缀)的数组`);
    if (it.covers !== undefined && !(Array.isArray(it.covers) && it.covers.every((c) => typeof c === 'string'))) errs.push(`${at}:covers 要字符串数组`);
    if (it.parallel !== undefined && typeof it.parallel !== 'boolean') errs.push(`${at}:parallel 要布尔`);
    if (it.parallel && !it.steps) errs.push(`${at}:parallel 只用于 steps`);
  });
  return errs;
}

/** 通配:只认 *,其它按字面 */
export function globToRegExp(glob) {
  return new RegExp('^' + glob.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
}

/** 一项是否被 --only 的某个记号选中:编号(可带 *)或类别 */
export function matchesToken(item, token) {
  if (token === item.category) return true;
  if (token.includes('*')) return globToRegExp(token).test(item.id);
  return token === item.id;
}

/**
 * 按 --level / --only / --from 选项。返回选中的项(保持清单顺序)。
 * 记号一个都没匹配到会抛错(拼错编号不要悄悄什么都不跑);记号匹配到的项全在另一级里也抛错,并说要加哪个 --level。
 * level:'local' | 'network' | 'all'(缺省 'all',由调用方定缺省:跑的时候传 local)。
 */
export function selectItems(items, { only = [], from = null, includeOptional = false, level = 'all' } = {}) {
  const inLevel = (it) => level === 'all' || levelOf(it) === level;
  for (const t of only) {
    const hit = items.filter((it) => matchesToken(it, t));
    if (!hit.length) throw new Error(`--only ${t}:没有这个编号或类别`);
    if (!hit.some(inLevel)) throw new Error(`--only ${t}:属于${LEVEL_LABEL[levelOf(hit[0])]},这次选的是${LEVEL_LABEL[level]};要跑它加 --level ${levelOf(hit[0])}`);
  }
  let out = items.filter(inLevel);
  if (only.length) out = out.filter((it) => only.some((t) => matchesToken(it, t)));
  else if (!includeOptional) out = out.filter((it) => !it.optional);
  if (from) {
    const at = items.findIndex((it) => it.id === from);
    if (at < 0) throw new Error(`--from ${from}:没有这个编号`);
    const fromIds = new Set(items.slice(at).map((it) => it.id));
    out = out.filter((it) => fromIds.has(it.id));
  }
  return out;
}

/**
 * 续跑计划:previous 是上次的 results.json 里的 items 数组(或 null)。
 * 返回 { run: [...], skip: [{ item, previous }] }。
 */
export function planResume(selected, previous, { resume = false } = {}) {
  if (!resume || !previous) return { run: selected.slice(), skip: [] };
  const byId = new Map(previous.map((r) => [r.id, r]));
  const run = [], skip = [];
  for (const it of selected) {
    const prev = byId.get(it.id);
    if (prev && DONE_VERDICTS.has(prev.verdict)) skip.push({ item: it, previous: prev });
    else run.push(it);
  }
  return { run, skip };
}

/** 占位符 {a.b} 展开;没有的占位符抛错(不悄悄留着) */
export function expandPlaceholders(value, vars) {
  if (typeof value !== 'string') return value;
  return value.replace(/\{([A-Za-z0-9_.-]+)\}/g, (m, key) => {
    if (!(key in vars)) throw new Error(`占位符 ${m} 没有值`);
    return String(vars[key]);
  });
}

export function expandCmd(cmd, vars) {
  return cmd.map((p) => expandPlaceholders(p, vars));
}

/**
 * 取输出里最后一个能解析成 JSON 对象的:先找单行的(`{…}` 独占一行),再找缩进打印的(独占一行的 `{` 到之后第一个独占一行的 `}`)。
 * 返回 { value, line }(line 是单行时的原文,多行时是压成一行的文本)。
 */
export function lastJsonObject(output) {
  const lines = String(output).split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (l.startsWith('{') && l.endsWith('}')) {
      try { const v = JSON.parse(l); if (v && typeof v === 'object' && !Array.isArray(v)) return { value: v, line: l }; } catch { /* 下一行 */ }
    }
    if (lines[i] === '}') {
      for (let j = i - 1; j >= 0; j--) {
        if (lines[j] !== '{') continue;
        const text = lines.slice(j, i + 1).join('\n');
        try { const v = JSON.parse(text); if (v && typeof v === 'object' && !Array.isArray(v)) return { value: v, line: JSON.stringify(v) }; } catch { /* 往前再找一个起点 */ }
      }
    }
  }
  return null;
}

/** 去掉 ANSI 颜色码,正则好匹配 */
export const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');

/**
 * 判定一项。输入:这项的清单项、每一步的结果 [{ exitCode, output, timedOut, idleKilled, signal }]。
 * 返回 { verdict, reasons[], resultLine, metrics }。
 * 规则:
 *   - 超时或空闲被杀:fail(原因写明);
 *   - 退出码要在 pass.exit(缺省 0;数组表示几个都算)里;
 *   - pass.must 每条正则都要在输出里出现,pass.mustNot 一条都不能出现;
 *   - pass.metrics 抓数,pass.limits 逐个比(eq / max / min);
 *   - 输出最后一行 JSON 里 fails 非空数组、或 ok === false:fail(退出码给了假的 0 也拦住);
 *   - 时间数字不参与判定:输出里的 `TIMINGS {…}` 行(探针的 probe-timings.mjs 打的)原样收进 timings,只记录。
 *     在哪台机器上跑都一样判,没有「待复核」一档。
 */
export function judge(item, stepResults) {
  const reasons = [];
  const pass = item.pass || {};
  const okExits = pass.exit === undefined ? [0] : Array.isArray(pass.exit) ? pass.exit : [pass.exit];
  const combined = stepResults.map((s) => stripAnsi(s.output || '')).join('\n');
  stepResults.forEach((s, i) => {
    const tag = stepResults.length > 1 ? `第 ${i + 1} 步` : '';
    if (s.timedOut) reasons.push(`${tag}超时被结束`);
    else if (s.idleKilled) reasons.push(`${tag}${s.idleKilled}分钟没有输出,被结束`);
    else if (s.spawnError) reasons.push(`${tag}起不来:${s.spawnError}`);
    else if (!okExits.includes(s.exitCode)) reasons.push(`${tag}退出码 ${s.exitCode}(要 ${okExits.join('/')})`);
  });
  for (const r of pass.must || []) if (!new RegExp(r, 'm').test(combined)) reasons.push(`输出里没有 /${r}/`);
  for (const r of pass.mustNot || []) { const m = new RegExp(r, 'm').exec(combined); if (m) reasons.push(`输出里出现了不该有的:${m[0].slice(0, 80)}`); }
  const metrics = {};
  for (const [k, r] of Object.entries(pass.metrics || {})) {
    let last = null;
    const re = new RegExp(r, 'gm');
    let m;
    while ((m = re.exec(combined))) { last = m; if (m.index === re.lastIndex) re.lastIndex++; }
    metrics[k] = last ? Number(last[1] ?? last[0]) : null;
  }
  for (const [k, lim] of Object.entries(pass.limits || {})) {
    const v = metrics[k];
    if (v === null || Number.isNaN(v)) { reasons.push(`没抓到 ${k}`); continue; }
    if (lim.eq !== undefined && v !== lim.eq) reasons.push(`${k}=${v},要 ${lim.eq}`);
    if (lim.max !== undefined && v > lim.max) reasons.push(`${k}=${v},上限 ${lim.max}`);
    if (lim.min !== undefined && v < lim.min) reasons.push(`${k}=${v},下限 ${lim.min}`);
  }
  const json = lastJsonObject(combined);
  if (json && pass.strictJson !== false) {
    const v = json.value;
    if (Array.isArray(v.fails) && v.fails.length) reasons.push(`结果行 fails 非空:${JSON.stringify(v.fails).slice(0, 160)}`);
    if (v.ok === false) reasons.push('结果行 ok:false');
  }
  let resultLine = pass.resultLine ? lastMatchLine(combined, pass.resultLine) : null;
  if (!resultLine && json) resultLine = json.line;
  if (!resultLine) resultLine = lastNonEmptyLine(combined);
  const verdict = reasons.length === 0 ? 'pass' : 'fail';
  return { verdict, reasons, resultLine: clip(resultLine, 400), metrics, timings: parseTimingLines(combined) };
}

function lastMatchLine(text, re) {
  const rx = new RegExp(re);
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) if (rx.test(lines[i])) return lines[i].trim();
  return null;
}
function lastNonEmptyLine(text) {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].trim()) return lines[i].trim();
  return '';
}
const clip = (s, n) => (s && s.length > n ? s.slice(0, n) + '…' : s || '');

/**
 * 全部尝试(首跑加重跑)合成最终判定。attempts:[{ verdict }],首项是第一次。
 * 全部不过:保持首跑的判定;有过有不过:flaky。
 */
export function combineAttempts(attempts) {
  const isPass = (v) => v === 'pass';
  const passes = attempts.filter((a) => isPass(a.verdict)).length;
  const total = attempts.length;
  if (total === 1) return { verdict: attempts[0].verdict, stability: null };
  if (passes === total) return { verdict: attempts[0].verdict, stability: `${passes}/${total}` };
  if (passes === 0) return { verdict: attempts[0].verdict, stability: `0/${total}` };
  return { verdict: 'flaky', stability: `${passes}/${total}` };
}

/** 一项在清单里的静态说明(--list 与小结用) */
export function describeItem(item) {
  const flags = [];
  flags.push(LEVEL_LABEL[levelOf(item)]);
  if (item.timing === 'record') flags.push('记耗时');
  if (item.realModel) flags.push('真实模型');
  if (item.manual) flags.push('人工');
  if (item.optional) flags.push('补充');
  if ((item.needs || []).length) flags.push('需要:' + item.needs.join('+'));
  return flags;
}

export function commandText(item) {
  if (item.cmd) return item.cmd.join(' ');
  if (item.steps) return item.steps.map((s) => (s.cmd || s).join(' ')).join(item.parallel ? '  ‖  ' : '  &&  ');
  return '';
}

/** --list 的文本:先本地验证、后真实网络验证,各自按类别分段 */
export function listText(items) {
  const lines = [];
  for (const level of LEVELS) {
    const mine = items.filter((it) => levelOf(it) === level);
    if (!mine.length) continue;
    lines.push('', `# ${LEVEL_LABEL[level]}(${mine.length} 项)${level === 'network' ? ':只在往节点部署时、或改到网络这一层时跑;照 docs/plan/four-stage-deploy-checklist.md 在节点上做,脚本不跑' : ':合入 main 前跑的就是这一级'}`);
    let cat = null;
    for (const it of mine) {
      if (it.category !== cat) { cat = it.category; lines.push('', `## ${cat}`); }
      const flags = describeItem(it);
      lines.push(`${it.id.padEnd(14)} ${it.name}${flags.length ? `  [${flags.join('、')}]` : ''}`);
      if (it.manual) lines.push(`${' '.repeat(15)}人工:${it.manual}`);
      else if (it.remoteOnly) lines.push(`${' '.repeat(15)}在节点上:${it.remoteOnly}`);
      else lines.push(`${' '.repeat(15)}$ ${commandText(it)}${it.cwd === 'main' ? '  (cwd=main 基准树)' : ''}`);
      lines.push(`${' '.repeat(15)}标准:${passText(it)}${it.timingNote ? `  只记录的耗时:${it.timingNote}` : ''}  ←${it.taskRef}`);
      if (it.known) lines.push(`${' '.repeat(15)}已知:${it.known}`);
    }
  }
  return lines.join('\n').trimStart();
}

export function passText(it) {
  if (!it.pass) return '(无命令)';
  const p = it.pass;
  const parts = [`退出码 ${p.exit === undefined ? 0 : Array.isArray(p.exit) ? p.exit.join('/') : p.exit}`];
  for (const r of p.must || []) parts.push(`含 /${r}/`);
  for (const [k, l] of Object.entries(p.limits || {})) parts.push(`${k}${l.eq !== undefined ? '=' + l.eq : ''}${l.max !== undefined ? '≤' + l.max : ''}${l.min !== undefined ? '≥' + l.min : ''}`);
  parts.push('结果行 fails 为空');
  return parts.join(',');
}

const VERDICT_LABEL = {
  pass: '过', fail: '不过', flaky: '不稳定',
  manual: '人工', remote: '在节点上做(脚本不跑)', missing: '缺(本检出没有这个文件)', blocked: '跑不了(前置没过)', skipped: '续跑跳过',
};
export const verdictLabel = (v) => VERDICT_LABEL[v] || v;

/** 贴进对话的文本小结 */
export function summaryText(run) {
  const { items, meta } = run;
  const lines = [];
  lines.push(`四段验收运行 ${meta.startedAt} → ${meta.finishedAt || '(未结束)'}  提交 ${meta.commit}  机器 ${meta.host || ''}`);
  // 两级分开计数(verification.md「本地验证与真实网络验证」)
  for (const level of LEVELS) {
    const mine = items.filter((r) => (r.level || 'local') === level);
    if (!mine.length) continue;
    const count = {};
    for (const r of mine) count[r.verdict] = (count[r.verdict] || 0) + 1;
    lines.push(`${LEVEL_LABEL[level]} ${mine.length} 项:` + Object.entries(count).map(([k, n]) => `${verdictLabel(k)} ${n}`).join(',  '));
  }
  const timed = items.filter((r) => (r.timings || []).length);
  if (timed.length) lines.push(`耗时只记录、不决定过不过:${timed.length} 项带耗时数字,共 ${timed.reduce((n, r) => n + r.timings.length, 0)} 个`);
  lines.push('');
  let cat = null;
  for (const r of items) {
    if (r.category !== cat) { cat = r.category; lines.push(`【${cat}】`); }
    const mark = { pass: '✓', fail: '✗', flaky: '~', manual: '·', remote: '·', missing: '?', blocked: '!', skipped: '-' }[r.verdict] || ' ';
    const dur = r.durationSec != null ? ` ${r.durationSec}s` : '';
    const stab = r.stability ? ` 稳定性${r.stability}` : '';
    lines.push(`${mark} ${r.id}  ${r.name}  ${verdictLabel(r.verdict)}${stab}${dur}`);
    if (['fail', 'flaky', 'blocked', 'missing'].includes(r.verdict) && r.reasons && r.reasons.length) lines.push(`    原因:${r.reasons.join(';')}`);
    if (r.resultLine && ['fail', 'flaky', 'pass'].includes(r.verdict)) lines.push(`    结果行:${r.resultLine}`);
    if ((r.timings || []).length) lines.push(`    耗时(只记录):${clip(r.timings.map(timingText).join(';'), 600)}`);
    if (r.known && r.verdict !== 'pass') lines.push(`    已知:${r.known}`);
    if (r.logs && r.logs.length && r.verdict !== 'skipped') lines.push(`    日志:${r.logs.join('  ')}`);
  }
  return lines.join('\n');
}

/** 一个耗时数字的文字:名字=数值单位 */
export const timingText = (t) => `${t.name}=${t.value === null || t.value === undefined ? '没量到' : t.value}${t.value === null || t.value === undefined ? '' : ' ' + (t.unit || 'ms')}`;

/** 从输出里取出全部 `TIMINGS {"probe":…,"timings":[…]}` 行,摊平(格式由 scripts/probes/probe-timings.mjs 定;这里另写一份,运行器不引探针目录) */
export function parseTimingLines(output) {
  const out = [];
  for (const raw of String(output).split(/\r?\n/)) {
    const l = raw.trim();
    if (!l.startsWith('TIMINGS ')) continue;
    try {
      const v = JSON.parse(l.slice(8));
      for (const t of v?.timings ?? []) if (t && typeof t.name === 'string') out.push({ probe: v.probe ?? null, ...t });
    } catch { /* 不是合法的一行,跳过 */ }
  }
  return out;
}

/** 字节数写成 GB(一位小数) */
const gb = (n) => (typeof n === 'number' && n > 0 ? `${(n / 1024 ** 3).toFixed(1)} GB` : '没采到');
const cell = (s) => String(s ?? '').replace(/\|/g, '/').replace(/\r?\n/g, ' ');

/**
 * 发版耗时记录的一节(Markdown),贴进 docs/reports/release-timings.md(verification.md「耗时只记录,不当闸门」:一个版本一节)。
 * run 是 results.json 的内容({ meta, items });machine 缺省取 run.meta.machine(运行器起跑时自动采集的:哪台、处理器、核数、内存、显卡、系统)。
 * 只收跑过的项(有 durationSec 的);被人为放大的数字(scaled,证明时间不是闸门时用的)不进记录。
 */
export function releaseTimingsSection(run, { version, machineName = null } = {}) {
  const { meta, items } = run;
  const m = meta.machine || {};
  const ran = items.filter((r) => r.durationSec != null);
  const scaled = ran.some((r) => (r.timings || []).some((t) => t.scaled));
  const lines = [];
  lines.push(`## ${version}`, '');
  lines.push(`- 提交:\`${meta.commit}\`${meta.dirtyFiles ? `(工作区另有 ${meta.dirtyFiles} 个未提交改动)` : ''}`);
  lines.push(`- 跑的时间:${meta.startedAt} → ${meta.finishedAt || '(未结束)'}`);
  lines.push(`- 机器:${machineName || m.name || meta.host || '没采到'};处理器 ${m.cpu || '没采到'};核数 ${m.physicalCores ? `${m.physicalCores} 物理 / ` : ''}${m.logicalCores ?? meta.cpus ?? '没采到'} 逻辑;内存 ${gb(m.memoryBytes)};显卡 ${(m.gpus && m.gpus.length ? m.gpus.join('、') : '没采到')};系统 ${m.os || meta.platform || '没采到'};Node ${meta.node || ''}`);
  lines.push(`- 范围:${ran.length} 项(验收运行器跑过的;人工项与真实网络验证的项不在内)。合计机器耗时 ${Math.round(ran.reduce((n, r) => n + r.durationSec, 0) / 60)} 分钟`);
  lines.push('- 这些数字只记录,不决定过不过。相邻两版之间某项明显变差,在发版汇报里指出来,由用户决定要不要查。');
  if (scaled) lines.push('- **注意:这次带了 PC_PROBE_TIMING_SCALE(人为放大),放大的数字已略去,这一节不能当发版记录。**');
  lines.push('', '### 各项整项用时', '', '| 编号 | 项 | 判定 | 整项用时(秒) |', '|---|---|---|---|');
  for (const r of ran) lines.push(`| ${cell(r.id)} | ${cell(r.name)} | ${verdictLabel(r.verdict)} | ${r.durationSec} |`);
  const withNumbers = ran.filter((r) => (r.timings || []).some((t) => !t.scaled));
  lines.push('', '### 探针量的耗时', '');
  if (!withNumbers.length) lines.push('(这次没有探针报耗时数字)');
  else {
    lines.push('| 编号 | 量的是什么 | 数值 | 原来的门槛(已不作通过条件) |', '|---|---|---|---|');
    for (const r of withNumbers) for (const t of r.timings.filter((x) => !x.scaled)) {
      lines.push(`| ${cell(r.id)} | ${cell(t.name)} | ${t.value === null || t.value === undefined ? '没量到' : `${t.value} ${t.unit || 'ms'}`} | ${cell(t.formerLimit || '')} |`);
    }
  }
  const expected = ran.filter((r) => r.timing === 'record' && !(r.timings || []).length);
  if (expected.length) lines.push('', `清单标了「记耗时」但这次没报数字的项:${expected.map((r) => r.id).join('、')}`);
  return lines.join('\n') + '\n';
}

/**
 * 登记覆盖检查:probesDir 里的文件名(去目录)对照清单里每项 `covers`(文件名数组)与排除表。
 * 返回 { unlisted: [...], staleExcluded: [...], staleCovers: [...] }。
 */
export function coverageReport(fileNames, items, excluded) {
  const files = new Set(fileNames);
  const covered = new Set();
  for (const it of items) for (const f of it.covers || []) covered.add(f);
  const unlisted = fileNames.filter((f) => !covered.has(f) && !(f in excluded)).sort();
  const staleExcluded = Object.keys(excluded).filter((f) => !files.has(f));
  const staleCovers = [...covered].filter((f) => !files.has(f));
  return { unlisted, staleExcluded, staleCovers };
}

/**
 * 任务书编号验收的覆盖矩阵:all 是全部编号(如 R1…R25),返回 { rows: [{ task, items: [id…] }], uncovered: [task…] }。
 */
export function taskMatrix(items, all) {
  const rows = all.map((task) => ({ task, items: items.filter((it) => (it.tasks || []).includes(task)).map((it) => it.id) }));
  return { rows, uncovered: rows.filter((r) => !r.items.length).map((r) => r.task) };
}

export function matrixText(items, groups) {
  const lines = [];
  for (const [label, all] of Object.entries(groups)) {
    const m = taskMatrix(items, all);
    lines.push(`## ${label}`);
    for (const r of m.rows) lines.push(`${r.task.padEnd(4)} ${r.items.length ? r.items.join(', ') : '(没有任何项覆盖!)'}`);
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * 端口平移:命令里「端口类参数」(--port、--base-port、--port-a、--online-base 等)后面紧跟的 5600～5999 的数加 shift。
 * 两个自限定探针命令保留各自 5840～5859 / 5880～5899 的端口;8xxx 服务端口与别的参数不动。shift 为 0 原样返回。
 */
export function shiftPorts(cmd, shift) {
  if (!shift) return cmd;
  const command = cmd.map((part) => String(part).replaceAll('\\', '/')).join(' ');
  const selfRange = command.includes('scripts/probes/multi-agent-probe.mjs') ? [5840, 5859]
    : command.includes('scripts/probes/skill-mcp-probe.mjs') ? [5880, 5899] : null;
  return cmd.map((part, i) => {
    const flag = cmd[i - 1] || '';
    if (/^--[a-z-]*port(-[a-z])?$/.test(flag) || flag === '--online-base') {
      const n = Number(part);
      if (selfRange && Number.isInteger(n) && n >= selfRange[0] && n <= selfRange[1]) return part;
      if (Number.isInteger(n) && n >= 5600 && n <= 5999) return String(n + shift);
    }
    return part;
  });
}
