import fs from 'node:fs';
import path from 'node:path';
import { operationFixture } from './operation-wiring-fixture.mjs';
import { stateBlobName } from '../docservice/modules/project.mjs';
const [dir, cut] = process.argv.slice(2);
const fault = prefix => phase => { if (`${prefix}:${phase}` === cut) process.exit(73); };
const f = await operationFixture({ dir, port: 5761, failpoint: fault('doc'), historyFailpoint: fault('history'),
  accountFailpoint: fault('account'), projectionFailpoint: fault('projection'), acknowledgeFence: async () => {
    const saved = JSON.parse(f.store.readBlob(stateBlobName(f.projectId)));
    if (saved.rev !== 2 || saved.project.title !== 'complete tool result') throw Error('projection-not-complete');
    return { durable: true, projectRev: saved.rev };
  } });
const a = await f.connect(), b = await f.connect('b');
b.send({ type: 'project.open', projectId: f.projectId });
await b.next(m => m.type === 'project.state');
const effects = fs.openSync(path.join(dir, 'external-effects.ndjson'), 'a');
try { fs.writeSync(effects, '{"effect":"fixture-tool-result-once"}\n'); fs.fsyncSync(effects); } finally { fs.closeSync(effects); }
a.send({ type: 'project.op', projectId: f.projectId, opId: 'crash-op', ops: [{ op: 'set', path: '/title', value: 'complete tool result' }] });
await a.next(m => m.type === 'project.op.ok' || m.type === 'project.op.rejected', 10000);
if (cut.includes('fence-')) await f.coordinator.fence({ id: 'crash-fence', projectId: f.projectId, kind: 'delete' });
await f.close();
process.exit(74); // A requested cut that was not reached is a failure, never silently successful.
