# Live model evaluations

The OpenAI Responses adapter is tested against mocked responses only. No paid API call has gone to a live model yet.

## Setup

Choose a model available to your OpenAI API project and configure `OPENAI_API_KEY` in your local shell or secret manager. Never commit the key or paste it into an issue. Set `OPENAI_MODEL`, or pass `--model` explicitly. The program does not pick an expensive default.

Stop the dashboard before using the same embedded database from this CLI. Alternatively, configure server PostgreSQL with `DATABASE_URL` or choose a separate embedded directory with `FAULTLINE_DATA_DIR`.

Start with one scenario and one trial:

```sh
npm run evaluate -- --provider openai --model YOUR_MODEL \
  --scenario timeout-after-commit --trials 1 --prompt recovery \
  --max-turns 6 --max-output-tokens 1024 --accept-costs
```

The program requires the key, a model, and `--accept-costs` before it sends any requests. Keep credentials in the environment rather than command arguments. The `.env.example` file is documentation, not automatically loaded configuration.

## What the agent can do

The model sees an authorized refund task and three function tools: `issue_refund`, `wait`, and `finish`. Its refund calls execute only in the simulated service. It never receives a real payment credential. The same state-based assertions used for fixtures verify the model's result.

Prompt variants:

- `baseline`: general task completion and evidence-based reporting.
- `recovery`: additionally asks for stable idempotency keys, bounded retries, response validation, and Retry-After handling.

Both variants receive the same tools and their descriptions. The baseline is not forced to fail. Compare observed outcomes, not an assumed result.

## Cost and execution bounds

- Default: one trial per selected scenario, at most six model calls per trial, and 1024 output tokens per call.
- Selecting `--scenario all` runs all four scenarios. Specify one scenario for the first paid test.
- SDK automatic retries are disabled. Each request has a 30-second timeout; each trial has a 120-second deadline.
- CLI limits: 1-20 trials per scenario, 1-12 turns, and 128-4096 output tokens per call.
- These are call/output bounds, not a dollar spending cap. Input tokens grow with conversation history, and exact cost depends on the model.
- The adapter uses `store: false`. Response state, including encrypted reasoning items where supported, is sent back in the next call. Traces record tool selections and usage, not hidden reasoning.

## Reports

JSON reports are saved in `.faultline/evaluations`. Completed runs also appear in dashboard history after it is restarted. Reports include provider/model, prompt hash, prompt variant, trial number, call count, and input/output tokens.

Results are grouped by agent version and scenario. Live-model groups include a nominal 95% Wilson interval; this assumes independent trials and does not prove general reliability. Fixture repetitions do not receive confidence intervals.

Infrastructure/provider failures stop the evaluation and save a partial report. Completed trial totals exclude interrupted trials; `interruptedTrial.metadata` preserves usage known before interruption. Usage for a request that failed before returning may be unavailable. Partial service traces for an interrupted live trial are not yet persisted.

## Commands without model charges

```sh
npm run evaluate -- --provider fixture --agent resilient --trials 3
npm run evaluate -- --help
npm test
```

Implementation follows the official [function-calling guide](https://developers.openai.com/api/docs/guides/function-calling). Live response compatibility and model access still require a first paid smoke test.
