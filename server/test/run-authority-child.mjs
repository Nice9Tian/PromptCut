import fs from 'node:fs';
import path from 'node:path';
import { runFixture, projectId } from './run-authority-fixture.mjs';

const [dir, cut] = process.argv.slice(2);
const die = point => { if (point === cut) process.exit(73); };
const f = await runFixture({ dir, failpoint: die, intentFailpoint: die });
try {
  const g = await f.admit();
  const input = f.input(g);
  const intent = f.intents.prepare({ requestId: input.requestId, binding: input, prompt: input.prompt });
  await f.intents.confirm(intent.readIntentId, f.transport);
  if (cut.startsWith('run-fence')) { f.privateFence(); die('run-fence-after-commit'); }
  else if (['credential-event-after-commit', 'credential-retained-after-commit', 'private-after-retained-commit'].includes(cut)) {
    const event = f.exit(); die('credential-event-after-commit');
    f.provider.applyAccessEvent(event); die('credential-retained-after-commit');
    f.privateFence(); die('private-after-retained-commit');
  } else if (cut === 'agent-off-on-after-commit') {
    f.ledger.transaction(s => {
      s.projects[projectId].hosted.agent = false;
      f.provider.hooks.fenceInState(s, { kind: 'agent-disabled', projectId, requestId: 'off1' });
    });
    f.ledger.transaction(s => { s.projects[projectId].hosted.agent = true; });
    die(cut);
  }
  else await f.intents.executeOnce(intent.readIntentId, {
    authorize: async () => f.provider.checkAccess({ principal: await f.principal(g), projectId, action: 'write' }),
    execute: async () => {
      const file = path.join(dir, 'external-effects.ndjson');
      const fd = fs.openSync(file, 'a');
      try { fs.writeSync(fd, `${JSON.stringify({ runId: g.runId, effect: 'fixture-only' })}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      die('external-effect-after-fsync');
    },
  });
  throw new Error(`unreached crash cut ${cut}`);
} finally { f.close(); }
