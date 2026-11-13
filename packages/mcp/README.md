# Faultline MCP Proxy

Breaks an MCP server's tool calls on purpose, then asks the server what it really did. It sits between your agent and any MCP server that runs over stdio, so you can test a server you didn't write without changing its code.

It is not on npm yet. Until it is, run `npm run build:mcp` from the repository root, or start it from source with `npx tsx packages/mcp/src/cli.ts`.

## What it does

1. Your agent connects to the proxy instead of the server. It sees the same tools, name and instructions.
2. The proxy passes every call to the real server. For the calls you pick, it lets the call go through and then tells the agent it failed.
3. When the agent disconnects, the proxy calls the server's own read tools and counts what is really there.

The classic case: a write succeeds, the reply is lost, the agent retries, and now there are two issues, two invites or two refunds. The agent's final message says everything went fine. The proxy's check says otherwise.

## Use it

Put the proxy in front of the server wherever your agent's MCP servers are configured. Everything after `--` is the command that normally starts the server.

```json
{
  "mcpServers": {
    "notes": {
      "command": "npx",
      "args": ["faultline-mcp-proxy", "--config", "plan.json", "--report", "report.json", "--", "npx", "-y", "your-mcp-server"]
    }
  }
}
```

`plan.json` says what to break and what to check afterwards:

```json
{
  "faults": [
    { "tool": "create_note", "kind": "timeout-after-commit" }
  ],
  "checks": [
    { "label": "\"Buy milk\" exists exactly once", "tool": "list_notes", "count": "Buy milk", "min": 1, "max": 1 }
  ]
}
```

Run your agent as usual. When it disconnects, the proxy prints the trace and the checks to stderr, writes the report file, and exits 1 if a check failed:

```
FAILED
  01  +232ms  create_note called
  02  +233ms  create_note ran against the service
  03  +233ms  create_note ran, but its response was lost
  04  +234ms  create_note called
  05  +234ms  create_note ran against the service
  06  +234ms  create_note returned
  ✗ "Buy milk" exists exactly once: 2 (expected 1)
```

For a quick try without a file, `--fault create_note:timeout-after-commit` breaks the first call, and `--fault create_note:timeout-after-commit@2,3` breaks the second and third.

**Tool calls still reach the real server.** A broken write is a real write. Point the proxy at a test account, a test workspace or a throwaway repository, never at real data.

## Faults

Each fault names a tool and the call numbers it applies to, counting that tool's calls from 1. The default is the first call.

| Kind | What the server does | What the agent sees |
|---|---|---|
| `timeout-after-commit` | Runs the call | A timeout |
| `timeout-before-commit` | Nothing, the call never arrives | A timeout |
| `rate-limit` | Nothing until `retryAfterMs` has passed (default 1000) | "Rate limit exceeded. Retry after 1000ms." |
| `malformed-response` | Runs the call | An empty result |

The timeout text is "Request timed out". Set `message` on a fault to use the wording your real stack produces. The text deliberately doesn't say that the outcome is unknown, because a real timeout doesn't either.

By default a failure arrives as a tool result with `isError: true`, which is how most servers report a failed upstream call. Set `"surface": "protocol-error"` to send a JSON-RPC error instead, as a client-side timeout would look.

## Checks

A check calls one of the server's read tools, with the `args` you give, and counts how often the `count` pattern appears in the text it returns. `count` is a regular expression. Give `min`, `max` or both.

Checks run against the real server with no faults, and they aren't part of the agent's trace. A session with no checks is reported as `UNCHECKED`, never as passed.

Two things stop a run from passing for the wrong reason. The proxy refuses to start if a fault or check names a tool the server doesn't have. And if a planned fault never fired, because the agent never made that call, the run fails with "Every planned fault fired" even when the checks hold.

## As a library

```ts
import { connectUpstream, createFaultProxy, formatReport } from 'faultline-mcp-proxy';

const upstream = await connectUpstream('npx', ['-y', 'your-mcp-server']);
const proxy = createFaultProxy({ upstream, faults: [{ tool: 'create_note', kind: 'timeout-after-commit' }] });

const tools = await proxy.listTools();               // hand these to your model
const result = await proxy.callTool('create_note', { title: 'Buy milk' });   // what the agent sees

await proxy.check({ label: 'One note', tool: 'list_notes', count: 'Buy milk', min: 1, max: 1 });
console.log(formatReport(proxy.report()));
```

`proxy.server()` returns an MCP server you can connect to any transport. Pass your own `lab` from `faultline-sdk` to use a simulated clock or to add checks in code.

## Limits

- The fault is injected between the agent and the server. The proxy can't make the server's own calls to its backend fail, so it won't find a server that mishandles a timeout from the API behind it.
- It starts stdio servers only. Remote servers over HTTP aren't supported yet.
- Tools, resources and prompts are passed through. Notifications, sampling and elicitation are not.
- A check counts text matches. It can't compare fields or follow pagination, so write the read call to return everything you need on one page.
- The trace and report hold tool arguments and results. Treat the report file like the data it came from.
- It has run against the test server in this repository and the official MCP memory server. No one outside the project has used it.

## License

Apache License, Version 2.0. See `LICENSE` and `NOTICE`.
