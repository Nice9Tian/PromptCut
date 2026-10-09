import test from 'node:test';
import assert from 'node:assert/strict';
import { startAccountExecutorVisibleFixture } from './fixtures/account-executor-visible.mjs';

test('actual account HTTP SSE projects accepted user scope from FULL doc-bound row before run output',
  { timeout: 30000 }, async () => {
    const fixture = await startAccountExecutorVisibleFixture({ ports: [0, 0, 0] });
    const abort = new AbortController(); let reader, primary;
    try {
      const base = fixture.origin + '/v1/conversations/' + fixture.conversationId;
      const headers = { Authorization: 'Bearer ' + fixture.ticket, 'Content-Type': 'application/json' };
      const response = await fetch(base + '/messages', { method: 'POST', headers,
        body: JSON.stringify({ prompt: 'Doc accepted original', requestId: 'wire_send' }) });
      assert.equal(response.status, 202);
      const accepted = await response.json(); assert.equal(accepted.runId, null);
      const deadline = Date.now() + 5000;
      while (fixture.rows().head < 6 || fixture.describe().activeRuns > 0) {
        if (Date.now() > deadline) throw Error('controlled-driver-durable-drain-timeout');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      const source = fixture.rows().events;
      assert.equal(source[0].event.type, 'user');
      // The stored original is unchanged. Wire scope comes from the real row,
      // not a public request or a rewritten accepted content/event identity.
      assert.equal(source[0].event.projectId, undefined);
      assert.equal(source[0].projectId, fixture.projectId);
      const stream = await fetch(base + '/events?after=0', { headers, signal: abort.signal });
      assert.equal(stream.status, 200); reader = stream.body.getReader();
      let text = '';
      while (!text.includes('runner_done')) {
        const chunk = await reader.read(); assert.equal(chunk.done, false);
        text += new TextDecoder().decode(chunk.value);
      }
      const wire = text.split('\n').filter(row => row.startsWith('data: ')).map(row => JSON.parse(row.slice(6)))
        .filter(row => Number.isSafeInteger(row.seq));
      assert.deepEqual(wire.map(row => row.seq), source.map(row => row.eventSeq));
      const user = wire.find(row => row.type === 'user'), run = wire.find(row => row.type === 'run');
      assert.equal(user.projectId, fixture.projectId); assert.equal(user.conversationId, fixture.conversationId);
      assert.equal(user.messageId, accepted.messageId); assert.equal(user.messageId, run.messageId);
      assert.equal(user.senderAccountId, run.senderAccountId);
      assert.equal(user.prompt, 'Doc accepted original');
      assert.equal(wire.at(-1).settlement, 'pending');
      assert.equal(fixture.describe().grants[0].state, 'active');
    } catch (error) { primary = error;
    } finally {
      abort.abort(); await reader?.cancel().catch(() => {});
      const cleanup = await Promise.allSettled([fixture.close()]);
      if (primary) { primary.cleanupErrors = cleanup.filter(row => row.status === 'rejected').map(row => row.reason); throw primary; }
      for (const row of cleanup) { if (row.status === 'rejected') throw row.reason; assert.equal(row.value.closed, true); assert.equal(row.value.sockets, 0); }
    }
  });
