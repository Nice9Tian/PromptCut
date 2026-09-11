import { gzipSync, gunzipSync } from 'node:zlib';

export const FRAME_ARCHIVE_VERSION = 1;
/** A single gzip/base64 field; prefix/suffix deltas stay inside the compressed block. */
function encode(frames) {
  let previous = '';
  const deltas = [...frames].sort(([a], [b]) => a - b).map(([frame, html]) => {
    let prefix = 0, suffix = 0;
    while (prefix < previous.length && prefix < html.length && previous[prefix] === html[prefix]) prefix++;
    while (suffix < previous.length - prefix && suffix < html.length - prefix && previous[previous.length - suffix - 1] === html[html.length - suffix - 1]) suffix++;
    const delta = [frame, prefix, suffix, html.slice(prefix, html.length - suffix)];
    previous = html;
    return delta;
  });
  return deltas;
}

export function packFrames(key, frames, controls = new Map()) {
  return gzipSync(JSON.stringify({ version: FRAME_ARCHIVE_VERSION, key, deltas: encode(frames),
    controls: [...controls].map(([id, frames]) => [id, encode(frames)]) })).toString('base64');
}
export function unpackFrameArchive(encoded, key) {
  const doc = JSON.parse(gunzipSync(Buffer.from(encoded, 'base64'), { maxOutputLength: 256 * 1024 * 1024 }).toString('utf8'));
  if (doc.version !== FRAME_ARCHIVE_VERSION || doc.key !== key || !Array.isArray(doc.deltas)) throw new Error('Incompatible frame archive');
  return { frames: decode(doc.deltas), controls: new Map((doc.controls || []).map(([id, deltas]) => [id, decode(deltas)])) };
}
export function unpackFrames(encoded, key) { return unpackFrameArchive(encoded, key).frames; }
function decode(deltas) {
  let previous = '', last = -Infinity;
  const frames = new Map();
  for (const [frame, prefix, suffix, middle] of deltas) {
    if (!Number.isSafeInteger(frame) || frame <= last || !Number.isSafeInteger(prefix) || !Number.isSafeInteger(suffix)
      || prefix < 0 || suffix < 0 || prefix + suffix > previous.length || typeof middle !== 'string') throw new Error('Corrupt frame delta');
    previous = previous.slice(0, prefix) + middle + (suffix ? previous.slice(-suffix) : '');
    frames.set(frame, previous);
    last = frame;
  }
  return frames;
}
