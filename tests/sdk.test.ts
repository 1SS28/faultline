import test from 'node:test';
import assert from 'node:assert/strict';
import { createLab, faults, formatResult, ToolFailure } from '../packages/sdk/src/index.js';

// A stand-in for a team's own email service: it records every email it sends and honours idempotency keys.
function emailService() {
  const outbox: Array<{ id: string; to: string; subject: string }> = [];
  const byKey = new Map<string, { id: string }>();
  async function sendEmail(input: { to: string; subject: string; idempotencyKey?: string }) {
    const earlier = input.idempotencyKey ? byKey.get(input.idempotencyKey) : undefined;
    if (earlier) return earlier;
    const email = { id: `email_${outbox.length + 1}`, to: input.to, subject: input.subject };
    outbox.push(email);
    if (input.idempotencyKey) byKey.set(input.idempotencyKey, { id: email.id });
    return { id: email.id };
  }
  return { outbox, sendEmail };
}
type SendEmail = ReturnType<typeof emailService>['sendEmail'];

// Two versions of the agent under test. Only the tool function changes between production and the test.
async function naiveReminderAgent(tools: { sendEmail: SendEmail }) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { return await tools.sendEmail({ to: 'sam@example.com', subject: 'Your invoice is due' }); }
    catch { /* try again */ }
  }
  return undefined;
}
async function carefulReminderAgent(tools: { sendEmail: SendEmail; wait: (ms: number) => Promise<void> }) {
  const message = { to: 'sam@example.com', subject: 'Your invoice is due', idempotencyKey: 'reminder:invoice-42' };
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { return await tools.sendEmail(message); }
    catch (error) { if (error instanceof ToolFailure && error.code === 'RATE_LIMIT') await tools.wait(error.retryAfterMs); }
  }
  return undefined;
}

test('a naive agent sends a second email after a lost reply, and the check catches it', async () => {
  const service = emailService();
  const lab = createLab();
  await naiveReminderAgent({ sendEmail: lab.tool('send_email', service.sendEmail, faults.timeoutAfterCommit()) });
  lab.check('Customer gets exactly one email', service.outbox.length === 1, { expected: '1', actual: String(service.outbox.length) });
  const result = lab.result();
  assert.equal(result.status, 'failed');
  assert.equal(lab.ran('send_email'), 2);
  assert.match(formatResult(result), /✗ Customer gets exactly one email: 2 \(expected 1\)/);
});

test('an agent that reuses an idempotency key sends one email after the same lost reply', async () => {
  const service = emailService();
  const lab = createLab();
  const sendEmail = lab.tool('send_email', service.sendEmail, faults.timeoutAfterCommit());
  await carefulReminderAgent({ sendEmail, wait: ms => lab.wait(ms) });
  lab.check('Customer gets exactly one email', service.outbox.length === 1, { expected: '1', actual: String(service.outbox.length) });
  assert.equal(lab.result().status, 'passed', formatResult(lab.result()));
  assert.equal(lab.ran('send_email'), 2, 'the function ran twice; the service deduplicated the second call');
});

test('a timeout before commit never reaches the service', async () => {
  const service = emailService();
  const lab = createLab();
  const sendEmail = lab.tool('send_email', service.sendEmail, faults.timeoutBeforeCommit());
  await assert.rejects(sendEmail({ to: 'sam@example.com', subject: 'Hi' }), (error: unknown) => error instanceof ToolFailure && error.code === 'TIMEOUT');
  assert.equal(service.outbox.length, 0);
  assert.equal(lab.ran('send_email'), 0);
  await sendEmail({ to: 'sam@example.com', subject: 'Hi' });
  assert.equal(service.outbox.length, 1, 'the retry goes through normally');
});

