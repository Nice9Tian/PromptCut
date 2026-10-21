// 安全审查用的一次性探针（REVIEW-consent-once.md）。不进基线：放在 docs/reports/ 下，npm test 的缺省 glob 不收它。
// 跑法：npm test -- docs/reports/REVIEW-consent-once.probe.mjs（文件名故意不带 .test，node --test 的缺省发现规则收不到它）
// 每条用例断言的是「审查时观察到的现状」，不是期望的行为；注释写明它说明了什么。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAccountClient } from '../../src/account/client.ts';
import { CloudConsentRequiredError, cloudConsentState, grantCloudConsent, refreshCloudConsent, requireCloudConsent,
  setCloudConsentSource, subscribeCloudConsent } from '../../src/ai/cloud/consent.ts';

const account = { id:'acc_'+'a'.repeat(24), name:'Probe' };
const device = { deviceId:'review-probe-device', deviceName:'fixture' };
const credentialOf = (loginId) => ({ ok:true, account, loginId, accessToken:'token-'+loginId, accessExpiresAt:100_000 });

function fixture() {
  const counts = { reads:0 };
  const server = { accepted:true, readResult:null };
  const client = createAccountClient({ online:false, origin:'https://visuhive.com', device, now:() => 1000,
    native: async (operation, args) => {
      if (operation === 'recover') return credentialOf('login-1');
      if (operation === 'logout') return { ok:true };
      if (args.body) { server.accepted = true; return { ok:true, accountId:account.id, accepted:true, noticeVersion:1, acceptedAt:1 }; }
      counts.reads++;
      if (server.readResult) return server.readResult;
      return { ok:true, accountId:account.id, accepted:server.accepted, noticeVersion:1, ...(server.accepted ? { acceptedAt:1 } : {}) };
    } });
  return { client, counts, server };
}
async function bind(f) {
  await f.client.restore();
  setCloudConsentSource({ client:f.client, accountId:account.id });
  return { accountId:account.id, bindingVersion:cloudConsentState().bindingVersion };
}

test('P1 一次性：同一张许可被两条发送同时拿去用，只有一条免读，另一条退回真读', async () => {
  const f = fixture(); const binding = await bind(f);
  const permit = await grantCloudConsent(binding);
  assert.equal(f.counts.reads, 1);
  f.server.accepted = false; // 服务端在发许可之后改成不同意
  const [a, b] = await Promise.allSettled([requireCloudConsent(binding, permit), requireCloudConsent(binding, permit)]);
  // 第一条同步核许可当场通过（不读）；第二条看到 used=true，退回真读，读到「不同意」被拒
  assert.equal(a.status, 'fulfilled');
  assert.equal(b.status, 'rejected');
  assert.ok(b.reason instanceof CloudConsentRequiredError);
  assert.equal(f.counts.reads, 2);
  setCloudConsentSource(null);
});

test('P2 窗口：许可发出后服务端撤掉告知（页面不知道），5 秒内页面这一关放行——只能靠服务端 send 的 checkConsent 拦', async () => {
  const f = fixture(); const binding = await bind(f);
  const permit = await grantCloudConsent(binding);
  f.server.accepted = false; // 账号服务那边已经不同意，但没有任何事件通知页面
  await requireCloudConsent(binding, permit); // 页面放行
  assert.equal(f.counts.reads, 1);
  setCloudConsentSource(null);
});

test('P3 窗口：许可发出后凭证在服务端被吊销（页面账号客户端没察觉），5 秒内页面这一关放行——只能靠服务端 authorizePrincipal 拦', async () => {
  const f = fixture(); const binding = await bind(f);
  const permit = await grantCloudConsent(binding);
  f.server.readResult = { ok:false, status:401, code:'credential-revoked' }; // 服务端已吊销，但页面没收到 authChanged
  await requireCloudConsent(binding, permit); // 页面放行
  assert.equal(f.counts.reads, 1);
  // 改前的第二次读取会在这里拿到 401 credential-revoked；改后要等服务端回绝，界面上看到的是服务端回的错误码
  await assert.rejects(requireCloudConsent(binding, null), e => e?.code === 'credential-revoked');
  setCloudConsentSource(null);
});

test('P4 误弹告知框：开头读取已读到「已同意」，但在 grant 续跑之前别处又起了一次读取，grant 回 null（面板会当成没同意、弹告知框）', async () => {
  const f = fixture(); const binding = await bind(f);
  let fired = false;
  const off = subscribeCloudConsent(() => {
    const s = cloudConsentState();
    // 只在第一次读到「已同意」那一刻，模拟别处（另一条发送、附件、绑定 effect）紧接着起一次读取
    if (!fired && s.accepted === true && !s.pending) { fired = true; queueMicrotask(() => { void refreshCloudConsent(binding).catch(() => {}); }); }
  });
  try {
    const refreshResultWouldBe = true; // 改前 consentForUse 用的是 refreshCloudConsent 的返回值：这里是 true
    const permit = await grantCloudConsent(binding);
    assert.equal(refreshResultWouldBe, true);
    assert.equal(permit, null, 'grant 因 state.pending=true 回 null；consentForUse 据此 setConsentOpen(true)');
  } finally { off(); setCloudConsentSource(null); }
});

test('P5（改前已有）两条发送几乎同时开头读取：先发的那条读取被后一条取代，回 null', async () => {
  const f = fixture(); const binding = await bind(f);
  const [a, b] = await Promise.all([grantCloudConsent(binding), grantCloudConsent(binding)]);
  assert.equal(a, null); // 改前 refreshCloudConsent 同样回 false，面板同样弹告知框，不是本次引入
  assert.ok(b);
  setCloudConsentSource(null);
});

test('P6 绑定先抛错时许可不会被作废，但它绑死的 generation 已变，之后也永远核不过', async () => {
  const f = fixture(); const binding = await bind(f);
  const permit = await grantCloudConsent(binding);
  setCloudConsentSource({ client:f.client, accountId:account.id }); // 重新绑定
  await assert.rejects(requireCloudConsent(binding, permit), e => e?.code === 'credential-revoked');
  const next = { accountId:account.id, bindingVersion:cloudConsentState().bindingVersion };
  const before = f.counts.reads;
  await requireCloudConsent(next, permit); // 退回真读
  assert.equal(f.counts.reads, before + 1);
  setCloudConsentSource(null);
});
