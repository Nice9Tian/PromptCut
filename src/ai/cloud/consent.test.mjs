import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAccountClient } from '../../account/client.ts';
import { acceptCloudConsent, cloudConsentState, refreshCloudConsent, requireCloudConsent, setCloudConsentSource, CloudConsentRequiredError } from './consent.ts';

const account = { id:'acc_'+'c'.repeat(24), name:'Consenter' };
const device = { deviceId:'consent-device', deviceName:'fixture' };
const credential = { ok:true, account, loginId:'login-consent', accessToken:'token-consent', accessExpiresAt:100_000 };

test('a refusal never posts, remains blocked, and the next use asks the server again', async () => {
  const calls = []; let accepted = false;
  const client = createAccountClient({ online:false, origin:'https://visuhive.com', device, now:() => 1000,
    native: async (operation, args) => {
      if (operation === 'recover') return credential;
      if (operation === 'logout') return { ok:true };
      calls.push(args);
      if (args.body) accepted = true;
      return { ok:true, accountId:account.id, accepted, noticeVersion:1 };
    } });
  await client.restore(); setCloudConsentSource({ client, accountId:account.id });
  assert.equal(await refreshCloudConsent(), false);
  await assert.rejects(requireCloudConsent(), CloudConsentRequiredError);
  assert.equal(calls.length, 2);
  assert.equal(calls.some(x => x.body), false);
  assert.equal(cloudConsentState().accepted, false);
  await acceptCloudConsent();
  assert.equal(cloudConsentState().accepted, true);
  await requireCloudConsent();
  assert.equal(calls.filter(x => x.body).length, 1);
  await client.logout();
  assert.equal(cloudConsentState().accepted, null);
  await assert.rejects(requireCloudConsent(), error => error.code === 'login-required');
  setCloudConsentSource(null);
});

test('an old account result cannot re-open consent after project detach', async () => {
  let release;
  const delayed = new Promise(resolve => { release = resolve; });
  const client = createAccountClient({ online:false, origin:'https://visuhive.com', device, now:() => 1000,
    native:async (operation) => operation === 'recover' ? credential : delayed });
  await client.restore(); setCloudConsentSource({ client, accountId:account.id });
  const pending = refreshCloudConsent();
  setCloudConsentSource(null);
  release({ ok:true, accountId:account.id, accepted:true, noticeVersion:1 });
  await assert.rejects(pending, error => error.code === 'credential-revoked');
  assert.equal(cloudConsentState().accepted, null);
});
