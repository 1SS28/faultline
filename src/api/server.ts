import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import { connectDatabase } from '../db/database.js';
import { RunStore } from '../db/store.js';
import { JobStore } from '../jobs/store.js';
import { JobWorker } from '../jobs/worker.js';
import { createApp } from './app.js';

const db = await connectDatabase({ url: process.env.DATABASE_URL, directory: process.env.FAULTLINE_DATA_DIR });
const store = new RunStore(db);
await store.migrate();
const app = createApp(store);
const worker = process.env.FAULTLINE_WORKER === 'external' ? undefined : new JobWorker(new JobStore(db, store));
if (!worker && !process.env.DATABASE_URL) throw new Error('External worker mode requires DATABASE_URL');
app.addHook('onClose', async () => { await worker?.stop(); await db.close(); });
const webRoot = fileURLToPath(new URL('../../dist/web', import.meta.url));
if (existsSync(webRoot)) {
  await app.register(fastifyStatic, { root: webRoot, prefix: '/' });
}

const port = Number(process.env.PORT ?? 4310);
const host = process.env.HOST ?? '127.0.0.1';
await app.listen({ port, host });
worker?.start();
console.log(`Faultline listening on http://${host}:${port}`);
console.log('Deterministic fixtures; no live model or payment calls.');
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, async () => {
  await app.close();
});
