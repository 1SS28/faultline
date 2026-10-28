# Faultline

Crash tests for AI agent tool workflows. Inject a failure, inspect the actual side effects, and turn the failure into a repeatable regression test.

Faultline ships a React dashboard, a TypeScript simulation engine, a CLI, a local HTTP API, PostgreSQL persistence, and regression tests. The bundled agents are deterministic fixtures, not live LLMs. Claude and OpenAI adapters are available through the evaluation CLI, with explicit model selection and cost opt-in. A small SDK adds the same faults to your own agent's tools. Nothing is deployed to AWS.

## Run the demo

Requires Node.js 22.12 or newer.

```sh
npm ci
npm run demo
```

The simulated refund commits, but its response times out. A naive agent retries and refunds $258 for a $129 request. A resilient agent reuses a stable idempotency key and refunds $129 exactly once. The demo exits successfully only when it detects the naive failure and verifies the resilient recovery.

No API key, Docker, cloud account, or payment service is needed. Local data uses PGlite (embedded PostgreSQL) in `.faultline/data`, and reports land in `.faultline/reports`. Only one process can own an embedded data directory, so don't run the CLI and the API against the same one. Use server PostgreSQL for multiple processes, or set a different `FAULTLINE_DATA_DIR`.

## Open the dashboard

```sh
npm run build
npm start
```

Open http://127.0.0.1:4310, pick a fault, click Run comparison, and inspect each agent's trace, service ledger, and assertions. Run history revisits saved executions, and Export evidence downloads a comparison as JSON.

For hot reload, run `npm run dev` and open http://127.0.0.1:5173. That starts the API on 4310 and Vite on 5173. The dev proxy assumes the default API port, so stop the normal server first.

Nothing in the dashboard is precomputed. Every comparison executes the simulator and persists evidence through the API, and earlier CLI runs show up in history.

## Product website

`site/` is the public product page. Its demo imports `src/core` and runs the real simulator in the visitor's browser, so it needs no API, database or key.

```sh
npm run dev:site
npm run build:site
npm run preview:site
```

`dev:site` serves on http://127.0.0.1:5174 and `build:site` writes static files to `dist/site`. To host it on Vercel, import the repository with the default settings. `vercel.json` sets the install command, build command and output folder.

## Commands

```sh
npm run check
npm run evaluate -- --provider fixture --agent resilient --trials 3
npm run faultline -- run rate-limit resilient
npm run faultline -- run malformed-response naive
npm run faultline -- history
npm run faultline -- summary
npm start
```

A single `run` exits 1 on a detected regression, 0 on success, and 2 for invalid arguments. The deliberately broken fixture should fail. `npm run demo` compares two agents, so its exit semantics differ.

Scenarios: `baseline`, `timeout-after-commit`, `rate-limit`, `malformed-response`.

## Local API

The API binds to `127.0.0.1:4310` by default. There is no authentication, so keep it local. `.env.example` documents the configuration; environment files are not loaded automatically.

```sh
curl -s http://127.0.0.1:4310/health
curl -s -X POST http://127.0.0.1:4310/api/runs \
  -H 'Content-Type: application/json' \
  -d '{"scenario":"timeout-after-commit","strategy":"naive"}'
curl -s http://127.0.0.1:4310/api/runs
curl -s http://127.0.0.1:4310/api/summary
```

- `GET /api/scenarios`: supported fixtures and failures.
- `POST /api/runs`: run a short deterministic fixture and persist the evidence. Returns 201 even when the tested agent fails.
- `GET /api/runs`: latest 50 runs.
- `GET /api/runs/:id`: full trace, ledger, and assertions.
- `GET /api/summary`: SQL aggregation of pass rates by scenario and agent version.

The dashboard goes through the durable queue instead:

- `POST /api/jobs`: persist a fixture job. An optional `Idempotency-Key` deduplicates requests.
- `GET /api/jobs`: latest jobs and their execution states.
- `GET /api/jobs/:id`: job status and full attempt history.

`POST /api/runs` stays as a synchronous fixture-only compatibility endpoint. `docs/QUEUE.md` covers worker leases, retries, recovery, and operational limits.

## PostgreSQL

The same schema serves embedded development and a PostgreSQL server:

```sh
docker compose up -d db
DATABASE_URL=postgresql://faultline:faultline@localhost:5432/faultline npm run demo
```

The Compose service is for local development only. The container and server-PostgreSQL paths haven't been executed yet, and every database test so far runs against embedded PostgreSQL.

`sql/001_initial.sql` defines normalized runs, events, assertions, and refund evidence, with foreign keys, indexes, and a unique constraint on each run's idempotency keys. Saving a run is atomic. `src/db/store.ts` holds the parameterized queries and the pass-rate aggregation.

## Testing your own agent

To test an agent you already have, wrap the tool functions it calls with the SDK in `packages/sdk` and check your own service's records afterwards. See `packages/sdk/README.md`.

To run a custom agent against the built-in refund scenarios instead, `runAgent(scenario, agentVersion, agent)` takes a trusted TypeScript callback. Route the agent's refund tool through `context.issueRefund` and its waits through `context.wait`, then return `{status: 'completed', refundId}` or `{status: 'escalated'}`. See `src/core/agents.ts` for examples.

The callback runs in this process. It gets no execution sandbox and no wall-clock timeout, so don't point it at untrusted uploaded code. The simulator has a tool-call budget but can't stop an infinite loop inside adapter code. The HTTP API exposes only the two built-in fixtures.

## What the results mean

Assertions inspect the ledger independently of whatever the agent claims. They check for duplicate refunds, the authorized amount, a confirmation matching the right order, and recovery of the workflow. Safe escalation can pass the safety checks while failing the completion check.

Simulation time is virtual: a 1000ms retry delay advances the test clock without sleeping, while `durationMs` records real execution time. The simulator's idempotency behavior assumes the underlying service honors keys with matching semantics, since a client key alone can't make an arbitrary provider idempotent.

These tests establish behavior for the supplied fixtures and failure model, not a general guarantee of agent reliability. The Claude and OpenAI adapters and the repeated-trial CLI work against simulated responses but haven't been verified with paid model calls yet. Arbitrary HTTP fault injection, container isolation, and hosted authentication are still open. See `docs/LIVE-EVALUATION.md`.

## Project map

- `src/core/`: simulator, fixtures, adapter contract, and state-based assertions.
- `src/db/`: embedded and server database adapters, plus transactional persistence.
- `src/api/`: local REST API.
- `src/jobs/`: durable SQL queue, lease management, and subprocess worker.
- `src/agents/`: Claude and OpenAI adapters, sharing one prompt and tool set.
- `packages/sdk/`: fault injection for your own agent's tools, packaged as `faultline-sdk` under Apache-2.0.
- `src/evaluation/`: repeated trials, usage accounting, and JSON reports.
- `src/cli.ts`: demo, regression command, and history.
- `web/src/`: React dashboard and API client.
- `site/`: public product page, deployable to Vercel as static files.
- `tests/`: behavioral, database, and API tests.
- `docs/ROADMAP.md`: next milestones and the intended AWS architecture.
- `docs/STATUS.md`: what works, what isn't verified, and known gaps.

## License

Apache License, Version 2.0. See `LICENSE` and `NOTICE`. The SDK in `packages/sdk` carries its own copy of the same license.
