import test from 'node:test';
import assert from 'node:assert/strict';
import { startAccountRealRunnerFixture, REAL_RUNNER_PROMPT, REAL_RUNNER_NAME, REAL_RUNNER_TEXT } from './fixtures/account-real-runner.mjs';

test('actual hosted factory signs WSS/project.open, executes real tools and commits doc revision; settlement stays pending',
  { timeout: 90000 }, async () => {
    let fixture, actor, failure;
    try {
      fixture = await startAccountRealRunnerFixture(); actor = await fixture.connectActor(0);
      const conversationId = 'actual_runner_conversation';
      const posted = await actor.agent('/conversations/' + conversationId + '/messages', {
        prompt: REAL_RUNNER_PROMPT, requestId: 'actual_runner_message', selectionSnapshot: { pageId: actor.pageId } });
      assert.equal(posted.status, 202, 'send status; safe code=' +
        (/^[a-z0-9-]{1,80}$/.test(posted.body?.code ?? '') ? posted.body.code : 'unclassified'));
      assert.equal(posted.body.runId, null);
      const deadline = Date.now() + 40000; let rows;
      for (;;) {
        rows = fixture.rows(fixture.projectId, conversationId);
        if (rows.some(row => row.event.type === 'runner_done') && fixture.describe().activeRuns === 0) break;
        if (Date.now() >= deadline) throw Object.assign(Error('actual-runner-output-timeout'), { diagnostics: fixture.describe(),
          events: rows.map(row => ({ type: row.event.type, name: row.event.name, code: row.event.code, ok: row.event.ok })) });
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const tools = rows.filter(row => row.event.type === 'tool_result');
      assert.deepEqual(tools.map(row => row.event.name), ['get_project', 'get_selection', 'report_progress', 'set_project_meta']);
      assert.ok(tools.every(row => row.event.ok === true));
      assert.equal(rows.filter(row => row.event.type === 'text').map(row => row.event.delta).join(''), REAL_RUNNER_TEXT);
      const state = await actor.send({ type: 'project.open', projectId: fixture.projectId });
      assert.equal(state.type, 'project.state'); assert.ok(state.rev > actor.opened.rev);
      assert.equal(state.body.name, REAL_RUNNER_NAME);
      const run = rows.find(row => row.event.type === 'run');
      const access = await fixture.checkRun(run);
      assert.equal(access.allowed, true); assert.equal(access.runGrant.state, 'active');
      assert.equal(rows.at(-1).event.settlement, 'pending');
      assert.equal(fixture.describe().completionReady, false);
      assert.equal(fixture.describe().dataConnections, 0);
    } catch (error) { failure = error;
    } finally {
      const cleanup = await Promise.allSettled([actor?.close()]);
      const close = await Promise.allSettled([fixture?.close()]);
      const errors = [...cleanup, ...close].filter(row => row.status === 'rejected').map(row => row.reason);
      if (failure) { failure.cleanupErrors = errors; throw failure; }
      if (errors.length) throw new AggregateError(errors, 'actual-runner-owned-close');
      assert.equal(close[0].value?.closed, true); assert.equal(close[0].value?.childClosed, true);
    }
  });
