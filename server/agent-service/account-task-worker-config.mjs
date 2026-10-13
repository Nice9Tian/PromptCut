/**
 * 任务进程（一条任务一个进程）的本机启动配置：把**真实的运行器**装进这个进程。
 *
 * `account-task-worker-cli.mjs --configuration-module <本文件的绝对路径>` 载入它，调 `createWorkerConfiguration()`。
 * 配置只有一个来源：环境变量 `PROMPTCUT_AGENT_WORKER_SETTINGS` 指向的那份 JSON（root 在开这一代进程之前写好，
 * 这个进程的用户只读）。进程间消息、任何请求体都改不了这里的任何一项。
 *
 * 这一份配置给进程装上的东西：
 *   - 到文档服务的任务身份（双向 TLS 加进程内存里的钥匙，`run-client.mjs`）、root 核身份用的本机 HTTPS 口；
 *   - 本机事件日志与往主服务交事件的通道（`worker-event-journal.mjs`、`worker-event-sink.mjs`）；
 *   - 真实运行器要的那一套：进程内不带插件的 vite（只用 `ssrLoadModule` 载工具实现，和 `main.mjs` 同一个起法）、
 *     模型配置（现读数据目录里的那一份，不读环境变量里的 Key）、对话历史与工作目录所在的数据目录；
 *   - 可选：看画面的客户端（`look`）、运行素材的传输（`runAssets`）。没写就是没接：看画面的工具不交给模型，
 *     素材那几个工具回明确的原因。写了但不全，直接拒绝启动。
 *
 * 设置文件的形状（`v: 1`；路径都要是绝对路径）：
 *   expected, reservation      root 给这个槽、这一代写的两份记录（`agent-run-scope-schema.mjs`）
 *   rootRecordFile             root 写的这一代的记录文件（`epoch-<n>.json`）
 *   identity   { keyFile, certFile, caFile, port }      root 核身份用的本机口；`port` 0 表示由系统分配
 *   doc        { origin, fingerprint256, keyFile, certFile, caFile }   文档服务的内部口与这个进程的任务证书
 *   master     { origin, fingerprint256 }               主服务收事件的口（用同一张任务证书连）
 *   journalFile                这一代的本机事件日志
 *   dataDir                    各代共用、长期保留：对话的模型历史、工作目录、用量流水、额度
 *   stateDir                   这一代自己的：已读意向等本机状态
 *   modelConfigDir             可不写：模型配置所在的数据目录，缺省就是 dataDir
 *   controlPort                可不写：文档服务回连的本机控制口，缺省 0（系统分配）
 *   look       { url, keyDir }                          可不写；渲染服务的回环口、签看画面请求用的服务私钥目录
 *   runAssets  { origin, fingerprint256, maxResponseBytes, maxImportBytes, timeoutMs? }   可不写；素材服务的内部口
 *                              （timeoutMs：一次素材请求里连接多久没有动静就放弃，缺省 5 秒）
 *
 * 只在 Linux 上能用：root 写的文件要核属主（`rootRead`）。别的平台直接拒绝。测试经 `buildWorkerConfiguration`
 * 换掉「读 root 记录」和「模型配置」这两处，其余走同一份代码。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readModelConfig } from '../agent/service/model-config.mjs';
import { readServiceKeyFile } from '../auth/service-identity.mjs';
import { rootRead } from '../hosted/deploy/asset-root-registry-publisher.mjs';
import { createLookClient, parseLookUrl } from './look-client.mjs';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const fail = code => { throw Object.assign(new Error(code), { status: 503, code }); };
const exact = (value, required, optional = []) => value && typeof value === 'object' && !Array.isArray(value) &&
  required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const absolute = value => typeof value === 'string' && path.isAbsolute(value) && path.normalize(value) === value;
const fingerprint = value => typeof value === 'string' && /^[A-Fa-f0-9:]{64,95}$/.test(value);
const origin = value => { try { const u = new URL(value); return u.protocol === 'https:' && u.hostname === '127.0.0.1' && u.pathname === '/' && !u.search && !u.hash; } catch { return false; } };
const port = value => Number.isInteger(value) && value >= 0 && value <= 65535;
const positive = value => Number.isSafeInteger(value) && value > 0;

/** 只核形状与路径。记录本身的内容由 `createAccountTaskWorker` 用 root 的模式去核。 */
export function validateWorkerSettings(settings) {
  if (!exact(settings, ['v', 'expected', 'reservation', 'rootRecordFile', 'identity', 'doc', 'master', 'journalFile', 'dataDir', 'stateDir'],
    ['modelConfigDir', 'controlPort', 'look', 'runAssets']) || settings.v !== 1 ||
      !absolute(settings.rootRecordFile) || !absolute(settings.journalFile) || !absolute(settings.dataDir) || !absolute(settings.stateDir) ||
      (settings.modelConfigDir !== undefined && !absolute(settings.modelConfigDir)) ||
      (settings.controlPort !== undefined && !port(settings.controlPort)) ||
      !exact(settings.identity, ['keyFile', 'certFile', 'caFile', 'port']) || !port(settings.identity.port) ||
      ['keyFile', 'certFile', 'caFile'].some(key => !absolute(settings.identity[key])) ||
      !exact(settings.doc, ['origin', 'fingerprint256', 'keyFile', 'certFile', 'caFile']) || !origin(settings.doc.origin) ||
      !fingerprint(settings.doc.fingerprint256) || ['keyFile', 'certFile', 'caFile'].some(key => !absolute(settings.doc[key])) ||
      !exact(settings.master, ['origin', 'fingerprint256']) || !origin(settings.master.origin) || !fingerprint(settings.master.fingerprint256))
    fail('account-worker-settings');
  if (settings.look !== undefined && (!exact(settings.look, ['url', 'keyDir']) || !parseLookUrl(settings.look.url) || !absolute(settings.look.keyDir)))
    fail('account-worker-settings-look');
  if (settings.runAssets !== undefined && (!exact(settings.runAssets, ['origin', 'fingerprint256', 'maxResponseBytes', 'maxImportBytes'], ['timeoutMs']) ||
      !origin(settings.runAssets.origin) || !fingerprint(settings.runAssets.fingerprint256) ||
      !positive(settings.runAssets.maxResponseBytes) || !positive(settings.runAssets.maxImportBytes) ||
      (settings.runAssets.timeoutMs !== undefined && !positive(settings.runAssets.timeoutMs))))
    fail('account-worker-settings-run-assets');
  return settings;
}

