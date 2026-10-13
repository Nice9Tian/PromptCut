/** Isolated Linux experiment worker, NOT the production Agent executor.
 * One RAM Ed25519 key and one signed assignment per OS. Real TLS, child, file
 * and TCP resources. Root supplies fresh fixture certificates/config only. */
import fs from 'node:fs/promises';
import net from 'node:net';
import https from 'node:https';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync, sign, X509Certificate } from 'node:crypto';
import { digestOf } from '../../../server/account/ledger.mjs';
import { rootRead } from '../../../server/hosted/deploy/asset-root-registry-publisher.mjs';
import { validateAgentScopeExpected, validateAgentScopeReservation, validateAgentScopeAssignment,
  verifyScopeSignature, validateAgentScopeCloseEnvelope, exactScope, sameScope } from '../../../server/hosted/agent-run-scope-schema.mjs';

const die = () => { throw Error('scope-fixture-invalid'); };
const pin = s => String(s ?? '').replaceAll(':', '').toLowerCase();
async function resource({ holdFile, observerPort, slotId, role }) {
  const fd = await fs.open(holdFile, 'a');
  const socket = net.connect({ host: '127.0.0.1', port: observerPort });
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  socket.on('error', () => {}); socket.write(`${slotId}|${role}|${process.pid}\n`);
  return async () => { await fd.close(); socket.end(); await new Promise(resolve => socket.closed ? resolve() : socket.once('close', resolve)); };
}

async function main() {
  if (process.platform !== 'linux' || process.getuid?.() === 0) die();
  if (process.argv[2] === '--child' && process.argv.length === 4) {
    const config = JSON.parse(process.argv[3]);
    const close = await resource({ ...config, role: 'child' }); let stopping = false;
    // Remain installed: systemd may send SIGTERM again after MainPID exits.
    process.on('SIGTERM', () => { if (stopping) return; stopping = true; setTimeout(async () => { await close(); process.exit(0); }, 2000); });
    return;
  }
  if (process.argv[2] !== '--config' || process.argv.length !== 4) die();
  const config = await rootRead(process.argv[3]);
  if (!exactScope(config, ['v', 'expected', 'registryDir', 'port', 'observerPort', 'holdFile', 'tls']) || config.v !== 1 ||
      ![config.port, config.observerPort].every(p => Number.isSafeInteger(p) && p >= 6540 && p <= 6549) || config.port === config.observerPort ||
      !exactScope(config.tls, ['keyFile', 'certFile', 'caFile', 'clientCertFile', 'rootClientFingerprint256'])) die();
  const expected = validateAgentScopeExpected(config.expected);
  if (process.getuid() !== expected.uid || process.geteuid() !== expected.uid) die();
  const reservation = validateAgentScopeReservation(await rootRead(`${config.registryDir}/reservation.json`), expected);
  const keyPair = generateKeyPairSync('ed25519'), publicKey = keyPair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const [key, cert, ca] = await Promise.all(['keyFile', 'certFile', 'caFile'].map(k => fs.readFile(config.tls[k])));
  const clientFingerprint256 = pin(new X509Certificate(await fs.readFile(config.tls.clientCertFile)).fingerprint256);
  if (pin(new X509Certificate(cert).fingerprint256) !== expected.serverFingerprint256 || clientFingerprint256 !== expected.clientFingerprint256) die();
  const owned = { slotId: expected.slotId, holdFile: config.holdFile, observerPort: config.observerPort };
  const closeParent = await resource({ ...owned, role: 'parent' });
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child', JSON.stringify(owned)],
    { stdio: 'ignore', windowsHide: true, env: { PATH: process.env.PATH } });
  child.once('error', die);
  const sockets = new Set(); let assignmentDigest = null, stopParent;
  const server = https.createServer({ key, cert, ca, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.3' }, async (req, res) => {
    try {
      if (!req.socket.authorized || pin(req.socket.getPeerCertificate().fingerprint256) !== config.tls.rootClientFingerprint256) die();
      if (req.method === 'GET' && req.url === '/internal/v2/agent/run-scope/identity') {
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, result: { v: 1, serviceId: 'agent',
          authorityId: expected.authorityId, slotId: expected.slotId, epoch: reservation.epoch, instanceId: reservation.instanceId,
          pid: process.pid, publicKey, publicKeyDigest: digestOf(publicKey),
          clientFingerprint256, serverFingerprint256: pin(new X509Certificate(cert).fingerprint256) } })); return;
      }
      const forcedExit = req.url === '/internal/v2/agent/run-scope/probe-parent-exit';
      if (req.method !== 'POST' || (!forcedExit && req.url !== '/internal/v2/agent/run-scope/probe-intent')) die();
      const chunks = []; let length = 0;
      for await (const chunk of req) { length += chunk.length; if (length > 16384) die(); chunks.push(chunk); }
      const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
      if (!exactScope(body, ['assignment', 'terminal'])) die();
      const record = await rootRead(`${config.registryDir}/epoch-${reservation.epoch}.json`);
      const stored = await rootRead(`${config.registryDir}/assignment-${reservation.epoch}.json`);
      if (record.worker.publicKey !== publicKey || record.instance.pid !== process.pid || !sameScope(stored, body.assignment)) die();
      validateAgentScopeAssignment(body.assignment, expected, record); verifyScopeSignature(body.terminal, expected.docPublicKey);
      const t = body.terminal;
      if (forcedExit) {
        if (t.protocol !== 'promptcut.agent-run-scope.forced-terminal.v1') die();
        validateAgentScopeCloseEnvelope(t, null, expected, record, stored);
        // Only this isolated fixture can request its own parent exit. No PID kill,
        // no child cleanup: systemd must observe and close the original group.
        req.socket.once('close', () => stopParent());
        res.setHeader('Connection', 'close'); res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, result: { parentExitRequested: true, instanceId: reservation.instanceId } })); return;
      }
      if (!exactScope(t, ['v', 'protocol', 'authorityId', 'slotId', 'epoch', 'recordDigest', 'docAuthorityId', 'assignmentDigest', 'finish', 'signature']) ||
          t.v !== 1 || t.protocol !== 'promptcut.agent-run-scope.terminal.v1' || t.authorityId !== expected.authorityId || t.slotId !== expected.slotId ||
          t.epoch !== reservation.epoch || t.recordDigest !== digestOf(record) || t.docAuthorityId !== expected.docAuthorityId ||
          t.assignmentDigest !== digestOf(stored) || (assignmentDigest && assignmentDigest !== t.assignmentDigest)) die();
      assignmentDigest = t.assignmentDigest;
      const payload = { v: 1, protocol: 'promptcut.agent-run-scope.intent.v1', assignmentDigest, terminalDigest: digestOf(t) };
      const intent = { ...payload, signature: sign(null, Buffer.from(digestOf(payload)), keyPair.privateKey).toString('base64url') };
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, result: intent }));
    } catch { if (!res.headersSent) { res.writeHead(403); res.end('{"ok":false}'); } else res.destroy(); }
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, '127.0.0.1', resolve); });
  let stopping = false;
  stopParent = () => { if (stopping) return; stopping = true;
    for (const socket of sockets) socket.destroy();
    server.close();
    closeParent().then(() => process.exit(0), () => process.exit(2));
  };
  process.on('SIGTERM', stopParent);
}
main().catch(() => { process.stderr.write('{"ok":false,"code":"scope-fixture-failed"}\n'); process.exitCode = 1; });