test('a rate limit rejects every call until the retry-after window passes on the virtual clock', async () => {
  const service = emailService();
  const lab = createLab();
  const sendEmail = lab.tool('send_email', service.sendEmail, faults.rateLimit({ retryAfterMs: 1000 }));
  const naive = await naiveReminderAgent({ sendEmail });
  assert.equal(naive, undefined, 'three immediate retries are all rejected');
  assert.equal(service.outbox.length, 0);
  await lab.wait(1000);
  await sendEmail({ to: 'sam@example.com', subject: 'Hi' });
  assert.equal(service.outbox.length, 1);
  assert.equal(lab.clock.now(), 1000, 'a one-second wait cost no real time');
});

test('a careful agent honours Retry-After and sends once', async () => {
  const service = emailService();
  const lab = createLab();
  await carefulReminderAgent({ sendEmail: lab.tool('send_email', service.sendEmail, faults.rateLimit({ retryAfterMs: 750 })), wait: ms => lab.wait(ms) });
  assert.equal(service.outbox.length, 1);
  assert.ok(lab.result().events.some(event => event.kind === 'agent.wait' && event.data.durationMs === 750));
});

test('a malformed response hides the real result from the caller, but the call still ran', async () => {
  const service = emailService();
  const lab = createLab();
  const sendEmail = lab.tool('send_email', service.sendEmail, faults.malformedResponse());
  const response = await sendEmail({ to: 'sam@example.com', subject: 'Hi' });
  assert.deepEqual(response, {});
  assert.equal(service.outbox.length, 1);
  const custom = lab.tool('send_email_2', service.sendEmail, faults.malformedResponse({ replaceWith: () => ({ accepted: true }) }));
  assert.deepEqual(await custom({ to: 'sam@example.com', subject: 'Hi' }), { accepted: true });
});

test('faults apply only to the call numbers they list', async () => {
  const service = emailService();
  const lab = createLab();
  const sendEmail = lab.tool('send_email', service.sendEmail, faults.timeoutAfterCommit({ calls: [2] }));
  await sendEmail({ to: 'a@example.com', subject: '1' });
  await assert.rejects(sendEmail({ to: 'b@example.com', subject: '2' }), ToolFailure);
  await sendEmail({ to: 'c@example.com', subject: '3' });
  assert.equal(service.outbox.length, 3);
});

test('a test whose planned fault never fired fails instead of passing by default', async () => {
  const service = emailService();
  const lab = createLab();
  // the fault waits for a second call, and this agent only makes one
  const sendEmail = lab.tool('send_email', service.sendEmail, faults.timeoutAfterCommit({ calls: [2] }));
  await sendEmail({ to: 'a@example.com', subject: 'Reminder' });
  lab.check('Customer gets exactly one email', service.outbox.length === 1);

  assert.deepEqual(lab.unfired(), ['send_email call 2 (timeout-after-commit)']);
  assert.equal(lab.result().status, 'failed');
  assert.match(formatResult(lab.result()), /✗ Every planned fault fired: never reached: send_email call 2 \(timeout-after-commit\)/);

  // once that call is made the fault fires, and the recorded check decides the result
  await assert.rejects(sendEmail({ to: 'a@example.com', subject: 'Reminder' }), ToolFailure);
  assert.deepEqual(lab.unfired(), []);
  assert.equal(lab.result().status, 'passed');

  // a lab with no faults has nothing to report
  const plain = createLab();
  plain.check('Nothing to break', true);
  assert.deepEqual(plain.result().checks.map(check => check.key), ['check-1']);
});

test('faults can throw the error type your real client throws', async () => {
  class HttpTimeout extends Error {}
  class TooManyRequests extends Error {}
  const service = emailService();
  const lab = createLab();
  const timeout = lab.tool('send_email', service.sendEmail, faults.timeoutAfterCommit({ error: () => new HttpTimeout('socket hang up') }));
  await assert.rejects(timeout({ to: 'sam@example.com', subject: 'Hi' }), HttpTimeout);
  const limited = lab.tool('send_sms', service.sendEmail, faults.rateLimit({ error: () => new TooManyRequests('429') }));
  await assert.rejects(limited({ to: 'sam@example.com', subject: 'Hi' }), TooManyRequests);
  // Later calls inside the same window throw the same configured error.
  await assert.rejects(limited({ to: 'sam@example.com', subject: 'Hi' }), TooManyRequests);
});

