/**
 * Skill 任务目录里那几份给 agent 看的文件。
 *
 * 一份任务目录长这样:
 *   base.proc                      启动时的快照,合并时当 base,agent 不要动
 *   project.proc                   工作副本,无头实例的当前项目,改动自动写回这里
 *   instance.json                  无头实例的端口 / pid / 脏标记
 *   CLAUDE.md                      Claude Code 进目录就读
 *   .claude/skills/promptcut/SKILL.md   /promptcut 这个 skill
 *   .mcp.json                      Claude Code 的项目级 MCP 配置(指向这个实例的端口)
 *   AGENTS.md                      Codex 进目录就读(内容和 SKILL.md 一样,只是入口不同)
 *
 * 收尾协议是最要紧的一段:agent 干完必须把 project.proc 的 file:// 链接放在最后一条回复里,
 * 用户点它就能在 PromptCut 里打开。
 */
import path from "node:path";

const fileUrl = (p) => "file:///" + String(p).replace(/\\/g, "/");

/** 三家 CLI 都是在任务目录里起的,路径用绝对的,别指望 cwd */
export function skillBody({ jobDir, port, provider }) {
  // 用任务目录里自己那份:目录在仓库外,引用仓库里的脚本会被 agent 的沙箱挡掉
  const toolCli = path.join(jobDir, "tools", "pc-tool.mjs");
  const proc = path.join(jobDir, "project.proc");
  const mcpNote = provider === "claude"
    ? `这个目录里的 .mcp.json 已经把 \`promptcut\` MCP 服务指向了这个实例(端口 ${port})。第一次会问你要不要信任这个项目的 MCP 配置,选允许。**优先用 MCP 工具**(名字形如 \`mcp__promptcut__get_project\`)。`
    : `Codex 桌面版这次会话**没有**接 MCP。请用下面的命令行调工具,效果一样。`;

  return `# PromptCut · Skill 模式

你正在操作 **PromptCut**(一个 AI 驱动的短视频卡片编辑器)的一份**无头实例**。它跑在本机端口 ${port},
和用户正在打开的那份 PromptCut 完全隔离 —— 你改的是这个任务目录里的副本,不会碰到用户手里的项目。

## 工作目录(以这个为准)

\`\`\`
${jobDir}
\`\`\`

这是一个**独立目录**,里面只有这次任务要用的东西,和 PromptCut 的源码没有关系
(桌面 app 的工作区就是它)。下面说「这个目录」都指它,所有路径按上面这个绝对路径来。

## 这个目录

| 文件 | 说明 |
|---|---|
| \`project.proc\` | **你的工作副本**。你通过工具改项目,改动会在 1 秒内自动写回这个文件。不要用编辑器直接手改它 —— 实例会用自己的状态覆盖回去 |
| \`base.proc\` | 启动时的快照,用户那边合并时当基线。**不要动** |
| \`instance.json\` | 实例的端口和写回状态,\`pc-tool.mjs save\` 读它 |
| \`tools/\` | 调工具用的脚本。自包含,不依赖 PromptCut 源码 |
| 素材 | 已经在实例里就位,\`list_media\` 看得到 |

## 怎么调工具

${mcpNote}

命令行(任何环境都能用,在**这个目录**下运行):

\`\`\`bash
node "${toolCli}" list                       # 全部工具
node "${toolCli}" describe add_clip          # 某个工具的参数
node "${toolCli}" call get_project           # 调一次
node "${toolCli}" call add_clip '{"cardId":"title-card","start":0,"duration":3,"params":{"title":"你好"}}'
node "${toolCli}" save                       # 等写回完成,打印 project.proc 的路径和 file:// 链接
\`\`\`

带画面的工具(\`see_preview\`)返回里的 \`previewImage\` 是一张 png 的路径,看图请读那个文件。

## 开工第一件事(必做)

先调一次 \`get_project\`,把**项目名**和**每条序列上有几张卡**报出来。这一步是在证明
「我确实连上了那个无头实例」—— 光读文件不算,必须真调到工具。连不上就照报错排查,
别接着往下做。

## 推荐流程

1. \`get_project\` 看整体结构,\`list_media\` 看素材,\`list_cuts\` 看有几条剪辑;
2. \`list_cards\` 扫一遍有哪些卡、每张卡什么时候用;选定之后 \`list_cards({cardId})\` 拿完整参数再 \`add_clip\`;
3. 改完关键的几张卡就 \`see_preview\` 看真实画面,别凭想象排版;涉及遮挡和位置的决定必须看图;
4. 字幕用 \`fill_captions\`,不要手写 lines;素材有语音就先 \`transcribe_media\`;
5. **已经在时间轴上的卡要改就 \`update_clip\`**,不要删了重建 —— 重建会换 id,用户那边合并时会当成"删了一张又加了一张"。

## 边界

- 只改这个目录里的东西。**不要**去找 PromptCut 的源码,也不要动别的端口上的实例(5190 / 5210 是用户正在用的)。
- 不要修改 \`base.proc\`。
- 不确定用户想要什么就先问,别猜着做一大堆。

## 收尾协议(必须做)

1. 跑 \`node "${toolCli}" save\`,确认输出里 \`ok: true\`;
2. **最后一条回复**里必须包含这一行,原样、单独一行、正斜杠:

   ${fileUrl(proc)}

   用户点这个链接就会在 PromptCut 里打开结果;之后他可以在自己的项目里点「合并 Skill 结果」把改动并进去。
3. 链接下面用 3~5 条列出你改了什么(加了哪些卡、改了哪些、放在哪条序列),再列没做完 / 拿不准的事项。
4. 不要把 project.proc 的内容贴出来。
`;
}

/** Claude Code 的 skill:frontmatter + 正文 */
export function claudeSkillMd(ctx) {
  return `---
name: promptcut
description: 操作这个目录里的 PromptCut 无头实例:读项目、加卡、改卡、看预览,干完把 project.proc 的链接交回去
---

${skillBody({ ...ctx, provider: "claude" })}`;
}

/** Claude Code 进目录自动读的说明 */
export function claudeMd(ctx) {
  return `# 这是一个 PromptCut Skill 任务目录

用 \`/promptcut\` 开始(它会把完整流程和收尾协议读给你)。没有别的事要做时,先 \`/promptcut\`。

${skillBody({ ...ctx, provider: "claude" })}`;
}

/** Codex 进目录自动读的说明 */
export function agentsMd(ctx) {
  return skillBody({ ...ctx, provider: "codex" });
}

/** Claude Code 项目级 MCP 配置 */
export function mcpJson({ jobDir, port }) {
  return JSON.stringify(
    {
      mcpServers: {
        promptcut: {
          command: process.execPath,
          // 任务目录里自己那份,不依赖仓库
          args: [path.join(jobDir, "tools", "mcp-server.mjs")],
          env: { PROMPTCUT_PORT: String(port) },
        },
      },
    },
    null,
    2,
  );
}

/** 给人看的 README */
export function readmeMd({ jobDir, port, provider, createdAt }) {
  return `# PromptCut Skill 任务

- 创建时间:${createdAt}
- 驱动:${provider}
- 无头实例端口:${port}
- 结果文件:${path.join(jobDir, "project.proc")}

agent 干完后回复里会有 project.proc 的链接。回到 PromptCut,顶栏「⋯ → Skill 模式」里点「合并结果到当前项目」,
或者直接双击 project.proc 打开看看。

要停掉无头实例:在这个目录里新建一个叫 \`stop\` 的空文件,或者在 Skill 对话框里点「停止」。
`;
}
