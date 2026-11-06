import { fileURLToPath } from 'node:url';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { connectDatabase } from '../../src/db/database.js';
import { RunStore } from '../../src/db/store.js';
import { parseJobInput, processDelivery, RetryLater } from '../../src/jobs/delivery.js';
import { JobStore } from '../../src/jobs/store.js';

interface DatabaseSecret { username: string; password: string; host: string; port: number; dbname: string }

async function connect(): Promise<JobStore> {
  const { SecretString } = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: process.env.DATABASE_SECRET_ARN }));
  const secret = JSON.parse(SecretString ?? '{}') as DatabaseSecret;
  // verify-full checks that the server's certificate was issued by Amazon RDS for this host name.
  const ca = fileURLToPath(new URL('./rds-ca.pem', import.meta.url));
  const url = `postgres://${encodeURIComponent(secret.username)}:${encodeURIComponent(secret.password)}@${secret.host}:${secret.port}/${secret.dbname}`
    + `?sslmode=verify-full&sslrootcert=${encodeURIComponent(ca)}`;
  const db = await connectDatabase({ url });
  const runs = new RunStore(db);
  await runs.migrate(new URL('./sql/', import.meta.url));
  return new JobStore(db, runs);
}

// Kept between invocations on the same Lambda instance. A failed connection is retried next time.
let ready: Promise<JobStore> | undefined;

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  ready ??= connect().catch(error => { ready = undefined; throw error; });
  const jobs = await ready;
  const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];
  for (const record of event.Records) {
    try {
      const job = await processDelivery(jobs, parseJobInput(record.body), record.messageId);
      const run = job.runId ? await jobs.runs.get(job.runId) : undefined;
      console.log(JSON.stringify({
        messageId: record.messageId, jobId: job.id, job: job.status, attempts: job.attempts, error: job.error ?? undefined,
        runId: job.runId ?? undefined, run: run?.status, failedChecks: run?.assertions.filter(check => !check.passed).map(check => check.label),
      }));
    } catch (error) {
      // Reporting only this message as failed lets SQS retry it without redelivering the rest of the batch.
      batchItemFailures.push({ itemIdentifier: record.messageId });
      const log = error instanceof RetryLater ? console.warn : console.error;
      log(JSON.stringify({ messageId: record.messageId, retry: true, error: error instanceof Error ? error.message : String(error) }));
    }
  }
  return { batchItemFailures };
}