test('a lab with no checks fails instead of passing by default', () => {
  const result = createLab().result();
  assert.equal(result.status, 'failed');
  assert.equal(result.checks[0]!.label, 'The test recorded at least one check');
});

test('the trace records arguments and results without keeping live references', async () => {
  const service = emailService();
  const lab = createLab();
  const input = { to: 'sam@example.com', subject: 'Hi' };
  await lab.tool('send_email', service.sendEmail)(input);
  input.subject = 'changed later';
  const request = lab.result().events.find(event => event.kind === 'tool.request')!;
  assert.deepEqual(request.data.args, [{ to: 'sam@example.com', subject: 'Hi' }]);
  assert.deepEqual(lab.result().events.map(event => event.kind), ['tool.request', 'tool.commit', 'tool.response']);
});

test('a plan that cannot happen as written is refused before the agent runs', () => {
  const lab = createLab();
  const send = async () => 'sent';
  // only one fault can fire on a call, so the second would count as fired without doing anything
  assert.throws(() => lab.tool('send_email', send, faults.timeoutAfterCommit(), faults.malformedResponse()), /Two faults are planned for call 1 of send_email/);
  assert.throws(() => lab.tool('send_email', send, faults.timeoutAfterCommit({ calls: [] })), /needs call numbers, counting from 1/);
  assert.throws(() => lab.tool('send_email', send, faults.timeoutAfterCommit({ calls: [0] })), /counting from 1/);
  assert.throws(() => lab.tool('send_email', send, faults.rateLimit({ retryAfterMs: Number.NaN })), /retryAfterMs above 0/);
});

test('a wait that is not a number is refused instead of switching the rate limit off', async () => {
  const lab = createLab();
  const sendEmail = lab.tool('send_email', async () => 'sent', faults.rateLimit({ retryAfterMs: 1000 }));
  await assert.rejects(sendEmail(), ToolFailure);
  // an agent that reads retryAfterMs off an error that has none
  await assert.rejects(lab.wait(undefined as unknown as number), /lab.wait needs a number of milliseconds/);
  await assert.rejects(lab.wait(Number.NaN), /needs a number/);
  // the clock is intact, so the limit still stands
  await assert.rejects(sendEmail(), ToolFailure);
  assert.equal(lab.clock.now(), 0);
});

test("the service's own failure is in the trace, and a fault planned for that call does not fire", async () => {
  const lab = createLab();
  let down = true;
  const sendEmail = lab.tool('send_email', async () => { if (down) throw new Error('SMTP server is down'); return 'sent'; }, faults.timeoutAfterCommit());
  await assert.rejects(sendEmail(), /SMTP server is down/);
  down = false;
  assert.equal(await sendEmail(), 'sent');
  lab.check('The email went out once', lab.ran('send_email') === 1);

  const result = lab.result();
  assert.deepEqual(result.events.map(event => event.message),
    ['send_email called', 'send_email failed: SMTP server is down', 'send_email called', 'send_email ran against the service', 'send_email returned']);
  // the lost reply never happened, so the result can't pass
  assert.equal(result.status, 'failed');
  assert.deepEqual(lab.unfired(), ['send_email call 1 (timeout-after-commit)']);
});

test('calls made together are all recorded before any is answered', async () => {
  const lab = createLab();
  const read = lab.tool('read', async () => 'r'), write = lab.tool('write', async () => 'w');
  await Promise.all([read(), write()]);
  assert.deepEqual(lab.result().events.slice(0, 2).map(event => event.message), ['read called', 'write called']);
});
