# Durable execution

The dashboard submits `POST /api/jobs` and polls `GET /api/jobs/:id`. The API returns 202 after persisting the job. Execution is independent of the browser's connection. Completed evidence remains available through `GET /api/runs/:id`.

## Lifecycle

`queued → running → completed`

An execution/infrastructure error requeues with exponential backoff. Three failed attempts exhaust the default budget and mark the job `errored`. An agent that violates an assertion produces a completed job with a failed run; this is an expected test outcome, not a worker failure.

Each claim acquires a unique lease token for 30 seconds. Heartbeats renew it every 5 seconds. A process that crashes without reporting a result leaves a lease that expires. Another worker can reclaim the job; the previous attempt is retained as expired. Repeated abandoned attempts eventually become terminal.

The worker claims rows using PostgreSQL `FOR UPDATE SKIP LOCKED`. Completion checks the lease token and expiry, locks the row, and saves the run, evidence, and completed job state in one transaction. A stale worker cannot overwrite a newer result. This provides one accepted result, not a claim of exactly-once execution. Each retry starts a new simulation ledger.

An optional `Idempotency-Key` header deduplicates submission. The same key with different scenario/strategy parameters returns HTTP 409.

## Local operation

`npm start` runs a background queue poller beside the API. Each fixture executes in a fresh child process with a 10-second deadline and 128MB V8 heap setting. Database credentials and unrelated environment secrets are not passed to that child.

This is process isolation for trusted built-in fixtures, not a security sandbox. The child has the same OS user privileges; it does not have filesystem/network isolation, and the V8 heap setting does not cap total process RSS. Arbitrary uploaded code is not accepted. Killed attempts preserve attempt/error metadata, not partial child traces.

The embedded PostgreSQL database supports one owning process. For a separate worker, use server PostgreSQL:

```sh
DATABASE_URL=... FAULTLINE_WORKER=external npm start
DATABASE_URL=... npm run worker
```

Multiple server-PostgreSQL workers are supported by the claim design but have not been stress-tested against a real PostgreSQL server. Existing concurrency tests use the embedded engine's single connection. SQS and cloud container orchestration are still future work.

Live OpenAI evaluations currently run through the CLI, separately from the fixture job queue.
