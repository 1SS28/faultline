import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createLab } from '../packages/sdk/src/index.js';
import { createFaultProxy, formatReport, parseFaultFlag, parsePlan, planTools, runSteps, type FaultSpec, type Step, type Surface } from '../packages/mcp/src/index.js';
import { notesServer } from './fixtures/notes-server.js';

// agent <-> proxy <-> notes server, all in this process. `notes` is the server's own state.
async function setUp(faults: FaultSpec[] = [], surface?: Surface) {
  const { server, notes } = notesServer();
  const [serverSide, proxyUpstreamSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const upstream = new Client({ name: 'proxy-upstream', version: '1' });
  await upstream.connect(proxyUpstreamSide);

  const proxy = createFaultProxy({ upstream, faults, surface, lab: createLab() });
  const [proxySide, agentSide] = InMemoryTransport.createLinkedPair();
  await proxy.server().connect(proxySide);
  const agent = new Client({ name: 'agent', version: '1' });
  await agent.connect(agentSide);
  const call = (name: string, args: Record<string, unknown> = {}) => agent.callTool({ name, arguments: args }) as Promise<CallToolResult>;
  return { notes, proxy, agent, call };
}
const textOf = (result: CallToolResult) => result.content.map(block => block.type === 'text' ? block.text : '').join('');
const oneNote = { label: 'The note exists exactly once', tool: 'list_notes', count: 'Buy milk', min: 1, max: 1 };

test('with no faults the agent sees the real server unchanged', async () => {
  const { agent, call, notes } = await setUp();
  assert.deepEqual((await agent.listTools()).tools.map(tool => tool.name), ['create_note', 'create_note_once', 'list_notes', 'delete_note']);
  assert.equal(agent.getServerVersion()?.name, 'notes');
  assert.equal(agent.getInstructions(), 'Keeps short notes.');
  const created = await call('create_note', { title: 'Buy milk' });
  assert.equal(created.isError, undefined);
  assert.deepEqual(JSON.parse(textOf(created)), { id: 'note_1', title: 'Buy milk' });
  assert.equal(notes.length, 1);
});

test('a lost reply looks like a failure to the agent although the server saved the note', async () => {
  const { call, notes } = await setUp([{ tool: 'create_note', kind: 'timeout-after-commit' }]);
  const result = await call('create_note', { title: 'Buy milk' });
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'Request timed out');
  assert.equal(notes.length, 1);
});

test('a retry after a lost reply makes a second note, and the state check catches it', async () => {
  const { call, notes, proxy } = await setUp([{ tool: 'create_note', kind: 'timeout-after-commit' }]);
  // an agent that retries when a call fails
  const first = await call('create_note', { title: 'Buy milk' });
  if (first.isError) await call('create_note', { title: 'Buy milk' });

  await proxy.check(oneNote);
  const report = proxy.report();
  assert.equal(notes.length, 2);
  assert.equal(report.status, 'failed');
  assert.equal(report.checks[0]?.actual, '2');
  assert.match(formatReport(report), /create_note ran, but its response was lost/);
  assert.match(formatReport(report), /✗ The note exists exactly once: 2 \(expected 1\)/);
});

test('the same retry is safe on a tool that takes an idempotency key', async () => {
  const { call, notes, proxy } = await setUp([{ tool: 'create_note_once', kind: 'timeout-after-commit' }]);
  const args = { title: 'Buy milk', key: 'milk-1' };
  const first = await call('create_note_once', args);
  const second = first.isError ? await call('create_note_once', args) : first;

  await proxy.check(oneNote);
  assert.equal(second.isError, undefined);
  assert.equal(notes.length, 1);
  assert.equal(proxy.report().status, 'passed', formatReport(proxy.report()));
});

test('a timeout before the call reaches the server leaves nothing behind', async () => {
  const { call, notes } = await setUp([{ tool: 'create_note', kind: 'timeout-before-commit' }]);
  assert.equal((await call('create_note', { title: 'Buy milk' })).isError, true);
  assert.equal(notes.length, 0);
});

