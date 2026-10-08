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
  assert.equal(cloudConsentState().accountId, null);
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

test('a delayed pre-accept GET cannot overwrite the durable accepted POST', async () => {
  let releaseRead;
  const oldRead = new Promise(resolve => { releaseRead = resolve; });
  const client = createAccountClient({ online:false, origin:'https://visuhive.com', device, now:() => 1000,
    native:async (operation, args) => operation === 'recover' ? credential : args.body
      ? { ok:true, accountId:account.id, accepted:true, noticeVersion:1 }
      : oldRead });
  await client.restore(); setCloudConsentSource({ client, accountId:account.id });
  const pending = refreshCloudConsent();
  await acceptCloudConsent();
  releaseRead({ ok:true, accountId:account.id, accepted:false, noticeVersion:1 });
  assert.equal(await pending, false);
  assert.equal(cloudConsentState().accepted, true);
  setCloudConsentSource(null);
});

test('a superseded false GET never borrows cached accepted=true as a fresh send permit', async () => {
  let releaseFirst, releaseSecond, read = 0;
  const first = new Promise(resolve => { releaseFirst = resolve; });
  const second = new Promise(resolve => { releaseSecond = resolve; });
  const client = createAccountClient({ online:false, origin:'https://visuhive.com', device, now:() => 1000,
    native:async operation => operation === 'recover' ? credential : (++read === 1
      ? { ok:true, accountId:account.id, accepted:true, noticeVersion:1 }
      : read === 2 ? first : second) });
  await client.restore(); setCloudConsentSource({ client, accountId:account.id });
  assert.equal(await refreshCloudConsent(), true);
  const permission = requireCloudConsent().then(() => 'allowed', () => 'denied');
  const newer = refreshCloudConsent();
  releaseFirst({ ok:true, accountId:account.id, accepted:false, noticeVersion:1 });
  const outcome = await permission;
  releaseSecond({ ok:true, accountId:account.id, accepted:false, noticeVersion:1 });
  await newer;
  assert.equal(outcome, 'denied');
  setCloudConsentSource(null);
});

test('an old UI binding cannot borrow a newly logged in account consent', async () => {
  const other = { id:'acc_'+'d'.repeat(24), name:'Other' };
  const consentClient = (identity, loginId) => createAccountClient({ online:false, origin:'https://visuhive.com', device, now:() => 1000,
    native:async operation => operation === 'recover'
      ? { ...credential, account:identity, loginId }
      : { ok:true, accountId:identity.id, accepted:true, noticeVersion:1 } });
  const a = consentClient(account, 'login-A'), b = consentClient(other, 'login-B');
  await a.restore(); await b.restore();
  setCloudConsentSource({ client:a, accountId:account.id });
  const bindingVersion = cloudConsentState().bindingVersion;
  setCloudConsentSource({ client:b, accountId:other.id });
  await assert.rejects(requireCloudConsent({ accountId:account.id, bindingVersion }), error => error.code === 'credential-revoked');
  setCloudConsentSource(null);
});

test('the same account on a new project or login binding cannot reuse an old send permit', async () => {
  const client = createAccountClient({ online:false, origin:'https://visuhive.com', device, now:() => 1000,
    native:async operation => operation === 'recover' ? credential
      : { ok:true, accountId:account.id, accepted:true, noticeVersion:1 } });
  await client.restore();
  setCloudConsentSource({ client, accountId:account.id });
  const oldBinding = { accountId:account.id, bindingVersion:cloudConsentState().bindingVersion };
  setCloudConsentSource({ client, accountId:account.id });
  await assert.rejects(requireCloudConsent(oldBinding), error => error.code === 'credential-revoked');
  await requireCloudConsent({ accountId:account.id, bindingVersion:cloudConsentState().bindingVersion });
  setCloudConsentSource(null);
});
