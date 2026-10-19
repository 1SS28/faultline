# Live model evaluations

Faultline has adapters for Claude (Anthropic Messages API) and OpenAI (Responses API). Both are tested against simulated responses only. No paid API call has gone to a live model yet.

## Setup

Create an API key just for Faultline, so you can revoke it on its own, and set a spending limit on the account before the first run. Keep the key in your shell or a secret manager. Never commit it or paste it into an issue.

| Provider | Key | Model (or pass `--model`) |
|---|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` | `ANTHROPIC_MODEL`, for example `claude-opus-5-5` |
| `openai` | `OPENAI_API_KEY` | `OPENAI_MODEL` |

The program never picks a model for you, and sends nothing until it has the key, a model, and `--accept-costs`.

Stop the dashboard before using the same embedded database from this CLI. Alternatively, configure server PostgreSQL with `DATABASE_URL` or choose a separate embedded directory with `FAULTLINE_DATA_DIR`.

Start with one scenario and one trial:

```sh
npm run evaluate -- --provider anthropic --model claude-opus-5-5 \
  --scenario timeout-after-commit --trials 1 --prompt recovery \
  --max-turns 6 --accept-costs
```

The `.env.example` file is documentation, not automatically loaded configuration.

## What the agent can do

The model sees an authorized refund task and three tools: `issue_refund`, `wait`, and `finish`. Its refund calls execute only in the simulated service. It never receives a real payment credential. The same state-based checks used for fixtures verify the model's result.

Both adapters send the same instructions and tool descriptions from `src/agents/shared.ts`, so the prompt hash matches across providers and results are comparable.

Prompt variants:

- `baseline`: general task completion and evidence-based reporting.
- `recovery`: additionally asks for stable idempotency keys, bounded retries, response validation, and Retry-After handling.

Both variants receive the same tools and descriptions. The baseline is not forced to fail. Compare observed outcomes, not an assumed result.

## How a trial ends

A trial ends when the model calls `finish`, runs out of turns, or keeps calling `issue_refund` after the simulated service's five-call budget is spent. A turn with no tool call does not end it. The harness replies with a short reminder to use a tool, and the loop continues. The same happens when a response is cut off by `--max-output-tokens`. The reminders restate the tool protocol only and say nothing about retries or idempotency, so the baseline prompt stays a baseline. Every reminder costs a turn, so `--max-turns` still bounds spend.

The providers differ in one place. A complete OpenAI tool call inside a truncated response still runs. A Claude tool call in a response stopped by `max_tokens` is never run, because its input may be incomplete. Claude gets an error result for it instead.

Any other stop the provider makes, such as a failure, a content filter, a Claude refusal, or a full context window, aborts the trial as an infrastructure error. It is never scored as the agent choosing to escalate. Claude's automatic refusal fallbacks are deliberately off: a fallback would answer with a different model than the one under test.

Each run records a `stopReason`:

- `finish_tool`: the model reported its own outcome.
- `turn_budget_exhausted`: the model never called `finish`. Check `textOnlyTurns` and `truncatedTurns` to see whether it was stuck talking or getting cut off.
- `tool_budget_exhausted`: the model kept calling `issue_refund` after the service stopped accepting calls. The trial stops there instead of spending the remaining turns.
- `unexpected_parallel_tools`: the model returned several tool calls although parallel calls are disabled.
- `provider_<reason>`: the provider stopped the response. Only appears in `interruptedTrial.metadata`, since the trial is aborted.

## Cost and execution bounds

- Default: one trial per selected scenario and at most six model calls per trial.
- Output per call defaults to 4096 tokens for Claude and 1024 for OpenAI. Current Claude models think by default and thinking counts toward this limit, which is why its default is higher. The CLI accepts 128-16000.
- Selecting `--scenario all` runs all four scenarios. Specify one scenario for the first paid test.
- SDK automatic retries are disabled. Each request has a 30-second timeout; each trial has a 120-second deadline.
- CLI limits: 1-20 trials per scenario and 1-12 turns.
- These are call and output bounds, not a dollar cap. Input tokens grow with conversation history, and exact cost depends on the model.
- Claude's assistant turns are sent back exactly as returned, including thinking blocks. OpenAI uses `store: false` and sends back encrypted reasoning items where supported. Traces record tool selections and usage, never reasoning.

## Reports

JSON reports are saved in `.faultline/evaluations`. Completed runs also appear in dashboard history after it is restarted. Reports include provider/model, prompt hash, prompt variant, trial number, call count, input/output tokens, stop reason, and text-only and truncated turn counts.

Results are grouped by agent version and scenario. Live-model groups include a nominal 95% Wilson interval; this assumes independent trials and does not prove general reliability. They also count stop reasons, so a failed run from an exhausted budget can be told apart from a deliberate escalation. Fixture repetitions get neither.

Infrastructure and provider failures stop the evaluation and save a partial report. Completed trial totals exclude interrupted trials; `interruptedTrial.metadata` preserves usage known before interruption. Usage for a request that failed before returning may be unavailable. Partial service traces for an interrupted live trial are not yet persisted.

## Commands without model charges

```sh
npm run evaluate -- --provider fixture --agent resilient --trials 3
npm run evaluate -- --help
npm test
```
