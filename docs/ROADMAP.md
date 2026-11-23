# Roadmap

Written 2026-11-23. `STATUS.md` says what works today. This says what comes next and why.

## Where it stands

- The tool finds real failures. A Claude model refunded an order twice in 10 of 10 trials under a prompt meant to make it safer, and on GitHub's MCP server a dropped reply led to a duplicate issue in 9 of 10 trials.
- Nobody outside this project uses it. The SDK is on npm, but the MCP proxy and the runner only work from a clone of this repository.
- The engineering is ahead of the evidence that anyone wants it.

So the next few months go to two things in this order: results other people can check, and a tool they can install. New features come after those, and only where a real run asked for one.

## Now: through December

1. **Report what the tool has already found.** Send the search-lag finding to GitHub's MCP server with the saved evidence. A finding only counts once the maintainers have seen it.
2. **Publish the proxy to npm.** SDK 0.2.0, which it depends on, is published. The proxy needs a package name that doesn't clash with the existing Faultline on npm.
3. **Ship the runner as a command.** `npm run evaluate:mcp` lives in `src/` and needs this repository. It should be one installable command that takes a plan and a server.
4. **Ship plans for well-known MCP servers.** The GitHub plans sit in an ignored folder. A `plans/` directory lets anyone repeat a published result with one command.

## Next: January and February

5. **Remote MCP servers.** The proxy only speaks stdio. Many production servers are reached over HTTP, so this is the largest gap in what the tool can test.
6. **A second model provider in the MCP runner.** It drives Claude models only. The OpenAI adapter exists for the refund scenarios and has never made a live call. Results on one provider invite the question of whether the failure is the model's or the tool's.
7. **Failures that arrive late.** Today the failure reaches the agent the moment the write lands, which is the worst case for a read that lags. A delay option makes the test match a real timeout.
8. **A stale-read fault.** GitHub's duplicate came from a search that was a few seconds behind. A fault that serves a read tool's previous result would reproduce that on any server, without depending on the server's own timing.
9. **A survey of MCP servers.** Run the lost-reply plan against the most used servers that have write tools, and publish which ones protect against a repeated write. Most of it needs no model, so it is cheap, and it is the clearest demonstration of what the tool is for.

## Later: March and April

10. **One place for results.** Refund runs go to PostgreSQL and the dashboard. MCP evaluations go to JSON files, and SDK results go nowhere. Storing all three together gives MCP runs the regression query the refund runs already have.
11. **A GitHub Action** that runs a plan on a pull request and fails it when a pass rate drops.
12. **Checks that look up what a trial created**, by its id, and a clean state for every trial.
13. **Decide what to do with the AWS build** before the free plan ends on 2027-05-04: tear it down, or pay for it because something uses it.

## Not planned until someone asks

- Hosting it for other people: sign-in, separate tenants, billing.
- Running untrusted agent code in containers.
- More fault types for the refund simulator. It is a demo now, and the MCP proxy is where real servers get tested.

## How to tell it is working

- A maintainer fixes something this tool reported.
- Someone outside the project runs it on their own agent or server and says what happened.
- A published result is repeated by someone else from the shipped plans.

None of these has happened yet. Pricing and willingness to pay are untested.

## Upkeep

- The Anthropic SDK is at 0.135 and 1.x is out. Upgrade before the next round of live runs.
- The price table in `src/evaluation/mcp.ts` is dated 2026-11-03. Check it before trusting a cost limit on a new model.
