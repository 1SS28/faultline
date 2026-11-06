import { fileURLToPath } from 'node:url';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { connectDatabase } from '../../src/db/database.js';
import { RunStore } from '../../src/db/store.js';
import { JobStore } from '../../src/jobs/store.js';

export interface Stores { runs: RunStore; jobs: JobStore }
interface DatabaseSecret { username: string; password: string; host: string; port: number; dbname: string }

/** Reads the database password from Secrets Manager, connects over verified TLS and applies migrations. */
export async function openStores(): Promise<Stores> {
  const { SecretString } = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: process.env.DATABASE_SECRET_ARN }));
  const secret = JSON.parse(SecretString ?? '{}') as DatabaseSecret;
  // verify-full checks that the server's certificate was issued by Amazon RDS for this host name.
  const ca = fileURLToPath(new URL('./rds-ca.pem', import.meta.url));
  const url = `postgres://${encodeURIComponent(secret.username)}:${encodeURIComponent(secret.password)}@${secret.host}:${secret.port}/${secret.dbname}`
    + `?sslmode=verify-full&sslrootcert=${encodeURIComponent(ca)}`;
  const db = await connectDatabase({ url });
  const runs = new RunStore(db);
  await runs.migrate(new URL('./sql/', import.meta.url));
  return { runs, jobs: new JobStore(db, runs) };
}

/** Opens the stores once per Lambda instance, and again on the next call if opening failed. */
export function reuseStores(open: () => Promise<Stores> = openStores): () => Promise<Stores> {
  let ready: Promise<Stores> | undefined;
  return () => ready ??= open().catch(error => { ready = undefined; throw error; });
}
