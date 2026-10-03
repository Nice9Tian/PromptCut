/** Outbound host tunnel. Targets are fixed local services, never addresses supplied by a project file. */
import net from 'node:net';
import { HOSTING, hostingKey } from './protocol.mjs';

export function mirrorOf(rec, direct = null) {
  const credential = c => ({ ...(c.username ? { username: c.username } : {}), salt: c.salt, key: hostingKey(c.key, rec.projectId) });
  return { name: rec.name, mode: rec.mode, kdf: rec.kdf, creator: credential(rec.creator),
    ...(rec.mode === 'free' ? { project: credential(rec.project) } : { list: rec.list.map(credential) }),
    generation: rec.generation, bans: [...rec.bans], invite: rec.invite ? { ...rec.invite } : null, direct };
}
export function startHostingHost({ service, roomId, hostKey, deviceId, instance, record, docBase, assetBase, direct = null, state = () => {}, renewMs = HOSTING.renewMs }) {
  const trusted = new URL(service); if (!['http:', 'https:'].includes(trusted.protocol) || trusted.username || trusted.password || trusted.search || trusted.hash) throw new Error('untrusted-hosting-service');
  const localDoc = new URL(docBase), localAsset = new URL(assetBase);
  for (const u of [localDoc, localAsset]) if (!['127.0.0.1', '[::1]', 'localhost'].includes(u.hostname) || !['http:', 'https:'].includes(u.protocol)) throw new Error('host target must be loopback');
  let stopped = false, timer, ws, delay = 500, connecting = false;
  const sockets = new Map();
  const base = service.replace(/\/+$/, '');
  const send = m => { if (ws?.readyState === 1) ws.send(JSON.stringify(m)); };
  async function post(endpoint, body) {
    const r = await fetch(`${base}/hosting/${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${hostKey}` }, body: JSON.stringify({ roomId, ...body }), redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (!r.ok) { let j; try { j = await r.json(); } catch {} throw Object.assign(new Error('hosting request rejected'), { status: r.status, reason: j?.error, retryAfter: Number(r.headers.get('retry-after')) || 0 }); }
    return r.json();
  }
  function tunnel() {
    if (ws?.readyState === 1 || ws?.readyState === 0 || stopped) return;
    const url = new URL(`${base}/hosting/tunnel/${roomId}`); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const connection = new WebSocket(url, ['promptcut.tunnel.v1', `promptcut.host.${hostKey}`, `promptcut.instance.${instance}`]); ws = connection;
    connection.addEventListener('open', () => { if (!stopped && ws === connection) state('online'); });
    connection.addEventListener('error', () => {});
    connection.addEventListener('close', () => { if (ws !== connection) return; for (const s of sockets.values()) s.destroy(); sockets.clear(); if (!stopped) state('pending'); });
    connection.addEventListener('message', event => {
      if (ws !== connection) return;
      try {
        const m = JSON.parse(String(event.data));
        if (m.type === 'open') {
          if (stopped || sockets.size >= HOSTING.maxChannels || !['doc', 'asset'].includes(m.kind)) return send({ type: 'close', id: m.id });
          const target = m.kind === 'doc' ? localDoc : localAsset;
          const socket = net.connect({ host: target.hostname.replace(/^\[|\]$/g, ''), port: Number(target.port || 80) });
          socket.on('error', () => {}); sockets.set(m.id, socket);
          socket.on('data', data => {
            if (!ws || ws.readyState !== 1 || ws.bufferedAmount > 4 * 1024 * 1024) return socket.destroy();
            for (let off = 0; off < data.length; off += 32768) send({ type: 'data', id: m.id, data: data.subarray(off, off + 32768).toString('base64') });
          });
          socket.on('close', () => { sockets.delete(m.id); send({ type: 'close', id: m.id }); });
          socket.pcPrefix = m.kind === 'doc' ? localDoc.pathname.replace(/\/$/, '') : '';
          socket.pcFirst = true;
          return;
        }
        const socket = sockets.get(m.id); if (!socket) return;
        if (m.type === 'data') {
          let data = Buffer.from(m.data, 'base64');
          if (socket.pcFirst) {
            socket.pcFirst = false;
            if (socket.pcPrefix) data = Buffer.from(data.toString('latin1').replace(/^([A-Z]+) (\/\S*) HTTP\//, (_all, method, route) => `${method} ${socket.pcPrefix}${route === '/' ? '' : route} HTTP/`), 'latin1');
          }
          socket.write(data);
        }
        if (m.type === 'close') socket.end();
        if (m.type === 'pause') socket.pause();
        if (m.type === 'resume') socket.resume();
      } catch { ws?.close(1002, 'bad-frame'); }
    });
  }
  async function update() {
    if (stopped || connecting) return; connecting = true;
    clearTimeout(timer);
    try {
      const rec = record(); if (!rec) { await stop({ deleted: true }); return; }
      await post('register', { deviceId, instance, mirror: mirrorOf(rec, direct) });
      if (stopped) return;
      tunnel(); delay = 500; state(ws?.readyState === 1 ? 'online' : 'pending'); timer = setTimeout(update, renewMs);
    } catch (e) {
      if (stopped) return;
      const terminal = [401,403,409,410].includes(e.status);
      state(terminal ? e.reason === 'host-conflict' ? 'host-conflict' : 'rejected' : 'pending');
      if (!terminal) { timer = setTimeout(update, Math.max(delay, e.retryAfter * 1000)); delay = Math.min(30000, delay * 2); }
    } finally { connecting = false; }
  }
  async function stop({ deleted = false } = {}) {
    stopped = true; clearTimeout(timer); for (const socket of sockets.values()) socket.destroy(); sockets.clear(); ws?.close();
    try { await post('unregister', { deleted, instance }); } catch { /* lease expiry is authoritative after abnormal exit */ }
  }
  void update();
  return { update, stop };
}