test('a fault can target a later call and carry its own message', async () => {
  const { call, notes } = await setUp([{ tool: 'create_note', kind: 'timeout-after-commit', calls: [2], message: 'upstream connect error' }]);
  assert.equal((await call('create_note', { title: 'One' })).isError, undefined);
  const second = await call('create_note', { title: 'Two' });
  assert.equal(textOf(second), 'upstream connect error');
  assert.equal((await call('create_note', { title: 'Three' })).isError, undefined);
  assert.equal(notes.length, 3);
});

test('a rate limit rejects calls until its window has passed', async () => {
  const { call, notes, proxy } = await setUp([{ tool: 'create_note', kind: 'rate-limit', retryAfterMs: 500 }]);
  assert.equal(textOf(await call('create_note', { title: 'Buy milk' })), 'Rate limit exceeded. Retry after 500ms.');
  assert.equal((await call('create_note', { title: 'Buy milk' })).isError, true);
  assert.equal(notes.length, 0);
  await proxy.lab.wait(500);
  assert.equal((await call('create_note', { title: 'Buy milk' })).isError, undefined);
  assert.equal(notes.length, 1);
});

test('a malformed response is empty although the server saved the note', async () => {
  const { call, notes } = await setUp([{ tool: 'create_note', kind: 'malformed-response' }]);
  const result = await call('create_note', { title: 'Buy milk' });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.content, []);
  assert.equal(notes.length, 1);
});

test('a fault can arrive as a protocol error instead of a tool result', async () => {
  const { call, notes } = await setUp([{ tool: 'create_note', kind: 'timeout-after-commit' }], 'protocol-error');
  await assert.rejects(call('create_note', { title: 'Buy milk' }), (error: { code?: number; message?: string }) => {
    assert.equal(error.code, -32001);
    assert.match(error.message ?? '', /Request timed out$/);
    return true;
  });
  assert.equal(notes.length, 1);
});

test("the real server's own errors pass through untouched", async () => {
  const { call } = await setUp([{ tool: 'create_note', kind: 'timeout-after-commit', calls: [5] }]);
  const rejected = await call('create_note', {});
  assert.equal(rejected.isError, true);
  assert.equal(textOf(rejected), 'A note needs a title');
  await assert.rejects(call('no_such_tool'), /Unknown tool: no_such_tool/);
});

test('a run with no state checks is reported as unchecked, not passed', async () => {
  const { call, proxy } = await setUp([{ tool: 'create_note', kind: 'timeout-after-commit' }]);
  await call('create_note', { title: 'Buy milk' });
  assert.equal(proxy.report().status, 'unchecked');
  assert.match(formatReport(proxy.report()), /^UNCHECKED/);
});

test('checks cannot pass when a planned fault never fired', async () => {
  const { call, proxy } = await setUp([{ tool: 'create_note', kind: 'timeout-after-commit', calls: [1, 2] }]);
  // the agent made one write, so the fault planned for a second call never happened
  await call('create_note_once', { title: 'Buy milk', key: 'milk-1' });
  await call('create_note', { title: 'Call the bank' });
  await proxy.check(oneNote);

  const report = proxy.report();
  assert.equal(report.checks[0]?.passed, true);
  assert.equal(report.status, 'failed');
  assert.match(formatReport(report), /✗ Every planned fault fired: never reached: create_note call 2 \(timeout-after-commit\)/);
});

test('a state check fails when its read tool cannot be called', async () => {
  const { proxy } = await setUp();
  await proxy.check({ ...oneNote, tool: 'no_such_tool' });
  assert.equal(proxy.report().status, 'failed');
  assert.match(proxy.report().checks[0]?.actual ?? '', /no_such_tool could not be called/);
});

