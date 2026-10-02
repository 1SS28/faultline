# Roadmap

## 1. Working failure demonstration (done)

Reproduce lost acknowledgement after commit; compare naive and idempotent retries. Add rate-limit and malformed-response scenarios. Persist traces and side effects in PostgreSQL. Make the CLI usable as a CI regression command.

## 2. Developer-facing inspection (done)

The local React dashboard uses the existing API: scenario/agent selection, run history, a chronological trace, the service ledger, and failed assertion evidence. Keep fixture runs explicitly labeled. Prioritize the working surface over a marketing page.

## 3. Real agent integration (adapter done, live validation pending)

The OpenAI Responses function-tool adapter and repeated-trial CLI are implemented. First live validation requires a selected model, API key, and explicit cost opt-in. Preserve the same tool boundary and state-based assertions. Store model/version/configuration metadata. Run repeated trials and report sample counts and variance; do not present a single passing run as reliability proof.

Add an exported SDK and example agent owned by another developer. The validation milestone is discovering a real bug in that agent.

## 4. Durable execution (local queue done)

API submission is separated from a durable SQL queue and subprocess fixture worker. Lease renewal, stale-writer fencing, bounded retries, crash recovery, and attempt history are implemented and tested locally. Additional production work: Model queued/running/completed/errored states, execution attempts, leases, deadlines, and worker-loss recovery. Make queue delivery idempotent. Keep every retry attempt's evidence; never confuse duplicate job delivery with agent behavior within a run.

Run agent code in restricted, disposable containers before accepting arbitrary code. Limit CPU, memory, wall time, and network access. Add authentication and tenant isolation before hosting.

## 5. AWS deployment

Intended architecture, not deployed:

- API service on ECS/Fargate, behind an authenticated entry point.
- SQS for run jobs and a dead-letter queue for repeated infrastructure errors.
- Fargate workers for isolated execution.
- RDS PostgreSQL for run metadata, structured evidence, and analytical queries.
- S3 for large trace artifacts, referenced by run ID.
- CloudWatch for logs/metrics, IAM task roles, Secrets Manager for credentials.
- Infrastructure as code, TLS, private database networking, retention policies, and budget alerts.

Choose a low-cost development topology before provisioning. No AWS resources have been created. Container execution and server PostgreSQL must be verified before deployment.

## Validation

Ask five engineers shipping agents for their last tool-execution failure. Test whether lost acknowledgements, rate limits, and malformed responses recur in their workflows. Success means an external team installs the adapter, finds a previously unknown failure, and reruns the test after fixing it. Pricing and willingness to pay remain unvalidated.
