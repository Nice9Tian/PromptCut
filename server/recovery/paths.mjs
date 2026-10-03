import path from 'node:path';

/** Shared by the document service and its asset ticket verifier. */
export function localDocumentDir(root, env = process.env) {
  return env.PROMPTCUT_DOCSERVICE_DATA || path.join(env.PROMPTCUT_DATA_DIR || path.join(root, 'out'), 'docservice');
}
export function recoveryDir(root, env = process.env) {
  return path.join(env.PROMPTCUT_DATA_DIR || path.join(root, 'out'), 'collaboration');
}
