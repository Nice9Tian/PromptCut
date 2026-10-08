import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunDataClient } from '../agent-service/run-data-client.mjs';

function frame(opcode, payload, fin = true) {
  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const header = Buffer.alloc(bytes.length < 126 ? 2 : bytes.length < 65536 ? 4 : 10);
  header[0] = (fin ? 0x80 : 0) | opcode;
  if (bytes.length < 126) header[1] = bytes.length;
  else if (bytes.length < 65536) { header[1] = 126; header.writeUInt16BE(bytes.length, 2); }
  else { header[1] = 127; header.writeBigUInt64BE(BigInt(bytes.length), 2); }
  return Buffer.concat([header, bytes]);
}

function parser() {
  const client = createRunDataClient({ origin: 'https://localhost',
    tls: { key: 'test-only', cert: 'test-only', ca: 'test-only' }, serverFingerprint256: 'a'.repeat(64),
    runClient: { registerInstance: () => new Promise(() => {}), dataProofFor: () => { throw Error('unexpected-sign'); } } });
  const Bound = client.webSocketFor({ projectId: 'sp_fixture', runGrantId: 'grant_fixture' });
  const ws = new Bound(client.wsUrl, ['promptcut.v1', 'promptcut.session.new']);
  const errors = [], messages = [];
  let destroyed = 0, ended = 0, writes = 0;
  ws.socket = { writable: true, write() { writes++; }, destroy() { destroyed++; }, end() { ended++; } };
  ws.connId = 'conn-fixture';
  ws.addEventListener('error', event => errors.push(event.message));
  ws.addEventListener('message', event => messages.push(event.data));
  return { ws, errors, messages, counts: () => ({ destroyed, ended, writes }),
    close() { ws.end(1000, 'fixture'); } };
}

test('fragmented text obeys aggregate message cap and preserves valid small frames', () => {
  const valid = parser();
  try {
    const text = Buffer.from('{"type":"fixture.valid"}');
    valid.ws.receive(frame(1, text.subarray(0, 10), false));
    valid.ws.receive(frame(9, 'ping'));
    valid.ws.receive(frame(0, text.subarray(10)));
    assert.equal(valid.errors.length, 0);
    assert.equal(valid.messages.length, 1);
    assert.equal(valid.counts().writes, 1);
    assert.equal(JSON.parse(valid.messages[0]).type, 'fixture.valid');
  } finally { valid.close(); }

  const oversized = parser();
  try {
    oversized.ws.receive(frame(1, Buffer.alloc(5 * 1024 * 1024, 32), false));
    oversized.ws.receive(frame(0, Buffer.alloc(5 * 1024 * 1024, 32), false));
    assert.equal(oversized.errors.length > 0, true, 'aggregate >8 MiB must be rejected');
    assert.equal(oversized.messages.length, 0);
  } finally { oversized.close(); }
});

test('control frames require FIN, at most 125 bytes, and valid close payload', () => {
  for (const bytes of [frame(9, 'x', false), frame(10, 'x', false), frame(10, 'x'.repeat(126)),
    frame(8, Buffer.from([1])), frame(8, Buffer.from([0x03, 0xed]))]) {
    const p = parser();
    try { p.ws.receive(bytes); assert.equal(p.errors.length > 0, true);
      assert.equal(p.counts().destroyed > 0, true); }
    finally { p.close(); }
  }
  const valid = parser();
  try {
    valid.ws.receive(frame(9, 'hello'));
    assert.equal(valid.errors.length, 0);
    assert.equal(valid.counts().writes, 1);
  } finally { valid.close(); }
});

test('invalid UTF-8 text and close reasons never reach session messages', () => {
  const invalidText = parser();
  try {
    const bytes = Buffer.concat([Buffer.from('{"type":"fixture","value":"'), Buffer.from([0xff]), Buffer.from('"}')]);
    invalidText.ws.receive(frame(1, bytes));
    assert.equal(invalidText.errors.length > 0, true);
    assert.equal(invalidText.messages.length, 0);
  } finally { invalidText.close(); }

  const invalidClose = parser();
  try {
    invalidClose.ws.receive(frame(8, Buffer.from([0x03, 0xe8, 0xff])));
    assert.equal(invalidClose.errors.length > 0, true);
  } finally { invalidClose.close(); }
});
