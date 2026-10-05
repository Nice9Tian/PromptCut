import { createHostingService } from './service.mjs';
const dir = process.env.PROMPTCUT_HOSTING_DATA;
if (!dir) throw new Error('PROMPTCUT_HOSTING_DATA is required');
const service = createHostingService({ dir });
const addr = await service.listen(Number(process.env.PROMPTCUT_HOSTING_PORT || 8790), process.env.PROMPTCUT_HOSTING_HOST || '127.0.0.1');
console.log(JSON.stringify({ event: 'hosting.listen', port: addr.port, role: 'hosting' }));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void service.close().then(() => process.exit(0)); });
