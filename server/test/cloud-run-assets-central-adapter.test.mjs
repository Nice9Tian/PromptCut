import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRunAssetsInstanceAdapter } from '../hosted/run-assets-instance-adapter.mjs';

const agentPin = 'a'.repeat(64), assetPin = 'b'.repeat(64), binding = 'c'.repeat(64);
function socket(pin = assetPin) {
  const value = new EventEmitter();
  Object.assign(value, { encrypted: true, authorized: true, destroyed: false,
    getPeerCertificate: () => ({ fingerprint256: pin }), exportKeyingMaterial: () => Buffer.alloc(32, 7) });
  return value;
}
const observation = { assetInstanceId: 'asset-one', assetServiceIdentity: 'asset-kid', assetLeaseId: 'lease-one',
  agentFingerprint256: agentPin, agentServiceKid: 'agent-kid', authenticationId: 'caller-supplied-id',
  channelBinding: binding, open: true };

test('private observed subject is minted by the pinned current socket, not body authenticationId', () => {
  const owned = socket(); let assetId = 'asset-one', agentLive = true, checks = 0;
  const adapter = createRunAssetsInstanceAdapter({ agentFingerprint256: agentPin, assetFingerprint256: assetPin,
    agentServiceKid: 'agent-kid', currentAgent: () => agentLive ? { serviceId: 'agent', serviceKid: 'agent-kid' } : null,
    currentAsset: () => { checks++; return { assetInstanceId: assetId, serviceIdentity: 'asset-kid' }; } });
  const observer = { socket: owned, assetInstanceId: 'asset-one', serviceIdentity: 'asset-kid' };
  const opened = adapter.open({ observer, observation });
  assert.notEqual(opened.servicePrincipal.authenticationId, observation.authenticationId);
  assert.match(opened.servicePrincipal.authenticationId, /^asset-observed:/);
  assert.deepEqual(adapter.transportFor(opened.servicePrincipal), { serviceId: 'agent', serviceKid: 'agent-kid',
    authenticationId: opened.servicePrincipal.authenticationId, channelBinding: binding });
  assert.ok(checks >= 2, 'current asset registry is rechecked on use');
  assetId = 'asset-two'; assert.throws(() => adapter.transportFor(opened.servicePrincipal), { code: 'asset-observer-forbidden' });
  assetId = 'asset-one'; agentLive = false;
  assert.throws(() => adapter.transportFor(opened.servicePrincipal), { code: 'run-service-forbidden' });
  agentLive = true; owned.destroyed = true; owned.emit('close');
  assert.equal(adapter.has(opened.servicePrincipal), false);
  assert.throws(() => adapter.transportFor(opened.servicePrincipal), { code: 'run-service-forbidden' });
  adapter.close();
});

test('wrong TLS certificate and self-reported current asset identity never open a subject', () => {
  const adapter = createRunAssetsInstanceAdapter({ agentFingerprint256: agentPin, assetFingerprint256: assetPin,
    agentServiceKid: 'agent-kid', currentAgent: () => ({ serviceId: 'agent', serviceKid: 'agent-kid' }),
    currentAsset: () => ({ assetInstanceId: 'asset-one', serviceIdentity: 'asset-kid' }) });
  assert.throws(() => adapter.open({ observer: { socket: socket(agentPin), ...observation }, observation }),
    { code: 'asset-observer-forbidden' });
  assert.throws(() => adapter.open({ observer: { socket: socket(), assetInstanceId: 'asset-two',
    serviceIdentity: 'asset-kid' }, observation }), { code: 'asset-observer-forbidden' });
  assert.throws(() => adapter.open({ observer: { socket: socket(), assetInstanceId: 'asset-one',
    serviceIdentity: 'asset-kid' }, observation: { ...observation, agentFingerprint256: assetPin } }),
  { code: 'asset-observer-forbidden' });
  adapter.close();
});
