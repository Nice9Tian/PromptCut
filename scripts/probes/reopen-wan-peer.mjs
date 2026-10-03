/** Dedicated temporary peer. Configuration/secrets arrive over SSH stdin, never command arguments. */
import '../lib/no-user-dirs.mjs';
import readline from 'node:readline';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createHostingService } from '../../server/hosting/service.mjs';
import { discoverRoom, relayFetch, authorizeRelayAsset } from '../../server/hosting/client.mjs';
import { buildAuthProtocols } from '../../server/auth/client.mjs';
import { openRecoveryVault } from '../../server/recovery/vault.mjs';
import { createAssetClient } from '../../server/asset-store/client.mjs';
import { wsClient } from '../../server/test/fake-ws-kit.mjs';

const input = readline.createInterface({ input: process.stdin });
const config = JSON.parse(await new Promise(resolve => input.once('line', resolve)));
try {
  if (config.op === 'gateway') {
    const cloud = createHostingService({ dir: path.join(config.dir, 'directory') });
    const addr = await cloud.listen(0, '0.0.0.0');
    console.log(JSON.stringify({ port: addr.port, pid: process.pid }));
    input.once('close', () => { void cloud.close().then(() => process.exit(0)); });
    process.once('SIGTERM', () => { void cloud.close().then(() => process.exit(0)); });
  } else if (config.op === 'member') {
    input.close();
    const descriptor = { version: 1, where: 'lan', service: config.service, roomId: config.roomId };
    const vault = openRecoveryVault({ dir: path.join(config.dir, 'member') });
    const prior = vault.select(descriptor, 'wan-content').selected;
    let key = prior?.key;
    const identity = { username: 'wan-member', as: 'member', deviceId: 'isolated-wan-member-00001', deviceName: 'isolated-WAN-peer' };
    const route = await discoverRoom({ ...identity, ...descriptor, key, password: config.password, onKey: k => { key = k; } });
    const protocols = await buildAuthProtocols({ ...identity, projectId: config.roomId, base: route.base, key, fetch: relayFetch(route.access), onKey: k => { key = k; } });
    const { access: _access, routeProtocol: _route, ...candidate } = route;
    vault.remember({ ...descriptor, candidate, as: 'member', username: identity.username, key }, 'wan-content');
    const c = wsClient(route.base.replace('http:', 'ws:').replace('https:', 'wss:'), [...protocols, route.routeProtocol]);
    let seq = 0; const ask = async m => { const reqId = `wan-${++seq}`; c.send({ ...m, reqId }); try { return await c.next(x => x.reqId === reqId); } catch { throw new Error('WAN reply timeout; secrets omitted'); } };
    try {
      await c.opened;
      const before = await ask({ type: 'project.open', projectId: config.roomId });
      if (!before.project || config.expected && before.project.name !== config.expected) throw new Error('WAN peer did not read expected project');
      if (config.edit) {
        const r = await ask({ type: 'project.op', projectId: config.roomId, opId: `wan-${Date.now()}`, ops: [{ op: 'set', path: '/name', value: config.edit }] });
        if (r.type !== 'project.op.ok') throw new Error('WAN peer edit rejected');
      }
      const checks = [];
      if (config.asset) {
        const issued = await ask({ type: 'auth.ticket', kind: 'asset', access: 'r' });
        if (issued.type !== 'auth.ticket.ok') throw new Error('WAN asset ticket rejected');
        await authorizeRelayAsset(route, issued.ticket);
        const assets = createAssetClient({ base: route.asset, ticket: async () => issued.ticket });
        for (const ns of ['media', 'snap', 'px']) {
          const bytes = await assets.get(ns, config.asset.hash);
          if (!bytes || bytes.length !== config.asset.size || createHash('sha256').update(bytes).digest('hex') !== config.asset.hash) throw new Error('WAN asset bytes differ');
          checks.push({ namespace: ns, bytes: bytes.length, hashVerified: true });
        }
      }
      console.log(JSON.stringify({ ok: true, roomId: config.roomId, rev: before.rev, username: identity.username, role: 'member', restoredDeviceIdentity: !!prior, pid: process.pid, assets: checks }));
    } finally { c.close(); }
  } else throw new Error('unsupported isolated operation');
} catch { console.error(JSON.stringify({ ok: false, error: 'isolated WAN peer failed; all secrets omitted' })); process.exitCode = 1; input.close(); }
