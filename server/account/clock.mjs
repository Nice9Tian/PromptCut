import { randomUUID } from 'node:crypto';

/** Clock samples are diagnostics; only a verified account orderSeq determines ordering. */
export function createDiagnosticClock({ wall = Date.now, monotonic = () => process.hrtime.bigint(), bootId = randomUUID() } = {}) {
  return () => ({ utcMs: wall(), monotonicNs: String(monotonic()), bootId, diagnosticOnly: true });
}
