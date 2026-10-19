# Status

## Working

- React dashboard, simulator, fixture agents, SQL evidence, CLI, and local API.
- Durable SQL job queue: idempotent submission, row claims, leases, heartbeat renewal, bounded retries, attempt history, and stale-result fencing.
- A fresh subprocess per fixture, real wall-clock deadlines, and graceful worker shutdown.
- Job progress and a recent-queue view in the dashboard. Run history separates fixture evidence from live-model evidence.
- The dashboard has been checked by hand in a browser at desktop and phone widths: all four scenarios, run history and filters, opening saved runs, evidence export, and the error shown when the API is down.
- Claude (Messages API) and OpenAI (Responses API) adapters sharing one prompt, tool set and argument validation, with bounded model calls and output, explicit model selection, prompt fingerprints, and usage metadata. A live trial stops once the simulated tool's call budget is spent.
- An SDK (`src/sdk`, `docs/SDK.md`) that injects the same four kinds of fault into any tool function, with checks written against the user's own service.
- Repeated-trial CLI and JSON reports covering per-scenario pass rates, assertion counts, and Wilson intervals for live trials only.
- Local PostgreSQL adapter and Compose file.
- CI on GitHub runs the build, tests, demo, regression command, and a fixture evaluation, and passes.
- A static product site in `site/` builds for Vercel. Its demo runs the simulator in the browser. It has not been deployed.

## Not verified

- No live model call has happened. Both adapters are only tested against simulated responses. The first paid run needs a local API key, a selected model, and `--accept-costs`. See LIVE-EVALUATION.md.
- No team outside this project has used the SDK. It isn't published as a package, and its results don't appear in the dashboard.
- Docker, networked PostgreSQL, and parallel workers against a real PostgreSQL server are unrun. Existing concurrency tests use the embedded engine's single connection.
- No AWS resources exist.

## Known gaps

- Subprocesses isolate trusted fixtures. They are not a security sandbox, and arbitrary uploaded code is not accepted.
- Live evaluations run through the CLI, separately from the fixture queue. An interrupted live trial keeps the usage metadata known at that point but loses its partial tool trace.
- `src/billing/store.ts` and `sql/004_billing.sql` are unreferenced. The schema gets applied on migration, but nothing calls the store and nothing tests it. Either wire it into the evaluation CLI or drop it.
- The `workflow-recovered` assertion treats escalation as a failure in every scenario. That holds for the four current faults, but a fault where escalation is the correct outcome will need a per-scenario expectation.
- Authentication, tenant isolation, SQS/Fargate deployment, and outside validation are all still open.

## Running locally

Embedded PostgreSQL has one owning process, so stop the server before CLI or evaluation work against the same database, or point at server PostgreSQL. `npm run build && npm start` serves the built dashboard on 4310. `npm run dev` runs the API on 4310 with Vite on 5173.

See QUEUE.md, LIVE-EVALUATION.md, and ROADMAP.md.
