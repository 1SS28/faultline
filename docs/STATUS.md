# Status

## Working

- React dashboard, simulator, fixture agents, SQL evidence, CLI, and local API.
- Durable SQL job queue: idempotent submission, row claims, leases, heartbeat renewal, bounded retries, attempt history, and stale-result fencing.
- A fresh subprocess per fixture, real wall-clock deadlines, and graceful worker shutdown.
- Job progress and a recent-queue view in the dashboard. Run history separates fixture evidence from live-model evidence.
- The dashboard has been checked by hand in a browser at desktop and phone widths: all four scenarios, run history and filters, opening saved runs, evidence export, and the error shown when the API is down.
- Claude (Messages API) and OpenAI (Responses API) adapters sharing one prompt, tool set and argument validation, with bounded model calls and output, explicit model selection, prompt fingerprints, and usage metadata. A live trial stops once the simulated tool's call budget is spent.
- An SDK (`packages/sdk`, Apache-2.0, no dependencies) that injects the same four kinds of fault into any tool function, with checks written against the user's own service. It builds as the `faultline-sdk` package.
- Repeated-trial CLI and JSON reports covering per-scenario pass rates, assertion counts, and Wilson intervals for live trials only.
- Local PostgreSQL adapter and Compose file.
- CI on GitHub runs the build, tests, demo, regression command, and a fixture evaluation, and passes.
- The product site in `site/` is live at https://getfaultline.vercel.app. Its demo runs the simulator in the browser.

## Not verified

- Only one live model has run: `claude-sonnet-5-5` passed all 40 trials, 5 per scenario with each prompt. The refund tool always offered an idempotency key field, and a scenario without one hasn't been run. The OpenAI adapter hasn't made a live call. See LIVE-EVALUATION.md.
- No team outside this project has used the SDK. It is published on npm as `faultline-sdk`, and its results don't appear in the dashboard.
- Docker is unrun. Networked PostgreSQL has run, since the AWS worker and API use RDS, but workers competing for the same jobs on a real server haven't been tested. Existing concurrency tests use the embedded engine's single connection.
- The AWS deployment in `infra/` runs fixture trials only. Live model runs stay local, and deploys are manual. See `infra/README.md`.

## Known gaps

- Subprocesses isolate trusted fixtures. They are not a security sandbox, and arbitrary uploaded code is not accepted.
- Live evaluations run through the CLI, separately from the fixture queue. An interrupted live trial keeps the usage metadata known at that point but loses its partial tool trace.
- `src/billing/store.ts` and `sql/004_billing.sql` are unreferenced. The schema gets applied on migration, but nothing calls the store and nothing tests it. Either wire it into the evaluation CLI or drop it.
- The `workflow-recovered` assertion treats escalation as a failure in every scenario. That holds for the four current faults, but a fault where escalation is the correct outcome will need a per-scenario expectation.
- The AWS API has one shared API key. Per-user authentication, tenant isolation, container deployment, and outside validation are still open.

## Running locally

Embedded PostgreSQL has one owning process, so stop the server before CLI or evaluation work against the same database, or point at server PostgreSQL. `npm run build && npm start` serves the built dashboard on 4310. `npm run dev` runs the API on 4310 with Vite on 5173.

See QUEUE.md, LIVE-EVALUATION.md, and ROADMAP.md.
