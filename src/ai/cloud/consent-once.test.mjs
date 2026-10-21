// 一次发送只核一次告知：发送开头那次新读取发一张一次性许可，发出前同步核对；许可作废就照旧再读，撤权、换绑、未登录仍被拒绝。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAccountClient } from '../../account/client.ts';
import { CLOUD_CONSENT_PERMIT_TTL_MS, CloudConsentRequiredError, acceptCloudConsent, cloudConsentState, grantCloudConsent,
  refreshCloudConsent, requireCloudConsent, setCloudConsentClockForTest, setCloudConsentSource } from './consent.ts';

const account = { id:'acc_'+'e'.repeat(24), name:'Once' };
const other = { id:'acc_'+'f'.repeat(24), name:'Other' };
const device = { deviceId:'consent-once-device', deviceName:'fixture' };
const credentialOf = (who, loginId) => ({ ok:true, account:who, loginId, accessToken:'token-'+loginId, accessExpiresAt:100_000 });

/** 假账号服务：数对 cloud-agent-consent 的读取（GET）与确认（POST）次数。 */
function fixture({ who = account, accepted = true } = {}) {
  const counts = { reads:0, accepts:0 };
  const server = { accepted, recover: credentialOf(who, 'login-1'), readResult: null };
  const client = createAccountClient({ online:false, origin:'https://visuhive.com', device, now:() => 1000,
    native: async (operation, args) => {
      if (operation === 'recover') return server.recover;
      if (operation === 'logout') return { ok:true };
      if (args.body) { counts.accepts++; server.accepted = true; return { ok:true, accountId:who.id, accepted:true, noticeVersion:1, acceptedAt:1 }; }
      counts.reads++;
      if (server.readResult) return server.readResult;
      return { ok:true, accountId:who.id, accepted:server.accepted, noticeVersion:1, ...(server.accepted ? { acceptedAt:1 } : {}) };
    } });
  return { client, counts, server };
}
async function bind(f, who = account) {
  await f.client.restore();
  setCloudConsentSource({ client:f.client, accountId:who.id });
  return { accountId:who.id, bindingVersion:cloudConsentState().bindingVersion };
}
const rejectsWith = code => error => error?.code === code;

test('改前：面板核一次、发送接口再核一次，一次发送两次读取', async () => {
  const f = fixture(); const binding = await bind(f);
  // 改前的发送路径：CloudAiPanel.consentForUse → refreshCloudConsent；useCloudChat.send → requireCloudConsent
  assert.equal(await refreshCloudConsent(binding), true);
  await requireCloudConsent(binding);
  assert.equal(f.counts.reads, 2);
  setCloudConsentSource(null);
});

test('改后：一次发送只读一次告知（许可在发出前同步核对）', async () => {
  const f = fixture(); const binding = await bind(f);
  const permit = await grantCloudConsent(binding);
  assert.ok(permit);
  await requireCloudConsent(binding, permit);
  assert.equal(f.counts.reads, 1);
  // 连发三条：每条各读一次，不是读一次就一直放行
  for (let i = 0; i < 3; i++) await requireCloudConsent(binding, await grantCloudConsent(binding));
  assert.equal(f.counts.reads, 4);
  setCloudConsentSource(null);
});

test('许可只能用一次：第二次用同一张许可照旧向服务端再读', async () => {
  const f = fixture(); const binding = await bind(f);
  const permit = await grantCloudConsent(binding);
  await requireCloudConsent(binding, permit);
  await requireCloudConsent(binding, permit);
  assert.equal(f.counts.reads, 2);
  f.server.accepted = false;
  await assert.rejects(requireCloudConsent(binding, permit), CloudConsentRequiredError);
  assert.equal(f.counts.reads, 3);
  setCloudConsentSource(null);
});

test('许可过期（例如先放素材库耗时很久）就照旧再读；服务端那时已不同意则拒绝', async () => {
  let t = 10_000; setCloudConsentClockForTest(() => t);
  try {
    const f = fixture(); const binding = await bind(f);
    const permit = await grantCloudConsent(binding);
    t += CLOUD_CONSENT_PERMIT_TTL_MS + 1;
    f.server.accepted = false;
    await assert.rejects(requireCloudConsent(binding, permit), CloudConsentRequiredError);
    assert.equal(f.counts.reads, 2);
  } finally { setCloudConsentClockForTest(null); setCloudConsentSource(null); }
});

test('未同意时不发许可，也不会替用户确认', async () => {
  const f = fixture({ accepted:false }); const binding = await bind(f);
  assert.equal(await grantCloudConsent(binding), null);
  await assert.rejects(requireCloudConsent(binding, null), CloudConsentRequiredError);
  assert.equal(f.counts.reads, 2);
  assert.equal(f.counts.accepts, 0);
  setCloudConsentSource(null);
});

test('中间插进来一次读取说「不同意」：许可作废，再读一次后拒绝', async () => {
  const f = fixture(); const binding = await bind(f);
  const permit = await grantCloudConsent(binding);
  f.server.accepted = false;
  assert.equal(await refreshCloudConsent(binding), false);
  await assert.rejects(requireCloudConsent(binding, permit), CloudConsentRequiredError);
  assert.equal(f.counts.reads, 3);
  setCloudConsentSource(null);
});

test('中间插进来一次还在路上的读取：许可不借用旧结论，等新读取', async () => {
  const f = fixture(); const binding = await bind(f);
  const permit = await grantCloudConsent(binding);
  let release; f.server.readResult = new Promise(resolve => { release = resolve; });
  const inflight = refreshCloudConsent(binding);
  assert.equal(cloudConsentState().pending, true);
  const send = requireCloudConsent(binding, permit).then(() => 'allowed', () => 'denied');
  release({ ok:true, accountId:account.id, accepted:false, noticeVersion:1 });
  await inflight.catch(() => undefined);
  assert.equal(await send, 'denied');
  assert.equal(f.counts.reads, 3);
  setCloudConsentSource(null);
});