/**
 * 照设置拼出任务进程的配置。`seams` 只给测试用，生产入口（下面的 `createWorkerConfiguration`）一样都不传。
 * @param {object} settings `validateWorkerSettings` 认的那份
 * @param {object} [seams]
 * @param {() => Promise<object>} [seams.readRootRecord] 怎么读 root 写的这一代记录（生产：核属主的 `rootRead`）
 * @param {() => object | Promise<object>} [seams.modelConfig] 模型配置（生产：现读数据目录里的那一份）
 * @param {string} [seams.root] 仓库根目录
 * @param {(event: string, fields?: object) => void} [seams.log]
 * @param {object} [seams.runnerOptions] 交给真实运行器的其它选项（工作区上限、工具时限等）
 * @param {object} [seams.lookLimits] 看画面客户端的时限（测试把「一趟最多挂多久」调短）
 */
export function buildWorkerConfiguration(settings, { readRootRecord, modelConfig = null, root = ROOT, log = () => {}, runnerOptions = {}, lookLimits = {} } = {}) {
  validateWorkerSettings(settings);
  if (typeof readRootRecord !== 'function') fail('account-worker-settings');
  const read = file => fs.readFileSync(file);
  const docTls = { key: read(settings.doc.keyFile), cert: read(settings.doc.certFile), ca: read(settings.doc.caFile) };
  const identityTls = { key: read(settings.identity.keyFile), cert: read(settings.identity.certFile), ca: read(settings.identity.caFile) };
  for (const dir of [settings.dataDir, settings.stateDir]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.accessSync(dir, fs.constants.W_OK);
  }
  // 看画面：服务私钥在这里读一次。读不到、服务名不对就拒绝启动，不悄悄变成「看不了画面」。
  let look = null;
  if (settings.look) {
    let key;
    try { key = readServiceKeyFile(settings.look.keyDir); } catch { fail('account-worker-settings-look-key'); }
    if (key.service !== 'agent') fail('account-worker-settings-look-key');
    look = createLookClient({ url: settings.look.url, key, log, limits: lookLimits });
  }
  let vite = null;
  return { listener: { host: '127.0.0.1', port: settings.identity.port }, workerOptions: {
    expected: settings.expected, reservation: settings.reservation, identityTls, readRootRecord,
    doc: { origin: settings.doc.origin, tls: docTls, serverFingerprint256: settings.doc.fingerprint256 },
    eventSink: { file: settings.journalFile, origin: settings.master.origin, tls: docTls, serverFingerprint256: settings.master.fingerprint256 },
    // 领到任务、root 绑定之后才走到这里：这时才起 vite。没领到任务的一代不付这份开销。
    async createAssemblyOptions() {
      // 测试用的换驱动口子不带进这个进程（和 `main.mjs` 一样）
      delete process.env.PROMPTCUT_AI_FAKE_RUNNER;
      delete process.env.PROMPTCUT_AI_RUNNER_MODULE;
      const { createServer } = await import('vite');
      vite = await createServer({ configFile: false, root, cacheDir: path.join(settings.stateDir, 'vite-cache'), logLevel: 'silent',
        server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom',
        optimizeDeps: { noDiscovery: true, include: [] } });
      const current = vite;
      return { ...runnerOptions, dataDir: settings.dataDir, stateDir: settings.stateDir, controlPort: settings.controlPort ?? 0, root,
        loadModule: id => current.ssrLoadModule(id),
        modelConfig: modelConfig ?? (() => readModelConfig(settings.modelConfigDir ?? settings.dataDir)),
        ...(look ? { look } : {}),
        ...(settings.runAssets ? { runAssets: { assetOrigin: settings.runAssets.origin, assetTls: docTls,
          assetFingerprint256: settings.runAssets.fingerprint256, maxResponseBytes: settings.runAssets.maxResponseBytes,
          maxImportBytes: settings.runAssets.maxImportBytes,
          ...(settings.runAssets.timeoutMs ? { timeoutMs: settings.runAssets.timeoutMs } : {}) } } : {}),
        log,
        // 这个进程收尾时（执行器关完之后）关掉 vite
        async close() { const owned = vite; vite = null; await owned?.close(); } };
    },
  } };
}

/** 生产入口。只在 Linux 上、只凭 root 写好的那份设置。 */
export async function createWorkerConfiguration() {
  if (process.platform !== 'linux') fail('account-worker-linux-required');
  const file = process.env.PROMPTCUT_AGENT_WORKER_SETTINGS;
  if (!absolute(file)) fail('account-worker-entry-configuration');
  // 设置文件和 root 的记录都按「属主是 root、别人写不了、不是链接」来读
  const settings = validateWorkerSettings(await rootRead(file));
  return buildWorkerConfiguration(settings, { readRootRecord: () => rootRead(settings.rootRecordFile) });
}
