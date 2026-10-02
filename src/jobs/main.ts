import { connectDatabase } from '../db/database.js';
import { RunStore } from '../db/store.js';
import { JobStore } from './store.js';
import { JobWorker } from './worker.js';

if (!process.env.DATABASE_URL) throw new Error('A separate worker requires DATABASE_URL. Embedded mode runs its worker inside the API process.');
const db = await connectDatabase({ url: process.env.DATABASE_URL });
await new RunStore(db).migrate();
const worker = new JobWorker(new JobStore(db));
worker.start();
console.log('Faultline worker started. Waiting for durable jobs.');
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, async () => {
  if (closing) return; closing = true;
  await worker.stop(); await db.close();
});