test('plans are validated with messages that say what to fix', () => {
  assert.deepEqual(parseFaultFlag('create_note:timeout-after-commit@1,3'), { tool: 'create_note', kind: 'timeout-after-commit', calls: [1, 3], retryAfterMs: undefined, message: undefined });
  assert.deepEqual(parseFaultFlag('ns:create:rate-limit').tool, 'ns:create');
  assert.throws(() => parseFaultFlag('create_note'), /should look like tool:kind/);
  assert.throws(() => parseFaultFlag('create_note:explode'), /kind must be one of/);
  assert.throws(() => parseFaultFlag('create_note:rate-limit@0'), /counting from 1/);
  assert.throws(() => parsePlan({ checks: [{ label: 'x', tool: 'list_notes', count: 'milk' }] }), /needs "min", "max" or both/);
  assert.throws(() => parsePlan({ checks: [{ label: 'x', tool: 'list_notes', count: '(', max: 1 }] }), /not a valid regular expression/);
  assert.throws(() => parsePlan({ surface: 'loud' }), /"surface" must be one of/);
  assert.throws(() => parsePlan({ trace: [{ label: 'x', tool: 'create_note' }] }), /needs "count" or "readBeforeRetry", and not both/);
  assert.throws(() => parsePlan({ trace: [{ label: 'x', tool: 'create_note', count: 'guesses', max: 1 }] }), /count must be one of: calls, ran, while-limited/);
  assert.throws(() => parsePlan({ trace: [{ label: 'x', tool: 'create_note', count: 'ran' }] }), /trace\[0\] needs "min", "max" or both/);
  assert.throws(() => parsePlan({ trace: [{ label: 'x', tool: 'create_note', readBeforeRetry: [] }] }), /must list tool names/);
  const withTrace = parsePlan({ faults: [{ tool: 'create_note', kind: 'rate-limit' }], trace: [{ label: 'x', tool: 'create_note_once', readBeforeRetry: ['list_notes'] }] });
  assert.deepEqual(planTools(withTrace), ['create_note', 'create_note_once', 'list_notes']);
  assert.throws(() => parsePlan({ cleanup: [{ args: {} }] }), /cleanup\[0\] needs a "tool" name/);
  assert.throws(() => parsePlan({ setup: [{ tool: 'delete_note', forEach: { tool: 'list_notes' } }] }), /setup\[0\]\.forEach needs "match"/);
  assert.throws(() => parsePlan({ cleanup: [{ tool: 'delete_note', forEach: { tool: 'list_notes', match: '(' } }] }), /not a valid regular expression/);
  assert.deepEqual(planTools(parsePlan({ setup: [{ tool: 'create_note' }], cleanup: [deleteAll] })), ['create_note', 'delete_note', 'list_notes']);
});

const looked = { label: 'Looked before writing again', tool: 'create_note', readBeforeRetry: ['list_notes'] };
// deletes every note the server lists
const deleteAll: Step = { tool: 'delete_note', args: { id: '{{match}}' }, forEach: { tool: 'list_notes', match: '"id":"(note_\\d+)"' } };

test('setup and cleanup steps reach the real server, outside the fault plan and the trace', async () => {
  const { call, notes, proxy } = await setUp([{ tool: 'create_note', kind: 'timeout-after-commit' }]);
  assert.equal(await runSteps(proxy.upstream, [{ tool: 'create_note', args: { title: 'Already here' } }]), 1);
  // the setup call didn't use up the fault planned for the agent's first call
  assert.equal((await call('create_note', { title: 'Buy milk' })).isError, true);
  await call('create_note', { title: 'Buy milk' });
  assert.deepEqual(notes.map(note => note.title), ['Already here', 'Buy milk', 'Buy milk']);

  // one listing call, then one delete for each of the three notes
  assert.equal(await runSteps(proxy.upstream, [deleteAll]), 4);
  assert.equal(notes.length, 0);
  assert.deepEqual(proxy.report().events.filter(event => event.kind === 'tool.request').map(event => event.data.tool), ['create_note', 'create_note']);
});

