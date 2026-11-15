#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { connectUpstream, createFaultProxy, faultKinds, formatReport, parseFaultFlag, parsePlan, planTools, type Plan } from './index.js';

const usage = `faultline-mcp-proxy: break an MCP server's tool calls on purpose, then check what it really did

  faultline-mcp-proxy [options] -- <server command> [server args...]

Options:
  --fault <tool>:<kind>[@calls]  Break a tool. Repeatable. Calls count from 1, default 1 (example: create_issue:timeout-after-commit@1,2)
  --config <file.json>           A plan with "faults", "checks", "trace" and "surface"
  --report <file.json>           Write the trace and check results here when the session ends
  --surface <how>                tool-error (default) or protocol-error
  --help

Kinds: ${faultKinds.join(', ')}

Tool calls still reach the real server. Point it at a test account.`;

// stdout carries the protocol, so everything for people goes to stderr
const say = (line: string) => process.stderr.write(`${line}\n`);

async function readPlan(): Promise<{ plan: Plan; report?: string; command: string; args: string[] } | undefined> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      fault: { type: 'string', multiple: true }, config: { type: 'string' }, report: { type: 'string' },
      surface: { type: 'string' }, help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) return undefined;
  const [command, ...args] = positionals;
  if (!command) throw new Error('Give the server command after "--"');
  const fromFile: Record<string, unknown> = values.config ? JSON.parse(await readFile(values.config, 'utf8')) : {};
  const plan = parsePlan({ ...fromFile, ...(values.surface && { surface: values.surface }) });
  plan.faults.push(...(values.fault ?? []).map(parseFaultFlag));
  return { plan, report: values.report ?? (typeof fromFile.report === 'string' ? fromFile.report : undefined), command, args };
}

let input: Awaited<ReturnType<typeof readPlan>>;
try {
  input = await readPlan();
} catch (error) {
  say(`faultline-mcp-proxy: ${error instanceof Error ? error.message : String(error)}\n\n${usage}`);
  process.exit(2);
}
if (!input) {
  say(usage);
  process.exit(0);
}
const { plan, report: reportPath, command, args } = input;

const upstream = await connectUpstream(command, args);
const proxy = createFaultProxy({ upstream, faults: plan.faults, surface: plan.surface });

// a misspelled tool name would otherwise never fire and look like a clean run
const known = new Set((await proxy.listTools()).map(tool => tool.name));
const unknown = planTools(plan).filter(name => !known.has(name));
if (unknown.length) {
  say(`faultline-mcp-proxy: the server has no tool named ${unknown.join(', ')}. Its tools: ${[...known].join(', ')}`);
  await upstream.close().catch(() => undefined);
  process.exit(2);
}
if (plan.faults.length) say(`faultline-mcp-proxy: breaking ${plan.faults.map(fault => `${fault.tool} (${fault.kind})`).join(', ')}. Tool calls still reach the real server, so use a test account.`);

let finishing: Promise<never> | undefined;
/** Runs once when the agent disconnects: checks the server's state and the trace, reports, and exits 1 if a check failed. */
const finish = () => finishing ??= (async () => {
  for (const check of plan.checks) await proxy.check(check);
  for (const check of plan.trace) proxy.checkTrace(check);
  const report = proxy.report();
  say(formatReport(report));
  if (report.status === 'unchecked' && proxy.unusedFaults().length) say(`Never reached: ${proxy.unusedFaults().join(', ')}`);
  if (reportPath) {
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify({ server: [command, ...args].join(' '), faults: plan.faults, ...report }, null, 2));
    say(`Saved report: ${reportPath}`);
  }
  await upstream.close().catch(() => undefined);
  process.exit(report.status === 'failed' ? 1 : 0);
})();

upstream.onclose = () => {
  if (finishing) return;
  say('faultline-mcp-proxy: the server exited');
  process.exit(1);
};
// the stdio transport doesn't report a closed stdin, which is how an MCP client hangs up
process.stdin.on('end', finish);
process.stdin.on('close', finish);
process.on('SIGINT', finish);
process.on('SIGTERM', finish);

await proxy.server().connect(new StdioServerTransport());
