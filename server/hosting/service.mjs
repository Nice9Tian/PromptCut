/** Independent directory and streaming relay. Never writes project or asset bytes to disk. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Duplex } from 'node:stream';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { acceptUpgrade, rejectUpgrade } from '../docservice/ws.mjs';
import { createChallenges } from '../auth/challenges.mjs';
import { createRateLimiter } from '../auth/rate-limit.mjs';
import { isProjectId, isUsername, isDeviceId, isKdf } from '../auth/protocol.mjs';
import { HOSTING, ROUTE_PROTOCOL, hostingProof } from './protocol.mjs';
import { createBandwidth } from './bandwidth.mjs';

const digest = s => createHash('sha256').update(String(s)).digest('hex');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const bearer = req => /^Bearer ([A-Za-z0-9_-]{43})$/.exec(String(req.headers.authorization || ''))?.[1];
const secret = () => randomBytes(32).toString('base64url');
const isKey = k => typeof k === 'string' && /^[A-Za-z0-9_-]{43}$/.test(k);
const isSalt = k => typeof k === 'string' && /^[A-Za-z0-9_-]{22}$/.test(k);
const credential = c => c && isSalt(c.salt) && isKey(c.key);
// Even a member on the directory machine must authenticate at the host. Never tunnel loopback trust.
const forwardedRemote = req => /^(?:::ffff:)?127\.|^::1$/.test(req.socket.remoteAddress || '') ? '198.51.100.1' : req.socket.remoteAddress;
export function createHostingService({ dir, now = Date.now, leaseMs = HOSTING.leaseMs, bytesPerSecond = HOSTING.bytesPerSecond, totalBytesPerSecond = 16 * 1024 * 1024 } = {}) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'directory.json');
  let rooms = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  if (!rooms || typeof rooms !== 'object' || Array.isArray(rooms)) throw new Error('hosting directory damaged');
  const commit = fn => {
    const copy = structuredClone(rooms); fn(copy); const tmp = `${file}.tmp-${process.pid}`;
    const fd = fs.openSync(tmp, 'w', 0o600); try { fs.writeFileSync(fd, JSON.stringify(copy)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file); rooms = copy;
  };
  const leases = new Map(), tunnels = new Map(), accesses = new Map(), channels = new Map(), assetGrants = new Map();
  const bandwidth = createBandwidth({ bytesPerSecond, totalBytesPerSecond });
  const challenges = createChallenges({ now }); const rate = createRateLimiter({ now });
  const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(body)); };
  const fail = (res, code, error) => send(res, code, { ok: false, error });
  const hostAllowed = (req, id) => rooms[id] && !rooms[id].deleted && equal(digest(bearer(req) ?? String(req.headers['sec-websocket-protocol'] || '').split(',').map(s => s.trim()).find(s => s.startsWith('promptcut.host.'))?.slice('promptcut.host.'.length)), rooms[id].hostVerifier);
  const online = id => (leases.get(id)?.expires || 0) > now() && tunnels.has(id);
  const banned = (rec, user, device) => (rec.bans ?? []).some(b => b.username === user && b.deviceId === device);
  const accessOf = (req, id) => {
    const protocols = String(req.headers['sec-websocket-protocol'] ?? req.headers['x-promptcut-protocols'] ?? '').split(',').map(s => s.trim());
    const token = req.headers['x-pc-hosting-access'] ?? protocols.find(p => p.startsWith(ROUTE_PROTOCOL))?.slice(ROUTE_PROTOCOL.length);
    const access = accesses.get(digest(token)); const rec = rooms[id];
    if (!access || access.roomId !== id || access.expires <= now() || !rec || rec.deleted || rec.generation !== access.generation || banned(rec, access.username, access.deviceId)) return null;
    return access;
  };
  const grantOf = (req, id) => {
    const raw = String(req.headers.authorization || '');
    const ticket = /^Bearer (\S{1,4096})$/.exec(raw)?.[1] ?? new URL(req.url, 'http://localhost').searchParams.get('t') ?? String(req.headers['sec-websocket-protocol'] || '').split(',').map(s => s.trim()).find(s => s.startsWith('promptcut.ticket.'))?.slice('promptcut.ticket.'.length);
    const grant = assetGrants.get(digest(ticket)), rec = rooms[id];
    return grant && grant.roomId === id && grant.expires > now() && rec && !rec.deleted && grant.generation === rec.generation && !banned(rec, grant.username, grant.deviceId) ? grant : null;
  };
  async function bodyOf(req) { let raw = ''; for await (const b of req) { raw += b; if (raw.length > 65536) throw new Error('too-large'); } return JSON.parse(raw); }
  const timeout = setInterval(() => {
    bandwidth.prune();
    for (const [id, lease] of leases) if (lease.expires <= now()) { leases.delete(id); tunnels.get(id)?.close(1001, 'lease-expired'); tunnels.delete(id); }
    for (const [key, value] of accesses) if (value.expires <= now()) accesses.delete(key);
    for (const [key, value] of assetGrants) if (value.expires <= now()) assetGrants.delete(key);
  }, 1000); timeout.unref();
  function openChannel(id, kind, remote, user) {
    const tunnel = tunnels.get(id); if (!tunnel || channels.size >= HOSTING.maxChannels) throw new Error('relay-unavailable');
    const channelId = secret();
    let closed = false;
    const socket = new Duplex({
      read() { tunnel.send(JSON.stringify({ type: 'resume', id: channelId })); },
      write(data, _encoding, done) {
        const wait = bandwidth.reserve(user, data.length);
        setTimeout(() => {
          if (closed || tunnel.bufferedAmount > 4 * 1024 * 1024) return done(new Error('relay-backpressure'));
          tunnel.send(JSON.stringify({ type: 'data', id: channelId, data: data.toString('base64') })); done();
        }, wait);
      },
      destroy(err, done) { closed = true; channels.delete(channelId); tunnel.send(JSON.stringify({ type: 'close', id: channelId })); done(err); },
    });
    socket.on('error', () => {});
    channels.set(channelId, { socket, roomId: id, user, queued: 0, delivery: Promise.resolve() });
    tunnel.send(JSON.stringify({ type: 'open', id: channelId, kind, remote, user }));
    return socket;
  }
  function relay(req, res, id, kind, suffix) {
    const access = accessOf(req, id);
    const grant = grantOf(req, id);
    if (!access && !grant) return fail(res, 401, 'unauthorized');
    if (!online(id)) return fail(res, 503, 'host-offline');
    if (kind === 'doc' ? !/^\/(?:shared\/(?:challenge|verify|invite\/(?:resolve|redeem))|lp\/(?:open|send|recv|close))$/.test(suffix.split('?')[0]) : !/^\/api\/asset\/(?:media|snap|px)\/[a-f0-9]{64}(?:\/(?:chunks|complete|\d{1,10}))?$/.test(suffix.split('?')[0])) return fail(res, 404, 'no-endpoint');
    let socket;
    const principal = access ?? grant;
    try { socket = openChannel(id, kind, req.socket.remoteAddress, JSON.stringify([id, principal.username, principal.deviceId])); } catch { return fail(res, 503, 'relay-unavailable'); }
    const headers = { ...req.headers, host: 'localhost', 'x-forwarded-for': forwardedRemote(req), 'x-pc-stage-client': 'hosting-relay' };
    delete headers['x-pc-hosting-access']; delete headers.origin; delete headers.connection;
    const agent = new http.Agent({ keepAlive: false });
    agent.createConnection = () => socket;
    const proxy = http.request({ host: 'localhost', port: 80, method: req.method, path: suffix, headers, agent }, upstream => {
      const responseHeaders = { ...upstream.headers, 'access-control-allow-origin': '*', 'access-control-expose-headers': 'Retry-After' };
      res.writeHead(upstream.statusCode, responseHeaders);
      // The stream is bounded by Node backpressure. No buffering of whole files.
      upstream.pipe(res);
    });
    proxy.on('error', () => { if (!res.headersSent) fail(res, 502, 'relay-failed'); else res.destroy(); });
    res.on('close', () => { proxy.destroy(); socket.destroy(); }); req.pipe(proxy);
  }
  const rawSockets = new Set();
  const handle = async (req, res) => {
    const u = new URL(req.url, 'http://localhost'); const p = u.pathname;
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,HEAD,POST,PUT', 'access-control-allow-headers': 'Content-Type,Authorization,X-PC-Hosting-Access,X-PromptCut-Protocols,X-Media-Size,X-Media-Ext,Range' }); return res.end(); }
    if (p === '/hosting/healthz') return send(res, 200, { ok: true, role: 'hosting', rooms: Object.keys(rooms).length, online: [...leases.keys()].filter(online).length });
    const rel = /^\/hosting\/relay\/(sp_[a-z2-7]{26})\/(doc|asset)(\/.*)$/.exec(p);
    if (rel) return relay(req, res, rel[1], rel[2], rel[3] + u.search);
    if (req.method !== 'POST') return fail(res, 404, 'no-endpoint');
    try {
      const b = await bodyOf(req), rec = rooms[b.roomId], remote = req.socket.remoteAddress;
      if (p === '/hosting/register') {
        let mirror = b.mirror;
        if (!isProjectId(b.roomId) || !isDeviceId(b.deviceId) || !isKey(b.instance) || !isKey(bearer(req)) || !mirror || !isKdf(mirror.kdf) || !credential(mirror.creator) || !isUsername(mirror.creator.username)
          || typeof mirror.name !== 'string' || mirror.name.length > 256 || !Number.isSafeInteger(mirror.generation) || mirror.generation < 0
          || !Array.isArray(mirror.bans) || mirror.bans.length > 10000 || !mirror.bans.every(b => isUsername(b.username) && isDeviceId(b.deviceId))
          || !(mirror.mode === 'free' ? credential(mirror.project) : mirror.mode === 'restricted' && Array.isArray(mirror.list) && mirror.list.length <= 10000 && mirror.list.every(c => isUsername(c.username) && credential(c)))) return fail(res, 400, 'bad-request');
        const copyCredential = c => ({ ...(c.username ? { username: c.username } : {}), salt: c.salt, key: c.key });
        mirror = { name: mirror.name, mode: mirror.mode, kdf: { alg: mirror.kdf.alg, iter: mirror.kdf.iter }, creator: copyCredential(mirror.creator),
          ...(mirror.mode === 'free' ? { project: copyCredential(mirror.project) } : { list: mirror.list.map(copyCredential) }),
          generation: mirror.generation, bans: mirror.bans.map(b => ({ username: b.username, deviceId: b.deviceId })),
          invite: mirror.invite && typeof mirror.invite.digest === 'string' && mirror.invite.digest.length <= 128 ? { digest: mirror.invite.digest, expires: mirror.invite.expires, revoked: !!mirror.invite.revoked } : null, direct: null };
        if (rec?.deleted) return fail(res, 410, 'deleted');
        if (rec && !hostAllowed(req, b.roomId)) return fail(res, 403, 'host-auth');
        if (rec && rec.deviceId !== b.deviceId) return fail(res, 409, 'host-conflict');
        const lease = leases.get(b.roomId);
        if (lease && lease.expires > now() && (lease.deviceId !== b.deviceId || lease.instance !== b.instance && tunnels.has(b.roomId))) return fail(res, 409, 'host-conflict');
        if (!rec || digest(JSON.stringify(rec.mirror)) !== digest(JSON.stringify(mirror))) commit(s => { s[b.roomId] = { ...s[b.roomId], roomId: b.roomId, hostVerifier: digest(bearer(req)), deviceId: b.deviceId, mirror: structuredClone(mirror), generation: mirror.generation, bans: mirror.bans ?? [], deleted: false }; });
        leases.set(b.roomId, { deviceId: b.deviceId, instance: b.instance, expires: now() + leaseMs });
        return send(res, 200, { ok: true, leaseMs, online: online(b.roomId) });
      }
      if (p === '/hosting/unregister') {
        if (!hostAllowed(req, b.roomId)) return fail(res, 403, 'host-auth');
        if (!b.deleted && leases.has(b.roomId) && leases.get(b.roomId).instance !== b.instance) return fail(res, 409, 'host-conflict');
        if (b.deleted) commit(s => { s[b.roomId].deleted = true; });
        leases.delete(b.roomId); tunnels.get(b.roomId)?.close(1001, 'unregistered'); tunnels.delete(b.roomId); return send(res, 200, { ok: true });
      }
      if (rate.blocked(remote)) { res.setHeader('Retry-After', '60'); return send(res, 429, { ok: false, error: 'rate-limited', retryAfter: 60 }); }
      if (!rec || rec.deleted) return fail(res, rec ? 410 : 404, rec ? 'deleted' : 'no-project');
      if (p === '/hosting/challenge') {
        if (!isUsername(b.username) || !isDeviceId(b.deviceId) || !['creator', 'member'].includes(b.as)) return fail(res, 400, 'bad-request');
        const c = b.as === 'creator' ? rec.mirror.creator : rec.mirror.mode === 'free' ? rec.mirror.project : rec.mirror.list.find(c => c.username === b.username);
        return send(res, 200, { ok: true, nonce: challenges.issue([b.roomId, b.username, b.deviceId, b.as]), salt: c?.salt ?? secret().slice(0, 22), kdf: rec.mirror.kdf });
      }
      if (p === '/hosting/resolve') {
        const fields = [b.roomId, b.username, b.deviceId, b.as, b.nonce];
        const c = b.as === 'creator' && rec.mirror.creator.username === b.username ? rec.mirror.creator : b.as === 'member' ? rec.mirror.mode === 'free' ? rec.mirror.project : rec.mirror.list.find(c => c.username === b.username) : null;
        if (banned(rec, b.username, b.deviceId)) return fail(res, 403, 'banned');
        if (challenges.check(b.nonce, fields.slice(0, 4)) !== 'ok' || !c || !equal(b.proof, hostingProof(c.key, fields))) { rate.fail(remote); return fail(res, 401, 'unauthorized'); }
        if (!online(b.roomId)) return fail(res, 503, 'host-offline');
        const access = secret(); accesses.set(digest(access), { roomId: b.roomId, username: b.username, deviceId: b.deviceId, generation: rec.generation, expires: now() + HOSTING.accessMs });
        return send(res, 200, { ok: true, roomId: b.roomId, name: rec.mirror.name, mode: rec.mirror.mode, access, expires: now() + HOSTING.accessMs,
          direct: rec.mirror.direct ?? null, relay: `/hosting/relay/${b.roomId}` });
      }
      if (p === '/hosting/authorize-asset') {
        const access = accessOf(req, b.roomId);
        if (!access || typeof b.ticket !== 'string' || b.ticket.length > 4096) return fail(res, 401, 'unauthorized');
        assetGrants.set(digest(b.ticket), { roomId: b.roomId, username: access.username, deviceId: access.deviceId, generation: rec.generation, expires: Math.min(access.expires, now() + HOSTING.accessMs) }); return send(res, 200, { ok: true });
      }
      fail(res, 404, 'no-endpoint');
    } catch { if (!res.headersSent) fail(res, 400, 'bad-request'); else res.destroy(); }
  };
  const server = http.createServer(handle);
  server.on('connection', socket => { rawSockets.add(socket); socket.once('close', () => rawSockets.delete(socket)); });
  const handleUpgrade = (req, socket, head) => {
    rawSockets.add(socket); socket.once('close', () => rawSockets.delete(socket));
    const p = new URL(req.url, 'http://localhost').pathname;
    const host = /^\/hosting\/tunnel\/(sp_[a-z2-7]{26})$/.exec(p);
    if (host) {
      const id = host[1];
      const instance = String(req.headers['sec-websocket-protocol'] || '').split(',').map(s => s.trim()).find(s => s.startsWith('promptcut.instance.'))?.slice('promptcut.instance.'.length);
      if (!hostAllowed(req, id) || (leases.get(id)?.expires || 0) <= now() || leases.get(id)?.instance !== instance || tunnels.has(id)) return rejectUpgrade(socket, 403, 'Forbidden');
      const ws = acceptUpgrade(req, socket, head, { protocol: 'promptcut.tunnel.v1', maxPayload: 1024 * 1024 }); if (!ws) return;
      tunnels.set(id, ws);
      ws.on('message', raw => {
        try {
          const m = JSON.parse(raw), channel = channels.get(m.id); if (!channel || channel.roomId !== id) return;
          if (m.type === 'data') {
            const data = Buffer.from(m.data, 'base64'); channel.queued += data.length;
            if (channel.queued > 4 * 1024 * 1024) { channel.socket.destroy(); return; }
            ws.send(JSON.stringify({ type: 'pause', id: m.id }));
            const wait = bandwidth.reserve(channel.user, data.length);
            channel.delivery = channel.delivery.then(() => new Promise(r => setTimeout(r, wait))).then(() => {
              channel.queued -= data.length;
              if (!channel.socket.destroyed && channel.socket.push(data) && !channel.queued) ws.send(JSON.stringify({ type: 'resume', id: m.id }));
            });
          }
          if (m.type === 'close') channel.delivery.then(() => channel.socket.push(null));
        } catch { ws.close(1002, 'bad-frame'); }
      });
      ws.on('close', () => { if (tunnels.get(id) === ws) tunnels.delete(id); for (const [key, ch] of channels) if (ch.roomId === id) { ch.socket.destroy(); channels.delete(key); } });
      return;
    }
    const member = /^\/hosting\/relay\/(sp_[a-z2-7]{26})\/doc\/?$/.exec(p);
    if (!member || !(accessOf(req, member[1]) || grantOf(req, member[1]))) return rejectUpgrade(socket, 401, 'Unauthorized');
    if (!online(member[1])) return rejectUpgrade(socket, 503, 'Unavailable');
    const principal = accessOf(req, member?.[1]) ?? grantOf(req, member?.[1]);
    let bridge; try { bridge = openChannel(member[1], 'doc', req.socket.remoteAddress, JSON.stringify([member[1], principal.username, principal.deviceId])); } catch { return rejectUpgrade(socket, 503, 'Unavailable'); }
    const headers = { ...req.headers, 'x-forwarded-for': forwardedRemote(req), 'x-pc-stage-client': 'hosting-relay' }; delete headers.origin;
    bridge.write(`GET / HTTP/1.1\r\n${Object.entries(headers).map(([k,v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
    if (head.length) bridge.write(head); socket.pipe(bridge).pipe(socket);
    socket.on('error', () => {}); socket.on('close', () => bridge.destroy()); bridge.on('error', () => socket.destroy());
  };
  server.on('upgrade', handleUpgrade);
  return { server, handle, handleUpgrade, online, async listen(port = 0, host = '127.0.0.1') { await new Promise((r, j) => { server.once('error', j); server.listen(port, host, r); }); return server.address(); },
    async close() { clearInterval(timeout); for (const ws of tunnels.values()) ws.close(1001, 'shutdown'); for (const ch of channels.values()) ch.socket.destroy(); for (const socket of rawSockets) socket.destroy(); if (server.listening) await new Promise(r => { server.close(r); server.closeAllConnections(); }); } };
}
