/** Isolated OS probe worker, never a production asset implementation.
 * Root prepares a unique fixed service/config and frozen G reservation reader.
 * The parent serves real pinned mTLS identity. Its child keeps a real file/TCP
 * open for two seconds after SIGTERM; neither writes root publication evidence.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import https from 'node:https';
import net from 'node:net';
import { X509Certificate, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const digest = value => createHash('sha256').update(value).digest('hex');
const pin = value => String(value ?? '').replaceAll(':', '').toLowerCase();
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) &&
  Object.keys(v).sort().join(',') === [...keys].sort().join(',');
async function ownedFile(filename) {
  if (!path.isAbsolute(filename) || path.normalize(filename) !== filename) fail('worker-file-untrusted');
  for (let p = path.dirname(filename); ; p = path.dirname(p)) {
    const st = await fs.lstat(p);
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== 0 || (st.mode & 0o022)) fail('worker-file-untrusted');
    if (p === path.dirname(p)) break;
  }
  const st = await fs.lstat(filename);
  if (!st.isFile() || st.isSymbolicLink() || st.uid !== 0 || st.nlink !== 1 || (st.mode & 0o022)) fail('worker-file-untrusted');
  return fs.readFile(filename);
}
async function worker(configFile, role) {
  if (process.platform !== 'linux' || !['parent', 'child'].includes(role)) fail('worker-platform');
  const config = JSON.parse(await ownedFile(configFile));
  if (!exact(config, ['v', 'readerModule', 'readerSha256', 'reservationFile', 'expected', 'dataDir', 'tls', 'identityPort', 'observerPort']) ||
      config.v !== 2 || !exact(config.tls, ['keyFile', 'certFile', 'caFile', 'clientCertFile', 'observerCertFile']) ||
      config.observerPort !== 6540 || !Number.isInteger(config.identityPort) || config.identityPort < 6541 || config.identityPort > 6549 ||
      process.getuid() !== config.expected.uid || process.geteuid() !== config.expected.uid ||
      digest(await ownedFile(config.readerModule)) !== config.readerSha256) fail('worker-config');
  const { readRootAssetReservationV2 } = await import(pathToFileURL(config.readerModule));
  if (typeof readRootAssetReservationV2 !== 'function') fail('worker-reader');
  // Exact real G consumer, once at this OS process startup. No reload/current.
  const reservation = readRootAssetReservationV2({ reservationFile: config.reservationFile, expected: config.expected });
  if (digest(await ownedFile(config.readerModule)) !== config.readerSha256) fail('worker-reader-changed');
  const record = Object.freeze({ authorityId: reservation.authorityId, epoch: reservation.epoch, instanceId: reservation.instanceId });
  const dataStat = await fs.lstat(config.dataDir);
  if (!path.isAbsolute(config.dataDir) || dataStat.isSymbolicLink() || !dataStat.isDirectory() || dataStat.uid !== process.getuid()) fail('worker-data');
  const file = await fs.open(path.join(config.dataDir, `${record.epoch}-${role}.bin`), 'wx', 0o600);
  await file.writeFile('actual isolated resource\n'); await file.sync();
  const stat = (await fs.readFile('/proc/self/stat', 'utf8')); const startTicks = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/)[19];
  const socket = net.createConnection({ host: '127.0.0.1', port: config.observerPort });
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  socket.on('error', () => {});
  socket.write(JSON.stringify({ ...record, role, pid: process.pid, startTicks, fd: file.fd, socketFd: socket._handle?.fd }) + '\n');
  let server, stopping = false;
  const stop = async () => {
    if (stopping) return; stopping = true;
    if (role === 'child') await new Promise(r => setTimeout(r, 2000));
    await file.close(); socket.end();
    server?.close(); server?.closeAllConnections();
  };
  process.once('SIGTERM', () => { stop().catch(() => { process.exitCode = 1; }); });
  if (role === 'child') return;
  const [key, cert, ca, clientCert, observerCert] = await Promise.all(
    ['keyFile', 'certFile', 'caFile', 'clientCertFile', 'observerCertFile'].map(k => ownedFile(config.tls[k])));
  const serverPin = pin(new X509Certificate(cert).fingerprint256), clientPin = pin(new X509Certificate(clientCert).fingerprint256);
  const observerPin = pin(new X509Certificate(observerCert).fingerprint256), startedAt = Date.now();
  if (serverPin !== config.expected.serverFingerprint256 || clientPin !== config.expected.clientFingerprint256 ||
      !/^[a-f0-9]{64}$/.test(observerPin)) fail('worker-certificate');
  const identity = Object.freeze({ v: 1, serviceId: 'asset', ...record, pid: process.pid, startedAt,
    serviceIdentity: config.expected.serviceIdentity, docClientFingerprint256: clientPin, internalServerFingerprint256: serverPin, state: 'running' });
  server = https.createServer({ key, cert, ca, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.3' }, (req, res) => {
    if (stopping || req.method !== 'GET' || req.url !== '/internal/v2/asset/run/identity' || !req.socket.authorized ||
        pin(req.socket.getPeerCertificate().fingerprint256) !== observerPin) { res.writeHead(403); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: true, result: identity }));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.identityPort, '127.0.0.1', resolve); });
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child', configFile],
    { stdio: 'ignore', windowsHide: true });
  child.once('error', () => { stop().catch(() => {}); process.exitCode = 1; });
  // Unref only the ChildProcess handle; systemd owns the whole real cgroup.
  child.unref();
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  (async () => {
    if (args.length !== 2 || !['--parent', '--child'].includes(args[0])) fail('worker-cli');
    await worker(args[1], args[0].slice(2));
  })().catch(e => { process.stderr.write(JSON.stringify({ ok: false, code: /^worker-[a-z-]+$/.test(e.code ?? '') ? e.code : 'worker-failed' }) + '\n'); process.exitCode = 1; });
}