test('撤权：许可发出后凭证被换掉（登录身份变了），发送被拒且不读服务端', async () => {
  const f = fixture(); const binding = await bind(f);
  const permit = await grantCloudConsent(binding);
  f.server.recover = credentialOf(account, 'login-2');
  await f.client.restore();
  await assert.rejects(requireCloudConsent(binding, permit), rejectsWith('credential-revoked'));
  assert.equal(f.counts.reads, 1);
  setCloudConsentSource(null);
});

test('撤权：凭证在服务端失效、许可已用掉时，再读拿到 401 被拒', async () => {
  const f = fixture(); const binding = await bind(f);
  const permit = await grantCloudConsent(binding);
  await requireCloudConsent(binding, permit);
  f.server.readResult = { ok:false, status:401, code:'credential-revoked' };
  await assert.rejects(requireCloudConsent(binding, permit), rejectsWith('credential-revoked'));
  setCloudConsentSource(null);
});

test('换绑：许可发出后换了账号，旧许可不能给新账号放行', async () => {
  const a = fixture(); const binding = await bind(a);
  const permit = await grantCloudConsent(binding);
  const b = fixture({ who:other }); const next = await bind(b, other);
  await assert.rejects(requireCloudConsent(binding, permit), rejectsWith('credential-revoked'));
  // 拿旧许可配新绑定也不行：许可作废，退回新读取（读的是新账号自己的告知）
  await requireCloudConsent(next, permit);
  assert.equal(b.counts.reads, 1);
  assert.equal(a.counts.reads, 1);
  setCloudConsentSource(null);
});

test('换绑：同一账号换了项目或重新绑定，旧许可作废', async () => {
  const f = fixture(); const binding = await bind(f);
  const permit = await grantCloudConsent(binding);
  setCloudConsentSource({ client:f.client, accountId:account.id });
  await assert.rejects(requireCloudConsent(binding, permit), rejectsWith('credential-revoked'));
  assert.equal(f.counts.reads, 1);
  setCloudConsentSource(null);
});

test('未登录：许可发出后退出登录，发送被拒；从未登录则发不出许可', async () => {
  const f = fixture(); const binding = await bind(f);
  const permit = await grantCloudConsent(binding);
  await f.client.logout();
  await assert.rejects(requireCloudConsent(binding, permit), rejectsWith('credential-revoked'));
  // 退出后页面状态里已没有账号：拿哪个绑定来都对不上；不带绑定直接问也是「请先登录」
  assert.equal(cloudConsentState().accountId, null);
  const fresh = { accountId:account.id, bindingVersion:cloudConsentState().bindingVersion };
  await assert.rejects(requireCloudConsent(fresh, permit), rejectsWith('credential-revoked'));
  await assert.rejects(grantCloudConsent(fresh), rejectsWith('credential-revoked'));
  await assert.rejects(requireCloudConsent(undefined, permit), rejectsWith('login-required'));
  assert.equal(f.counts.reads, 1);
  setCloudConsentSource(null);
  const g = fixture();
  setCloudConsentSource({ client:g.client, accountId:account.id });
  await assert.rejects(grantCloudConsent({ accountId:account.id, bindingVersion:cloudConsentState().bindingVersion }), rejectsWith('login-required'));
  assert.equal(g.counts.reads, 0);
  setCloudConsentSource(null);
});

test('解绑项目后许可作废', async () => {
  const f = fixture(); const binding = await bind(f);
  const permit = await grantCloudConsent(binding);
  setCloudConsentSource(null);
  await assert.rejects(requireCloudConsent(binding, permit), rejectsWith('credential-revoked'));
});

test('伪造的许可（不是 grantCloudConsent 发的）一律当没有，照旧再读', async () => {
  const f = fixture(); const binding = await bind(f);
  await requireCloudConsent(binding, Object.freeze({ binding }));
  assert.equal(f.counts.reads, 1);
  f.server.accepted = false;
  await assert.rejects(requireCloudConsent(binding, { binding }), CloudConsentRequiredError);
  setCloudConsentSource(null);
});

test('先拒绝后确认：确认之后的发送仍要新读一次才拿得到许可', async () => {
  const f = fixture({ accepted:false }); const binding = await bind(f);
  assert.equal(await grantCloudConsent(binding), null);
  await acceptCloudConsent();
  const permit = await grantCloudConsent(binding);
  assert.ok(permit);
  await requireCloudConsent(binding, permit);
  assert.equal(f.counts.reads, 2);
  assert.equal(f.counts.accepts, 1);
  setCloudConsentSource(null);
});

test('接线：面板的发送路径把开头那次读取的许可交给 chat.send，chat.send 交给 requireCloudConsent', async () => {
  const { readFile } = await import('node:fs/promises');
  const panel = await readFile(new URL('../../editor/right/CloudAiPanel.tsx', import.meta.url), 'utf8');
  const chat = await readFile(new URL('./useCloud.ts', import.meta.url), 'utf8');
  // 面板只经 grantCloudConsent 新读，不再直接 refreshCloudConsent 当发送许可
  assert.match(panel, /const permit = await grantCloudConsent\(expected\)/);
  assert.match(panel, /chat\.send\(text, prepared, staged \?\? undefined, consentPermit\)/);
  assert.equal((panel.match(/sendNow\(.*admission\.permit\)/g) ?? []).length, 4);
  assert.match(chat, /requireCloudConsent\(\{ accountId: cloud\.accountId, bindingVersion: consent\.bindingVersion \}, consentPermit\)/);
});
