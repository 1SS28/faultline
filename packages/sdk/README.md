# Faultline SDK

Adds Faultline's faults to the tools your own AI agent calls. Wrap a tool function, run your agent, then check what your service actually recorded.

```sh
npm install --save-dev faultline-sdk
```

It has no dependencies and runs on Node.js 18 or newer. Until it's published, build it with `npm run build:sdk` from the repository root, or import `packages/sdk/src/index.ts` directly.

## Example

An agent sends a reminder email and retries when the call fails. The test makes the first call time out after the email has already gone out.

```ts
import assert from 'node:assert/strict';
import { createLab, faults, formatResult } from 'faultline-sdk';

test('a lost reply does not send the customer two emails', async () => {
  const service = emailService();            // your test double or staging client
  const lab = createLab();
  const sendEmail = lab.tool('send_email', service.sendEmail, faults.timeoutAfterCommit());

  await reminderAgent({ sendEmail });        // your agent, given the wrapped tool

  lab.check('Customer gets exactly one email', service.outbox.length === 1,
    { expected: '1', actual: String(service.outbox.length) });
  const result = lab.result();
  assert.equal(result.status, 'passed', formatResult(result));
});
```

If the agent retries without an idempotency key, the check fails and `formatResult` prints the trace:

```
FAILED
  01  +0ms  send_email called
  02  +0ms  send_email ran against the service
  03  +0ms  send_email ran, but its response was lost
  04  +0ms  send_email called
  05  +0ms  send_email ran against the service
  06  +0ms  send_email returned
  ✗ Customer gets exactly one email: 2 (expected 1)
```

The repository's `tests/sdk.test.ts` contains this example in full, with a version of the agent that passes.

## Faults

Each fault applies to the listed call numbers of one tool, counting from 1. The default is the first call.

| Fault | What happens | What a good agent does |
|---|---|---|
| `faults.timeoutAfterCommit()` | Your function runs, then the caller gets a timeout. | Retries with the same idempotency key, or checks before retrying. |
| `faults.timeoutBeforeCommit()` | The call fails before your function runs. | Retries. Giving up here is a missed task. |
| `faults.rateLimit({ retryAfterMs })` | Every call is rejected until the window passes. | Waits, then retries. |
| `faults.malformedResponse({ replaceWith })` | Your function runs, but the caller gets a different result. The default is `{}`. | Doesn't report success without a confirmation. |

Faults throw `ToolFailure` by default, with `code` set to `TIMEOUT` or `RATE_LIMIT` and `retryAfterMs` on rate limits. To test the error handling your agent really has, pass the error your client throws: `faults.timeoutAfterCommit({ error: () => new MyHttpTimeout() })`.

```ts
lab.tool('charge_card', payments.charge.bind(payments), faults.timeoutAfterCommit({ calls: [1] }), faults.rateLimit({ calls: [3] }));
```

## Checks

Base checks on your service's own records, such as rows in a test database or a fake's outbox, not on what the agent says it did. `lab.ran('send_email')` tells you how many times your function was actually reached. A lab with no checks fails, so a test can't pass by accident.

## Time

A lab uses a virtual clock by default, so a one-second backoff costs no real time. For that to work, the agent's waits must go through `lab.wait(ms)`. If your agent sleeps on its own, use `createLab({ clock: realClock })`.

## Model-driven agents

For an agent built on a model's tool use, wrap the functions your tool executor calls. The model keeps choosing tools as usual. Only the implementations behind them change.

## Limits

- The faults run inside your test process. Network traffic isn't intercepted, so the wrapped function must be safe to call, like a test double or a staging client.
- Results don't appear in the Faultline dashboard yet.
- No team outside this project has used it yet.

## License

Apache License, Version 2.0. See `LICENSE` and `NOTICE`.
