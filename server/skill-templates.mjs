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
 *   .claude/settings.json          Claude Code 的项目级设置:promptcut 的工具全部预先放行
 *   AGENTS.md                      Codex 进目录就读(内容和 SKILL.md 一样,只是入口不同)
 *
 * 收尾协议是最要紧的一段:agent 干完必须把 project.proc 的 file:// 链接放在最后一条回复里,
 * 用户点它就能在 PromptCut 里打开。
 */
import path from "node:path";

const fileUrl = (p) => "file:///" + String(p).replace(/\\/g, "/");

/** 三家 CLI 都是在任务目录里起的,路径用绝对的,别指望 cwd */
export function skillBody({ jobDir, port, provider, viewUrl }) {
  // 用任务目录里自己那份:目录在仓库外,引用仓库里的脚本会被 agent 的沙箱挡掉
  const toolCli = path.join(jobDir, "tools", "pc-tool.mjs");
  const proc = path.join(jobDir, "project.proc");
  const mcpNote = provider === "claude"
    ? `这个目录里的 .mcp.json 已经把 \`promptcut\` MCP 服务指向了这个实例(端口 ${port}),PromptCut 拉起你之前已经把它标成「已启用」;万一还是被问要不要信任这个目录 / 启用这个 MCP,都选允许。**优先用 MCP 工具**(名字形如 \`mcp__promptcut__get_project\`)。`
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

## 想亲眼看看编辑台

用这条链接(钥匙已经在里面了,原样打开):

\`\`\`
${viewUrl || `http://127.0.0.1:${port}/?observe=1`}
\`\`\`

它是**只读**的:能看,不能改 —— 保存会被服务端拒掉,项目还是由你通过工具来改。
页面是打开那一刻的快照,你改完要重新加载才看得到新画面。

看某一帧的真实渲染,\`see_preview\` 比开浏览器更直接也更准,优先用它。

## 开工第一件事(必做)

先调一次 \`get_project\`,把**项目名**和**每条序列上有几张卡**报出来。这一步是在证明
「我确实连上了那个无头实例」—— 光读文件不算,必须真调到工具。连不上就照报错排查,
别接着往下做。

## 推荐流程

1. \`get_project\` 看整体结构,\`list_media\` 看素材,\`list_cuts\` 看有几条剪辑;
2. \`list_cards\` 扫一遍有哪些卡、每张卡什么时候用;选定之后 \`list_cards({cardId})\` 拿完整参数再 \`add_clip\`;
3. 改完关键的几张卡就 \`see_preview\` 看真实画面,别凭想象排版;涉及遮挡和位置的决定必须看图;
4. 字幕用 \`fill_captions\`,不要手写 lines;素材有语音就先 \`transcribe_media\`;
   用户给的是网页链接(B 站 BV 号之类)就 \`collect_probe\` 看一眼再 \`collect_download\`,用 \`collect_job\` 轮询到 done,素材会自动登记进素材库;
5. **已经在时间轴上的卡要改就 \`update_clip\`**,不要删了重建 —— 重建会换 id,用户那边合并时会当成"删了一张又加了一张"。

## 如果工具返回「SKILL 模式已经关闭」

用户在 PromptCut 里点了「关闭 SKILL 模式」,把项目的控制权收回去了。这时**所有**工具调用
都会被拦下(连只读的也是),返回形如:

\`\`\`json
{ "ok": false, "skillClosed": true, "message": "SKILL 模式已经关闭,无法操作。…" }
\`\`\`

看到 \`skillClosed: true\` 就**立刻收工**:

1. **不要重试**,也不要换个工具再试 —— 现在什么都调不动;
2. **不要轮询等它重开** —— 你拿不到「什么时候会重新打开」的信号,等就是空烧;
3. 把已经做完的部分总结给用户:改了什么、还差什么、下一步该做什么;
4. 告诉用户:想继续的话,在 PromptCut 里重新进入 Skill 模式,然后回来跟你说一声。

被拦下的那次调用**没有产生任何改动**,项目是干净的,不用担心留下半截状态。

## 边界

- 只改这个目录里的东西。**不要**去找 PromptCut 的源码,也不要动别的端口上的实例(5190 / 5210 是用户正在用的)。
- 不要修改 \`base.proc\`。
- 不确定用户想要什么就先问,别猜着做一大堆。

## 把改动并回用户的项目(像 worktree 合回主分支)

用户想把你的成果拿走时,不用他手动合并:调 \`submit_merge\`(只有 MCP 里有,带一句 \`note\` 说明并入了什么)。
它会先等实例把改动写回 \`project.proc\`,再让用户手里那份 PromptCut 做三方合并(以 \`base.proc\` 为基线,
两边都改的保留用户的),然后把合并报告返回给你。

- 一次任务可以并入多次:先并一版让用户看效果,再继续改、再并;
- 返回超时说明用户那边的 PromptCut 没开着或 SKILL 模式已关闭 —— 如实告诉用户,他可以在 Skill 对话框的历史任务里点「强制并入」;
- 用户明确说「先别合」就不要调。

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

/**
 * Claude Code 项目级设置:把 promptcut 这个 MCP 服务的所有工具预先放行。
 *
 * 实测走到这一步时,技能解析了、MCP 也接上了,但每调一个 MCP 工具都要弹一次
 * 「Allow Claude to use get project (promptcut)?」—— 用户一走开流程就停。
 * `mcp__promptcut` 这一条规则匹配这个服务下的全部工具(Claude Code 的规则语法),放行的只是
 * 打到这个无头实例的调用,碰不到别的东西。
 *
 * 注意:**Claude 桌面版不读这份文件**(它起会话时只加载用户级设置),桌面版那条路的放行
 * 写在 ~/.claude/settings.json 里,见 claude-desktop.ts 的 allowMcpInUserSettings。这份留着是
 * 给用命令行 `claude` 进这个目录的人用的 —— 命令行会读项目级设置。
 */
export function claudeSettingsJson() {
  return JSON.stringify({ permissions: { allow: ["mcp__promptcut"] } }, null, 2);
}

/** 给人看的 README */
export function readmeMd({ jobDir, port, provider, createdAt, viewUrl }) {
  return `# PromptCut Skill 任务

- 创建时间:${createdAt}
- 驱动:${provider}
- 无头实例端口:${port}
- 结果文件:${path.join(jobDir, "project.proc")}
${viewUrl ? `- 只读查看这个实例的画面:${viewUrl}\n  (能看不能改;直接开裸地址会被拦下,并把这条链接给你)` : ""}

agent 干完后回复里会有 project.proc 的链接。回到 PromptCut,顶栏「⋯ → Skill 模式」里点「合并结果到当前项目」,
或者直接双击 project.proc 打开看看。

要停掉无头实例:在这个目录里新建一个叫 \`stop\` 的空文件,或者在 Skill 对话框里点「停止」。
`;
}
