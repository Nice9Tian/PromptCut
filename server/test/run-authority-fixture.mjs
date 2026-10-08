import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { openAccountLedger, digestOf, appendAccessEvent } from '../account/ledger.mjs';
import { createRunAuthority, canonicalReadRecord } from '../account/run-authority.mjs';
import { openReadIntents } from '../agent/service/read-intents.mjs';
import { instanceFixture } from './agent-instance-fixture.mjs';

export const projectId = 'sp_fixture', conversationId = 'conversation_fixture';
export const servicePrincipal = Object.freeze({ service: 'agent', scope: 'service', serviceKid: 'agent-test-key', authenticated: true });
export const hooksModule = process.env.PROMPTCUT_CONVERSATION_AUTHORITY_MODULE;
export async function runFixture({ dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-run-authority-')), failpoint,
  ledgerFailpoint, intentFailpoint, verifySender, synchronize = async () => {}, clock = { now: 100 }, seed = true } = {}) {
  const source = hooksModule ? pathToFileURL(path.resolve(hooksModule)).href : new URL('../account/conversation-authority.mjs', import.meta.url).href;
  const hooks = await import(source);
  const ledger = openAccountLedger({ file: path.join(dir, 'doc.db'), authorityId: 'doc-run-test', failpoint: ledgerFailpoint });
  if (seed && !ledger.read().projects[projectId]) ledger.transaction(s => {
    s.projects[projectId] = { projectId, status: 'active', creatorAccountId: 'owner', hosted: { agent: true }, bans: {},
      members: { owner: { access: 'rw' }, sender: { access: 'rw' }, other: { access: 'rw' } }, accessRevision: 1 };
    s.conversationsV2 = { [projectId]: { [conversationId]: { v: 2, projectId, id: conversationId,
      ownerAccountId: 'owner', visibility: 'shared', aclRevision: 1, queueRevision: 1, currentRunId: null,
      messages: [] } } };
    s.testServices = { [servicePrincipal.serviceKid]: true };
  });
  const verifyServiceInState = (s, p) => {
    if (!p?.authenticated || p.scope !== 'service' || p.service !== 'agent' || !s.testServices[p.serviceKid]) throw new Error('service-revoked');
    return { serviceId: p.service, serviceKid: p.serviceKid };
  };
  const instances = instanceFixture(ledger, { verifyServiceInState });
  const agentProcess = instances.boot();
  const rawProvider = createRunAuthority({ ledger, conversationHooks: hooks, now: () => clock.now, failpoint,
    instanceAuthority: instances.authority,
    synchronize,
    verifySender: verifySender ?? (async ref => {
      if (ledger.read().revokedLogins[`login:${ref.loginId}`]) throw new Error('credential-revoked');
      return { ...ref, accountEventSeq: ledger.read().accountHead };
    }),
    verifyServiceInState,
  });
  // Test Agent owns one RAM key and signs each requested invocation. This adapter
  // is not a production transport; rawProvider is exposed for negative scope tests.
  const invoked = new Set(['admit', 'confirmRead', 'queryRead', 'checkAccess', 'authorizeQuery', 'resolveRunPrincipal', 'finish']);
  const provider = new Proxy(rawProvider, { get(target, name) {
    if (!invoked.has(name)) return target[name];
    return async input => {
      const supplied = input.servicePrincipal ?? input.principal?.servicePrincipal;
      verifyServiceInState(ledger.read(), supplied);
      const internal = { ...agentProcess.principal, ...supplied, authenticationId: agentProcess.principal.authenticationId };
      const signed = instances.authorize(agentProcess, name, input, { principal: internal });
      const forwarded = input.principal ? { ...input, principal: { ...input.principal, servicePrincipal: signed.principal } }
        : { ...input, servicePrincipal: signed.principal };
      try { return await target[name](forwarded); }
      finally { instances.authority.release(signed.principal.instanceSession); }
    };
  } });
  const intents = openReadIntents({ file: path.join(dir, 'intents.db'), failpoint: intentFailpoint, now: () => clock.now });
  function enqueue(id = 'message1', accountId = 'sender') {
    ledger.transaction(s => {
      const c = s.conversationsV2[projectId][conversationId];
      c.messages.push({ messageId: id, requestId: `send-${id}`, arrivalSeq: c.messages.length + 1,
        senderAccountId: accountId, senderNameAtSend: `${accountId} name`, loginId: `login-${accountId}`,
        credentialId: `credential-${accountId}`, loginGeneration: 1, content: `Full content ${id}\n第二行`,
        contentDigest: digestOf(`Full content ${id}\n第二行`), attachments: [{ assetId: 'asset-1', projectId }],
        selectionSnapshot: { projectId, accountId, pageId: 'page1', selection: { clipIds: ['clip1'] }, sentAt: clock.now, source: 'sent-snapshot' },
        queueState: 'queued' });
    });
  }
  const admit = requestId => provider.admit({ servicePrincipal, projectId, conversationId, requestId: requestId ?? 'admit1' });
  function input(g, requestId = 'read1') {
    const prompt = canonicalReadRecord(g.message, g);
    return { servicePrincipal, projectId, conversationId, messageId: g.messageId, runId: g.runId,
      runGrantId: g.runGrantId, requestId, readIntentId: 'intent1', prompt, promptDigest: digestOf(prompt) };
  }
  function exit(accountId = 'sender') {
    return ledger.transaction(s => {
      s.revokedLogins[`login:login-${accountId}`] = { seq: ++s.accountHead };
      return appendAccessEvent(s, { type: 'login-revoked', accountIds: [accountId], loginIds: [`login-${accountId}`] });
    });
  }
  function privateFence(requestId = 'private1') {
    return ledger.transaction(s => hooks.privateFenceInState(s, { projectId, conversationId, ownerAccountId: 'owner',
      requestId, runHooks: provider.hooks }));
  }
  return { dir, ledger, provider, rawProvider, instances, agentProcess, intents, hooks, enqueue, admit, input, exit, privateFence, clock,
    principal: g => provider.resolveRunPrincipal({ servicePrincipal, projectId, runGrantId: g.runGrantId }),
    transport: { confirmRead: args => provider.confirmRead({ ...args, servicePrincipal }), queryRead: args => provider.queryRead({ ...args, servicePrincipal }) },
    close() { instances.close(); intents.close(); ledger.close(); } };
}
