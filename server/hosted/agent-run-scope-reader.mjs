/** Read-only root chain source. Does not write a Doc row or finalize a run. */
import path from 'node:path';
import { rootDirectory, rootRead } from './deploy/asset-root-registry-publisher.mjs';
import { failScope, sameScope, validateAgentScopeExpected, validateAgentScopeHistory } from './agent-run-scope-schema.mjs';

export async function loadAgentScopeChain(read, current) {
  if (!Number.isSafeInteger(current?.epoch) || current.epoch < 1 || current.epoch > 100000) failScope('history');
  const anchor = await read('anchor.json'), entries = [];
  for (let epoch = 1; epoch <= current.epoch; epoch++) {
    const entry = { record: await read(`epoch-${epoch}.json`), reservation: await read(`reservation-${epoch}.json`),
      assignment: await read(`assignment-${epoch}.json`), terminal: await read(`terminal-${epoch}.json`),
      intent: await read(`intent-${epoch}.json`), closure: await read(`closure-${epoch}.json`),
      publications: {} };
    for (const phase of ['ready', 'bound', 'closed']) entry.publications[phase] = await read(`publication-${epoch}-${phase}.json`);
    entries.push(entry);
  }
  return { anchor, entries, current };
}
/** Exported pure IO composition for fault tests; production callers use the
 * root-file reader below. An injected read function is not root authentication. */
export async function inspectAgentScopeSource({ read, expected, configuredAnchorDigest, checkpoint = null }) {
  validateAgentScopeExpected(expected);
  if (await read('.publisher.lock')) failScope('publisher-locked');
  const current = await read('current.json');
  const chain = await loadAgentScopeChain(read, current);
  const result = validateAgentScopeHistory({ ...chain, expected, configuredAnchorDigest, checkpoint, locked: false });
  // Lock first and last, head double-read: never import across publication.
  if (!sameScope(current, await read('current.json')) || await read('.publisher.lock')) failScope('source-changed');
  return result;
}
export function createAgentScopeReader({ registryDir, expected, configuredAnchorDigest }) {
  validateAgentScopeExpected(expected);
  if (typeof registryDir !== 'string' || !path.isAbsolute(registryDir)) failScope('directory');
  return Object.freeze({
    async read({ checkpoint = null } = {}) {
      if (process.platform !== 'linux') failScope('linux-required');
      await rootDirectory(registryDir);
      return inspectAgentScopeSource({ read: name => rootRead(path.join(registryDir, name), true), expected, configuredAnchorDigest, checkpoint });
    },
  });
}
