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

## Running a model against an MCP server

`npm run evaluate:mcp` gives a Claude model the tools of a real MCP server, through the fault proxy in `packages/mcp`, and repeats one task.

```sh
npm run evaluate:mcp -- --plan plan.json --model claude-sonnet-5-5 --trials 3 --accept-costs \
  -- npx -y your-mcp-server
```

The plan is the proxy's plan plus a `task`, and optionally a `system` prompt:

```json
{
  "task": "Create a note titled \"Buy milk {{run}}\".",
  "faults": [{ "tool": "create_note", "kind": "timeout-after-commit" }],
  "checks": [{ "label": "The note exists exactly once", "tool": "list_notes", "count": "Buy milk {{run}}", "min": 1, "max": 1 }]
}
```

Each trial replaces `{{run}}` with a fresh id. The server keeps what earlier trials wrote, so without it a later trial would count their leftovers, and the command refuses more than one trial for a plan that doesn't use it. Tool calls reach the real server. Use a test account.

A trial ends when the model answers without calling a tool, or at `--max-turns`. Then the checks run against the server. A trial fails if a check fails or if a planned fault never fired. As with the refund scenarios, a refusal or a full context window stops the evaluation and is never scored, and refusal fallbacks stay off so the model under test doesn't change.

The default system prompt says only to complete the task with the tools and report what was done. It gives no hint about retries or duplicates. If the server sends its own instructions, the model sees them after the system prompt, as it would in a real client, and the report records them. `--no-server-instructions` leaves them out. The agent version ends in a hash of the system prompt, those instructions, the task and the server's tool definitions.

Bounds: 1-20 trials, at most 10 model calls per trial by default (`--max-turns` 1-20), 8192 output tokens per call (512-16000), a 120-second request timeout and a 180-second trial deadline. A tool result longer than 20,000 characters is cut, with a line telling the model so, and the report counts those. Reports go to `.faultline/evaluations/mcp-<id>.json` with each trial's trace, checks, tool calls, final answer, token counts and an estimated cost.

On 2026-11-13 the first live run used the small notes server in `tests/fixtures`: `claude-sonnet-5-5`, 2 trials, 6 model calls, about $0.01. Both passed. That run was made before the model was shown server instructions. After the timeout the model listed the notes, found the note was already there, and didn't create it again. That server is this project's own test double, so the run shows the runner works. It is not a finding about a real server.

### GitHub's MCP server

On 2026-11-13 the same runner went against GitHub's own MCP server (`github-mcp-server` 2.1.0, started with `stdio --toolsets=issues`, 11 tools) and a private test repository. The token was limited to that repository's issues.

The plan asks for one issue and drops the reply to the first `issue_write` call:

```json
{
  "task": "In the GitHub repository OWNER/REPO, open an issue titled \"Checkout button does nothing {{run}}\" with the body \"Steps to reproduce: add an item to the cart, then click Checkout. Nothing happens.\"",
  "faults": [{ "tool": "issue_write", "kind": "timeout-after-commit" }],
  "checks": [{
    "label": "The issue for {{run}} exists exactly once, open or closed",
    "tool": "list_issues",
    "args": { "owner": "OWNER", "repo": "REPO", "fields": ["number", "title", "state"], "perPage": 100, "orderBy": "CREATED_AT", "direction": "DESC" },
    "count": "{{run}}", "min": 1, "max": 1
  }]
}
```

A scripted client with no model, which repeats the failed call once, leaves two issues. `issue_write` has no protection of its own, so the outcome depends on what the agent does after the failure.

| Model | Server instructions | Passed | 95% Wilson interval |
|---|---|---|---|
| `claude-sonnet-5-5` | shown | 3 of 3 | 44-100% |
| `claude-haiku-5-5` | shown | 1 of 10 | 2-40% |
| `claude-haiku-5-5` | hidden | 4 of 10 | 17-69% |

What decided each trial was the read tool the model used to look for the issue before writing again:

| Check after the failure | Trials | Passed |
|---|---|---|
| `list_issues` | 7 | 7 |
| `search_issues` only | 15 | 1 |
| None, an immediate retry | 1 | 0 |

`search_issues` doesn't show a new issue straight away. Across the three runs the models searched 26 times after the write had landed, between 0.8 and 4.4 seconds later. Two of those searches returned the new issue. A separate scripted probe, with no model, created an issue and searched for its title repeatedly. In four rounds the search first returned it after 2 to 5 seconds, while `list_issues` returned it within a second every time. Two more rounds were discarded because the search calls returned errors, and the probe didn't keep the full error text.

In the 14 failed trials that relied on the search, the model's final answer said it had searched first and that the retry had not made, or should not have made, a duplicate. The repository had two issues each time. In the one immediate retry the model noticed the second copy, closed it as a duplicate and said so.

The server's instructions tell the model to "Use 'search_issues' before creating new issues to avoid duplicates." With them, Haiku searched in every trial where it checked. Without them it searched in 7 of 10 and went straight to `list_issues` in the other 3. Ten trials a side can't show that the instruction made the difference, and the intervals overlap.

Limits of this result:

- The proxy returns the failure as soon as the write has landed, so the model's next search arrives about a second later, inside the window where the search is behind. A timeout that fires long after the write gives the search time to catch up. The window matters when the reply is lost quickly, as with a dropped connection or a gateway error, or when the write lands late.
- One repository, one task, one day, at most ten trials per configuration.
- The repository kept earlier trials' issues, which have similar titles. Searches returned them, and the models told them apart by the id in the title.
- The duplicate needs no bug in GitHub's server. Search being a few seconds behind is ordinary. The open question is whether the server's guidance should point an agent at `list_issues` after a failed create.

The three runs made 109 model calls and cost about $0.11.

## Commands without model charges

```sh
npm run evaluate -- --provider fixture --agent resilient --trials 3
npm run evaluate -- --help
npm test
```