test('a step that fails says which tool, and a numeric match stays a number', async () => {
  const { proxy } = await setUp();
  await assert.rejects(runSteps(proxy.upstream, [{ tool: 'delete_note', args: { id: 'note_9' } }]), /delete_note failed: No note with id note_9/);
  await assert.rejects(runSteps(proxy.upstream, [{ tool: 'no_such_tool' }]), /no_such_tool/);

  const sent: unknown[] = [];
  const server = { callTool: async (request: { name: string; arguments?: Record<string, unknown> }) => {
    sent.push(request.arguments);
    return { content: [{ type: 'text' as const, text: request.name === 'list' ? '#12 open, #40 open, #12 open' : 'ok' }] };
  } };
  await runSteps(server as never, [{ tool: 'close', args: { number: '{{match}}', note: 'closing #{{match}}', tags: ['{{match}}'] }, forEach: { tool: 'list', match: '#(\\d+)' } }]);
  // each distinct match once
  assert.deepEqual(sent.slice(1), [{ number: 12, note: 'closing #12', tags: [12] }, { number: 40, note: 'closing #40', tags: [40] }]);
});

test('a trace check counts how often a write reached the server, with no read tool involved', async () => {
  const { call, proxy } = await setUp([{ tool: 'create_note', kind: 'timeout-after-commit' }]);
  await call('create_note', { title: 'Buy milk' });
  await call('create_note', { title: 'Buy milk' });
  await call('create_note', { title: 'Call the bank' });

  proxy.checkTrace({ label: 'Buy milk was written once', tool: 'create_note', where: { title: 'Buy milk' }, count: 'ran', max: 1 });
  proxy.checkTrace({ label: 'Three calls in all', tool: 'create_note', count: 'calls', min: 3, max: 3 });
  const report = proxy.report();
  // a run with only trace checks is still a checked run
  assert.equal(report.status, 'failed');
  assert.deepEqual(report.checks.map(item => [item.passed, item.actual]), [[false, '2'], [true, '3'], [true, '']]);
  assert.match(formatReport(report), /✗ Buy milk was written once: 2 \(expected at most 1\)/);
});

test('a trace check counts the calls made while a rate limit was still in force', async () => {
  const { call, proxy } = await setUp([{ tool: 'create_note', kind: 'rate-limit', retryAfterMs: 500 }]);
  await call('create_note', { title: 'Buy milk' }); // sets the limit off
  await call('create_note', { title: 'Buy milk' }); // too early
  await call('create_note', { title: 'Buy milk' }); // too early
  await proxy.lab.wait(500);
  await call('create_note', { title: 'Buy milk' });

  proxy.checkTrace({ label: 'No call inside the window', tool: 'create_note', count: 'while-limited', max: 0 });
  proxy.checkTrace({ label: 'The note was written once', tool: 'create_note', count: 'ran', min: 1, max: 1 });
  assert.deepEqual(proxy.report().checks.slice(0, 2).map(item => [item.passed, item.actual]), [[false, '2'], [true, '1']]);
});

