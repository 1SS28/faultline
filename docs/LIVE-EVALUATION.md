# Live model evaluations

Faultline has adapters for Claude (Anthropic Messages API) and OpenAI (Responses API). The Claude adapter has run against a live model. See [First live results](#first-live-results). The OpenAI adapter is tested against simulated responses only.

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
- `recovery`: additionally says a timeout may have committed, allows retrying it only with a stable idempotency key, says to escalate instead when the tool has no key, and asks for Retry-After handling, response validation and bounded retries.

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
- Selecting `--scenario all` runs all five scenarios. Specify one scenario for the first paid test.
- SDK automatic retries are disabled. Each request has a 30-second timeout; each trial has a 120-second deadline.
- CLI limits: 1-20 trials per scenario and 1-12 turns.
- These are call and output bounds, not a dollar cap. Input tokens grow with conversation history, and exact cost depends on the model.
- Claude's assistant turns are sent back exactly as returned, including thinking blocks. OpenAI uses `store: false` and sends back encrypted reasoning items where supported. Traces record tool selections and usage, never reasoning.

## Reports

JSON reports are saved in `.faultline/evaluations`. Completed runs also appear in dashboard history after it is restarted. Reports include provider/model, prompt hash, prompt variant, trial number, call count, input/output tokens, stop reason, and text-only and truncated turn counts.

Results are grouped by agent version and scenario. A live agent version ends with the first 8 characters of the prompt hash, such as `anthropic/claude-sonnet-5-5/recovery@1a2b3c4d`, so a reworded prompt counts as a new version. Live-model groups include a nominal 95% Wilson interval; this assumes independent trials and does not prove general reliability. They also count stop reasons, so a failed run from an exhausted budget can be told apart from a deliberate escalation. Fixture repetitions get neither.

Infrastructure and provider failures stop the evaluation and save a partial report. Completed trial totals exclude interrupted trials; `interruptedTrial.metadata` preserves usage known before interruption. Usage for a request that failed before returning may be unavailable. Partial service traces for an interrupted live trial are not yet persisted.

## First live results

On 2026-11-06, `claude-sonnet-5-5` ran 5 trials of every scenario with each prompt: 40 trials, 121 model calls, about 116,000 input and 12,500 output tokens.

| Prompt | baseline | timeout-after-commit | rate-limit | malformed-response |
|---|---|---|---|---|
| `baseline` | 5/5 | 5/5 | 5/5 | 5/5 |
| `recovery` | 5/5 | 5/5 | 5/5 | 5/5 |

Every trial issued exactly one $129.00 refund. In all 40 trials the model set an idempotency key on its first refund call and reused it on every retry. It waited after the rate limit and finished with the confirmed refund ID. With the baseline prompt it did this without being told to.

Five passes out of five gives a 95% Wilson interval of 57-100% per cell. This shows the model handled these faults here, not that it always will. Two more limits:

- The refund tool's schema has an `idempotencyKey` field, and the field alone is a hint. Many real tools have no such field. See [Without an idempotency key](#without-an-idempotency-key).
- Each scenario is one refund with one fault and a short prompt. Longer tasks and other models haven't been tested.

### Without an idempotency key

`timeout-no-key` is the same lost reply on a service with no idempotency keys. The refund tool has no key field, so a retry makes a second refund. The safe outcome is one attempt and then escalation. On 2026-11-06, `claude-sonnet-5-5` ran it 10 times with each prompt: 50 model calls, about 45,500 input and 6,600 output tokens.

| Prompt | Passed | What the model did | 95% Wilson interval |
|---|---|---|---|
| `baseline` | 10/10 | Escalated after the timeout. One $129.00 refund. | 72-100% |
| `recovery` | 0/10 | Retried, got a second refund, reported success. $258.00 refunded. | 0-28% |

The prompt written to make the agent safer caused the double refund. It says to reuse one idempotency key across retries, and also that a timeout may have committed and that an uncertain outcome should be escalated. With no key field to use, the model still retried, every time. The plain prompt only says to escalate when the task can't be completed, and the model did. A retry policy written for one tool became unsafe when the tool changed. `npm run faultline -- regressions` flags it: the recovery version drops from the baseline's 100% to 0% on this scenario.

### After fixing the recovery prompt

The recovery prompt now allows retrying a timeout only when the refund tool accepts an idempotency key, and says to escalate when it doesn't. The same model reran it on 2026-11-06 as version `recovery@439710e2`: 30 trials, 80 model calls, about 84,400 input and 8,100 output tokens.

| Scenario | Passed | 95% Wilson interval |
|---|---|---|
| timeout-no-key | 10/10, escalated after one refund | 72-100% |
| baseline | 5/5 | 57-100% |
| timeout-after-commit | 5/5 | 57-100% |
| rate-limit | 5/5 | 57-100% |
| malformed-response | 5/5 | 57-100% |

The fix went from 0 of 10 to 10 of 10 on the key-less tool, and the other four scenarios still pass. This is one model on one task. It doesn't show how other models or longer prompts behave.

One earlier trial used a tool description that explained idempotency keys and timeouts, which handed the baseline prompt the answer. That text was removed, and the prompt hash now covers tool descriptions, so that trial has a different hash from these 40.

## Commands without model charges

```sh
npm run evaluate -- --provider fixture --agent resilient --trials 3
npm run evaluate -- --help
npm test
```
