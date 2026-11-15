# Status

## Working

- React dashboard, simulator, fixture agents, SQL evidence, CLI, and local API.
- Five scenarios. The newest, `timeout-no-key`, loses the reply on a service with no idempotency keys, and expects one refund attempt followed by escalation.
- Durable SQL job queue: idempotent submission, row claims, leases, heartbeat renewal, bounded retries, attempt history, and stale-result fencing.
- A fresh subprocess per fixture, real wall-clock deadlines, and graceful worker shutdown.
- Job progress and a recent-queue view in the dashboard. Run history separates fixture evidence from live-model evidence.
- The dashboard has been checked by hand in a browser at desktop and phone widths: all four scenarios, run history and filters, opening saved runs, evidence export, and the error shown when the API is down.
- Claude (Messages API) and OpenAI (Responses API) adapters sharing one prompt, tool set and argument validation, with bounded model calls and output, explicit model selection, prompt fingerprints, and usage metadata. A live trial stops once the simulated tool's call budget is spent.
- An SDK (`packages/sdk`, Apache-2.0, no dependencies) that injects the same four kinds of fault into any tool function, with checks written against the user's own service. It builds as the `faultline-sdk` package.
- An MCP proxy (`packages/mcp`, Apache-2.0) that sits between an agent and any stdio MCP server, injects the same four faults into chosen tool calls, and then checks the server's state through its own read tools. It builds as `faultline-mcp-proxy`.
- A runner (`npm run evaluate:mcp`) that drives a Claude model through that proxy against an MCP server for repeated trials, with a fresh id per trial so runs on one account don't collide.
- Repeated-trial CLI and JSON reports covering per-scenario pass rates, assertion counts, and Wilson intervals for live trials only.
- Local PostgreSQL adapter and Compose file.
- CI on GitHub runs the build, tests, demo, regression command, and a fixture evaluation, and passes.
- The product site in `site/` is live at https://getfaultline.vercel.app. Its demo runs the simulator in the browser.

## Not verified

- Only one live model has run the refund scenarios. `claude-sonnet-5-5` passed all 40 trials of the first four scenarios. On `timeout-no-key` it escalated in 10 of 10 trials with the baseline prompt, and refunded twice in 10 of 10 with the recovery prompt. After the recovery prompt was fixed, it passed 30 of 30 across all five scenarios. The OpenAI adapter hasn't made a live call. See LIVE-EVALUATION.md.
- No team outside this project has used the SDK. It is published on npm as `faultline-sdk`, and its results don't appear in the dashboard.
- The MCP proxy has run against the test server in `tests/fixtures`, the official MCP memory server, which handled a retried write correctly, and GitHub's MCP server on a private test repository. It hasn't found a bug in a real server, and it isn't on npm. On GitHub's server a dropped reply to `issue_write` led `claude-haiku-5-5` to create a duplicate issue in 9 of 10 trials, because the search it used to check was a few seconds behind, while `claude-sonnet-5-5` passed 3 of 3. That is one repository, one task and small samples, and the failure is delivered the moment the write lands, which is the worst case for a read that lags. Five more plans covered the other faults on the same server: a lost write, an empty reply, a rate limit, a two-step task and a broken read. Haiku passed between 1 and 10 of 10, and Sonnet failed the broken read 0 of 3. See `docs/LIVE-EVALUATION.md`.
- Docker is unrun. Networked PostgreSQL has run, since the AWS worker and API use RDS, but workers competing for the same jobs on a real server haven't been tested. Existing concurrency tests use the embedded engine's single connection.
- The AWS deployment in `infra/` runs fixture trials only. Live model runs stay local, and deploys are manual. See `infra/README.md`.

## Known gaps

- Subprocesses isolate trusted fixtures. They are not a security sandbox, and arbitrary uploaded code is not accepted.
- Live evaluations run through the CLI, separately from the fixture queue. An interrupted live trial keeps the usage metadata known at that point but loses its partial tool trace.
- The MCP runner checks only the server's state. It can't fail a trial for what the trace shows, such as calls inside a rate-limit window, and it records the model's final answer without scoring it. It has no cleanup between trials and no cost limit.
- The AWS API has one shared API key. Per-user authentication, tenant isolation, container deployment, and outside validation are still open.

## Running locally

Embedded PostgreSQL has one owning process, so stop the server before CLI or evaluation work against the same database, or point at server PostgreSQL. `npm run build && npm start` serves the built dashboard on 4310. `npm run dev` runs the API on 4310 with Vite on 5173.

See QUEUE.md, LIVE-EVALUATION.md, and ROADMAP.md.
