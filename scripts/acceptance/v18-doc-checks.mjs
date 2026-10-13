/**
 * 0.7.18 验收里只读文档的两组核对(把 ACCEPT-018-map 第 9 节 2.3-1、2.3-10 的 grep 命令固化成脚本):
 *
 *   node scripts/acceptance/v18-doc-checks.mjs contracts    设计与契约八项(cloud-agent-task.md 完成条件第 1 条)的章节标题都在
 *   node scripts/acceptance/v18-doc-checks.mjs semantics    语义按 E～J 改好(完成条件第 10 条)的段落都在
 *
 * 只核「标题 / 关键段落在不在」,不核内容对不对(内容要人读,见清单项 V18-doc-semantics-judge)。缺任何一处退出码 1,逐条打印。
 * 从仓库根目录运行(运行器的工作目录就是仓库根)。
 */
import '../lib/no-user-dirs.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** 契约(docs/plan/cloud-agent-contract.md)里八项各自对应的章节标题(正则) */
export const CONTRACT_CHECKS = [
  ['2.3-1.1 独立入口的形态与对外接口', /^### 2\.1 /m, /^### 2\.2 /m, /^### 2\.3 /m],
  ['2.3-1.2 鉴权', /^### 2\.5 /m, /^## 4\. /m, /^### 4\.1 /m, /^### 4\.2 /m],
  ['2.3-1.3 按「用户 × 项目 × 对话」分实例;进程级全局状态怎么改', /^## 3\. /m, /^### 3\.1 /m, /^### 3\.2 /m, /^### 3\.3 /m, /^### 3\.4 /m],
  ['2.3-1.4 H 的认证流程与文档服务侧的核验', /^### 4\.3 /m, /^### 4\.4 /m, /^### 4\.5 /m, /^### 4\.7 /m],
  ['2.3-1.5 G 的检查点与用量记录的格式', /^### 6\.1 /m, /^### 6\.2 /m, /^### 6\.3 /m],
  ['2.3-1.6 在线页面到 Agent 服务走哪条通道;不违反「不请求 /api/*」;守卫与棘轮清单', /^### 10\.1 /m, /^### 10\.2 /m, /^### 10\.3 /m],
  ['2.3-1.7 对话记录存在哪、谁能读', /^### 7\.1 /m, /^### 7\.2 /m],
  ['2.3-1.8 节点上的资源上限', /^## 11\. /m],
];

/** 语义(docs/semantics/)里 E～J 各自对应的关键字:[标签, 文件, 要出现的文字…] */
export const SEMANTIC_CHECKS = [
  ['2.3-10.1 E 云端 Agent 从愿景变成承诺', 'docs/semantics/product/agent.md', '云端 Agent'],
  ['2.3-10.1 E(架构总纲)', 'docs/semantics/architecture.md', '云端 Agent'],
  ['2.3-10.2 F 模型:托管方 Key、服务端直连', 'docs/semantics/product/agent.md', '服务端直连'],
  ['2.3-10.2 F(机制)Key 与模型', 'docs/semantics/mechanism/agent.md', 'Key 与模型'],
  ['2.3-10.3 G 上限:开关、额度、用量', 'docs/semantics/product/agent.md', '上限'],
  ['2.3-10.3 G(机制)闸与上限', 'docs/semantics/mechanism/agent.md', '闸与上限'],
  ['2.3-10.3 G 项目对托管方服务的开关', 'docs/semantics/product/document-service.md', '开关'],
  ['2.3-10.4 H 身份', 'docs/semantics/product/agent.md', '身份'],
  ['2.3-10.4 H(机制)身份与失效', 'docs/semantics/mechanism/agent.md', '身份与失效'],
  ['2.3-10.4 H 云端 Agent 服务用服务身份加发起成员的身份证明接入', 'docs/semantics/product/hosting.md', '身份'],
  ['2.3-10.5 I 界面范围:桌面版 AI 栏可选「云端」', 'docs/semantics/product/platforms.md', '云端'],
  ['2.3-10.5 I 工作流里的连接状态与云端提示', 'docs/semantics/workflow/production.md', '云端'],
  ['2.3-10.6 J 工具范围(与本机一致,做不了的明说「云端暂不支持」)', 'docs/semantics/product/agent.md', '云端暂不支持'],
];

const mode = process.argv[2];
const lines = [];
let missing = 0;
if (mode === 'contracts') {
  const doc = read('docs/plan/cloud-agent-contract.md');
  for (const [label, ...res] of CONTRACT_CHECKS) {
    const lost = res.filter((re) => !re.test(doc));
    if (lost.length) { missing++; lines.push(`✗ ${label}:缺 ${lost.map(String).join('、')}`); } else lines.push(`✓ ${label}`);
  }
  lines.push(missing ? `缺 ${missing} 项` : `全部章节都在(${CONTRACT_CHECKS.length} 项)`);
} else if (mode === 'semantics') {
  for (const [label, file, text] of SEMANTIC_CHECKS) {
    let has = false;
    try { has = read(file).includes(text); } catch { has = false; }
    if (!has) { missing++; lines.push(`✗ ${label}:${file} 里没有「${text}」`); } else lines.push(`✓ ${label}`);
  }
  lines.push(missing ? `缺 ${missing} 项` : `全部段落都在(${SEMANTIC_CHECKS.length} 项)`);
} else {
  lines.push('用法:node scripts/acceptance/v18-doc-checks.mjs contracts|semantics');
  missing = 1;
}
console.log(lines.join('\n'));
process.exitCode = missing ? 1 : 0;