test('a retry with no read first fails the trace check, even when it happened to do no harm', async () => {
  // the write was lost, so the blind retry ends with one note
  const blind = await setUp([{ tool: 'create_note', kind: 'timeout-before-commit' }]);
  await blind.call('create_note', { title: 'Buy milk' });
  await blind.call('create_note', { title: 'Buy milk' });
  await blind.proxy.check(oneNote);
  blind.proxy.checkTrace(looked);
  assert.deepEqual(blind.proxy.report().checks.slice(0, 2).map(item => item.passed), [true, false]);
  assert.match(formatReport(blind.proxy.report()), /✗ Looked before writing again: 1 of 1 repeat after a failure came with no read first \(expected list_notes first\)/);

  const careful = await setUp([{ tool: 'create_note', kind: 'timeout-before-commit' }]);
  await careful.call('create_note', { title: 'Buy milk' });
  await careful.call('list_notes');
  await careful.call('create_note', { title: 'Buy milk' });
  careful.proxy.checkTrace(looked);
  assert.equal(careful.proxy.report().checks[0]?.passed, true);

  // no repeat at all passes
  const once = await setUp([{ tool: 'create_note', kind: 'timeout-after-commit' }]);
  await once.call('create_note', { title: 'Buy milk' });
  once.proxy.checkTrace(looked);
  assert.deepEqual([once.proxy.report().checks[0]?.passed, once.proxy.report().checks[0]?.actual], [true, 'no repeat after a failure']);
});

test('a read that came back broken does not count as a read', async () => {
  const { call, proxy } = await setUp([{ tool: 'create_note', kind: 'timeout-after-commit' }, { tool: 'list_notes', kind: 'malformed-response' }]);
  await call('create_note', { title: 'Buy milk' });
  await call('list_notes'); // empty, by the fault
  await call('create_note', { title: 'Buy milk' });
  proxy.checkTrace(looked);
  assert.equal(proxy.report().checks[0]?.passed, false);
});

// the same story through the real command line: two child processes talking stdio
const node = process.execPath;
const cli = ['--import', 'tsx', 'packages/mcp/src/cli.ts'];
const realServer = [node, '--import', 'tsx', 'tests/fixtures/notes-server.ts'];

test('the command-line proxy injects the fault, checks the server and writes a report', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'faultline-mcp-'));
  const config = join(folder, 'plan.json'), reportPath = join(folder, 'out', 'report.json');
  await writeFile(config, JSON.stringify({ faults: [{ tool: 'create_note', kind: 'timeout-after-commit' }], checks: [oneNote], trace: [looked], cleanup: [deleteAll] }));

  const transport = new StdioClientTransport({ command: node, args: [...cli, '--config', config, '--report', reportPath, '--', ...realServer], stderr: 'pipe' });
  const exited = new Promise<number | null>(resolve => { transport.onclose = () => resolve(null); });
  const agent = new Client({ name: 'agent', version: '1' });
  await agent.connect(transport);
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += chunk; });
  assert.equal(agent.getServerVersion()?.name, 'notes');
  const first = await agent.callTool({ name: 'create_note', arguments: { title: 'Buy milk' } }) as CallToolResult;
  assert.equal(first.isError, true);
  await agent.callTool({ name: 'create_note', arguments: { title: 'Buy milk' } });
  await agent.close();
  await exited;

  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  assert.equal(report.status, 'failed');
  assert.equal(report.checks[0].actual, '2');
  assert.deepEqual([report.checks[1].label, report.checks[1].passed], ['Looked before writing again', false]);
  // the checks ran first and saw both notes; then the cleanup listed them and deleted each
  assert.match(stderr, /Cleanup made 3 calls/);
  assert.ok(report.events.some((event: { kind: string }) => event.kind === 'fault.injected'));
});

test('the command line refuses a plan that names a tool the server does not have', async () => {
  const child = spawn(node, [...cli, '--fault', 'creat_note:timeout-after-commit', '--', ...realServer], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise(resolve => child.on('exit', resolve));
  assert.equal(code, 2);
  assert.match(stderr, /the server has no tool named creat_note\. Its tools: create_note, create_note_once, list_notes/);
});

test('the command line exits 2 with usage when the plan is wrong', async () => {
  const child = spawn(node, [...cli, '--fault', 'create_note:explode', '--', ...realServer], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '', stdout = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => { stdout += chunk; });
  const code = await new Promise(resolve => child.on('exit', resolve));
  assert.equal(code, 2);
  assert.match(stderr, /kind must be one of/);
  // stdout belongs to the protocol
  assert.equal(stdout, '');
});
