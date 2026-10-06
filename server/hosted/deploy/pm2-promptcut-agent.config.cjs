// 云端 Agent 服务的 PM2 配置模板(契约 docs/plan/cloud-agent-contract.md 第 2.2、11 节)。
// 部署脚本 `scripts/remote/docservice.mjs deploy-agent` 用 server/agent-service/deploy.mjs 的 agentPm2Config 填好占位符,
// 写成 {{DIR}}/pm2-agent.config.cjs(仓库外)。手工重建时把花括号占位符(两层花括号括起来的大写名字)换成 server/hosted/deploy/README.md「Agent 服务」一节表里的值。
// 不含任何秘密:服务私钥在 {{SECRETS}}/service-key.json(0600,目录 0700),模型 Key 与配音令牌的密文在 {{DATA}}/config/keys/(加密分发导入),都不进环境变量,也不进这个文件。
// 不要在这里设 PROMPTCUT_AGENT_EGRESS_TEST_ALLOW:它只给探针与演练用,设了出网闸就对点名的地址放行(/healthz 的 egressTestAllow 会是 true)。
module.exports = {
  apps: [
    {
      name: 'promptcut-agent',
      // 托管档入口:不带页面、没有 /api/*,只绑回环,对外只经 nginx 的 /agent/。与 promptcut-hosted、promptcut-render 互不重启
      script: 'server/agent-service/main.mjs',
      // 与渲染服务共用同一份检出(current 指向 releases/<提交前 12 位>):三者必须出自同一个提交
      cwd: '{{DIR}}/current',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      // V8 老生代上限(MiB);节点没有 swap,另由下面的常驻内存上限兜底
      node_args: '--max-old-space-size={{HEAP_MB}}',
      max_memory_restart: '{{MAX_MEMORY_RESTART}}',
      // 退出前给进行中的每一轮记「中断」、状态落盘(服务自己 5 秒内退出)
      kill_timeout: {{KILL_TIMEOUT_MS}},
      time: true,
      env: {
        NODE_ENV: 'production',
        PROMPTCUT_AGENT_DATA: '{{DATA}}',
        PROMPTCUT_AGENT_SECRETS: '{{SECRETS}}',
        PROMPTCUT_AGENT_DOC_URL: '{{DOC_URL}}',
        // 同机素材服务(回环):云端 Agent 导入素材、配音入库时凭代成员的素材票据写进它
        PROMPTCUT_AGENT_ASSET_URL: '{{ASSET_URL}}',
        PROMPTCUT_AGENT_HOST: '127.0.0.1',
        PROMPTCUT_AGENT_PORT: '{{AGENT_PORT}}',
        PROMPTCUT_AGENT_PUBLIC_ORIGIN: '{{PUBLIC_ORIGIN}}',
        // 进程的临时目录放在数据目录里
        TMPDIR: '{{DATA}}/tmp',
      },
    },
  ],
};
