import { hostingKey, hostingProof, ROUTE_PROTOCOL } from './protocol.mjs';
import { deriveKey } from '../auth/client.mjs';

async function post(service, endpoint, body, access) {
  const r = await fetch(`${service.replace(/\/+$/, '')}/hosting/${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(access ? { 'x-pc-hosting-access': access } : {}) }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(10000) });
  const j = await r.json(); if (!r.ok || !j.ok) throw Object.assign(new Error('房间发现失败'), { reason: j.error, status: r.status, retryAfter: j.retryAfter }); return j;
}
export async function discoverRoom({ service, roomId, username, deviceId, as, key, password, onKey }) {
  const ch = await post(service, 'challenge', { roomId, username, deviceId, as });
  const k = key || await deriveKey(password, ch.salt, ch.kdf);
  onKey?.(k);
  const proof = hostingProof(hostingKey(k, roomId), [roomId, username, deviceId, as, ch.nonce]);
  const r = await post(service, 'resolve', { roomId, username, deviceId, as, nonce: ch.nonce, proof });
  if (r.roomId !== roomId || r.relay !== `/hosting/relay/${roomId}` || !/^[A-Za-z0-9_-]{43}$/.test(r.access || '')) throw Object.assign(new Error('房间身份不匹配'), { reason: 'auth' });
  const base = `${service.replace(/\/+$/, '')}${r.relay}/doc`;
  if (r.where !== undefined && !['lan', 'hosted'].includes(r.where)) throw Object.assign(new Error('房间位置不匹配'), { reason: 'auth' });
  return { where: r.where ?? 'lan', projectId: roomId, service, name: r.name, mode: r.mode, base, access: r.access,
    asset: `${service.replace(/\/+$/, '')}${r.relay}/asset/api/asset`, routeProtocol: ROUTE_PROTOCOL + r.access };
}
export function relayFetch(access) {
  return (url, init) => fetch(url, { ...init, redirect: 'error', headers: { ...init?.headers, 'x-pc-hosting-access': access } });
}
export async function authorizeRelayAsset(candidate, ticket) {
  if (candidate.access) await post(candidate.service, 'authorize-asset', { roomId: candidate.projectId, ticket }, candidate.access);
}
