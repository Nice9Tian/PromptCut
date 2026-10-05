import { sha256, hmacSha256 } from '../auth/pure.mjs';
import { b64urlEncode, b64urlDecode, utf8 } from '../auth/protocol.mjs';
export const HOSTING = Object.freeze({ leaseMs: 30000, renewMs: 10000, accessMs: 15 * 60000, maxChannels: 256, bytesPerSecond: 1024 * 1024 });
export const hostingKey = (key, roomId) => b64urlEncode(sha256(utf8(`PromptCut-hosting-v1\n${roomId}\n${key}`)));
export const hostingProof = (key, fields) => b64urlEncode(hmacSha256(b64urlDecode(key), utf8(JSON.stringify(fields))));
export const ROUTE_PROTOCOL = 'promptcut.route.';
