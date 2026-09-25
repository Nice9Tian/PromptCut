/**
 * 共享项目接入的探针（SP，契约 `docs/plan/shared-project-contract.md` 第 6 节）。结果最后一行打一行 JSON；
 * `ok` 为假时退出码 1，连不上或参数不对退出码 2。
 *
 * 本分支（`claude/sp-routing`）只有 `--mode lan`，实现在 `shared-project-lan.mjs`（用法见那个文件的文件头）：
 *
 *   node scripts/probes/shared-project-probe.mjs --mode lan --role creator [--port 5480] [--state <目录>] [--coord <url>] [--tasks 3]
 *   node scripts/probes/shared-project-probe.mjs --mode lan --role member [--manual <url>] [--state <目录>] [--coord <url>]
 *
 * `--mode internet`、`--role coord`、`--role migrate-check` 在 `claude/sp-hosting` 的同名文件里；
 * 集成时以那边的文件为准，只把下面「--mode lan」这一个分支并进它的分派处。
 */
const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const MODE = arg('--mode', null);
const ROLE = arg('--role', null);

if (MODE === 'lan') {
  const { runLan } = await import('./shared-project-lan.mjs');
  await runLan(ROLE, argv);
} else {
  console.error('用法：node scripts/probes/shared-project-probe.mjs --mode lan --role creator|member [...]（互联网模式见 claude/sp-hosting）');
  process.exit(2);
}
