import fs from 'node:fs';
import path from 'node:path';
import { createRunClient } from '../agent-service/run-client.mjs';

const [dir, port] = process.argv.slice(2);
const pki = { key: fs.readFileSync(path.join(dir, 'asset.key')),
  cert: fs.readFileSync(path.join(dir, 'asset.crt')), ca: fs.readFileSync(path.join(dir, 'ca.crt')) };
const fingerprint = fs.readFileSync(path.join(dir, 'doc.fingerprint'), 'utf8').trim();
const client = createRunClient({ origin: `https://127.0.0.1:${port}/`, tls: pki, serverFingerprint256: fingerprint });
process.on('message', async ({ id, action, input }) => {
  try {
    let result;
    if (action === 'register') result = await client.registerInstance();
    else if (action === 'admit') result = await client.admit(input);
    else if (action === 'check') result = await client.checkAccess(input);
    else if (action === 'pending') result = await client.pending();
    else if (action === 'close') { client.close(); result = { closed: true }; }
    else throw new Error('fixture-action-invalid');
    process.send({ id, result });
    if (action === 'close') process.disconnect();
  } catch (error) { process.send({ id, error: { status: error.status ?? null, code: error.code ?? error.message } }); }
});
