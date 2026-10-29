import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowRight, Bot, Check, RotateCcw, Zap } from 'lucide-react';
import type { Run, Scenario } from '../../src/core/types';
import { agents, authorizedCents, describe, money, runBoth, scenarios, type Pair } from './demo';

const sections = [['demo', 'Demo'], ['how', 'How it works'], ['status', 'Status'], ['pricing', 'Pricing']] as const;
const totalOf = (run: Run) => run.refunds.reduce((sum, refund) => sum + refund.amountCents, 0);

export function App({ initial }: { initial?: Pair }) {
  return <>
    <a className="skip" href="#main">Skip to content</a>
    <header className="top">
      <div className="wrap">
        <a className="brand" href="#top" aria-label="Faultline, back to top"><span className="mark"><Zap size={15} fill="currentColor" aria-hidden="true" /></span>faultline</a>
        <nav aria-label="Sections">{sections.map(([id, label]) => <a key={id} href={`#${id}`}>{label}</a>)}</nav>
        <span className="tag">Private preview</span>
      </div>
    </header>
    <main id="main">
      <section className="hero wrap" id="top" aria-labelledby="hero-title">
        <div className="hero-copy">
          <p className="tagline">Crash tests for AI agents</p>
          <h1 id="hero-title">Test what your AI agent does when <mark>a tool fails.</mark></h1>
          <p className="lede">Faultline breaks the tools your AI agent relies on, then checks what actually happened. Every bug it finds becomes a test.</p>
          <div className="actions">
            <a className="button" href="#demo">Try the demo <ArrowDown size={17} aria-hidden="true" /></a>
            <a className="link" href="#how">How it works <ArrowRight size={16} aria-hidden="true" /></a>
          </div>
        </div>
        {initial && <Evidence run={initial.naive} />}
      </section>

      <Demo initial={initial} />

      <section className="block wrap how" id="how" aria-labelledby="how-title">
        <div className="how-copy">
          <h2 className="title" id="how-title">How it works</h2>
          <p>Your agent's tool calls go to a simulated service that Faultline controls. Faultline makes one call fail in a specific way, for example a refund that goes through but never sends back a reply, and lets the agent handle it.</p>
          <p>Then it reads the service's records to see what really happened. A duplicate refund, a refund over the authorized amount, or a success with no confirmation fails the run.</p>
          <p>Each scenario is a command that exits with an error when a check fails, so it can run in CI next to your other tests.</p>
        </div>
        {initial && <Terminal run={initial.naive} />}
      </section>

      <section className="block wrap" id="status" aria-labelledby="status-title">
        <h2 className="title" id="status-title">Where it stands</h2>
        <p className="intro">Faultline is in private preview. This is what works today and what doesn't yet.</p>
        <div className="sheets">
          <div className="sheet">
            <h3 className="sheet-tab ok">Works today</h3>
            <ul className="checklist done">
              <li>Three failure scenarios on a simulated refund service</li>
              <li>Checks based on what the service actually recorded</li>
              <li>A dashboard to compare agents run by run</li>
              <li>A command you can add to your CI pipeline</li>
              <li>Adapters for testing Claude and OpenAI models</li>
              <li>A library that adds the same faults to your own agent's tools</li>
            </ul>
          </div>
          <div className="sheet">
            <h3 className="sheet-tab">Not yet</h3>
            <ul className="checklist">
              <li>Tested against a live AI model</li>
              <li>Used by a team outside the project</li>
              <li>Faults in real network traffic</li>
              <li>Published as a package you can install</li>
              <li>A hosted version, or safe running of code you don't trust</li>
            </ul>
          </div>
        </div>
      </section>

      <section className="block wrap" id="roadmap" aria-labelledby="roadmap-title">
        <h2 className="title" id="roadmap-title">What's next</h2>
        <p className="intro">The next goal is to catch a real bug in an agent someone else built.</p>
        <ol className="track">
          <li className="done"><span className="node" aria-hidden="true" /><span className="when">Done</span><h3>Prove it locally</h3><p>The scenarios, dashboard and CI command all work on one machine.</p></li>
          <li className="next"><span className="node" aria-hidden="true" /><span className="when">Next</span><h3>Test real agents</h3><p>Run live AI models, then give other teams a simple way to plug in their own agent.</p></li>
          <li className="later"><span className="node" aria-hidden="true" /><span className="when">Later</span><h3>Go hosted</h3><p>Sandboxed runs, team accounts and sign-in, hosted in the cloud.</p></li>
        </ol>
      </section>

      <section className="block wrap" id="pricing" aria-labelledby="pricing-title">
        <h2 className="title" id="pricing-title">Pricing</h2>
        <p className="intro">Nothing is for sale yet and prices aren't set. The plan is to charge per trial, and only when an AI model runs.</p>
        <div className="plans">
          <article className="plan free"><h3>Built-in agents</h3><p className="price">Free</p><p>Everything that runs without an AI model, including all the scenarios and the dashboard.</p></article>
          <article className="plan"><h3>Your own key</h3><p className="price tbd">Price not set</p><p>Test live AI models. Your model provider bills you for usage directly.</p></article>
          <article className="plan"><h3>Included credits</h3><p className="price tbd">Price not set</p><p>Faultline covers model costs at one credit per trial. Unused credits come back to you.</p></article>
        </div>
      </section>
    </main>
    <footer>
      <div className="wrap">
        <a className="brand" href="#top"><span className="mark"><Zap size={15} fill="currentColor" aria-hidden="true" /></span>faultline</a>
        <span>Crash tests for AI agents · Private preview</span>
      </div>
    </footer>
  </>;
}

function Evidence({ run }: { run: Run }) {
  const total = totalOf(run);
  const order = run.refunds[0]?.orderId ?? 'order_demo_001';
  const times = run.refunds.length === 2 ? 'twice' : `${run.refunds.length} times`;
  return <figure className="evidence" role="img" aria-label={`The agent reported the refund as complete, but the service ledger shows ${run.refunds.length} refunds totalling ${money(total)} against ${money(authorizedCents)} authorized.`}>
    <div className="bubble" aria-hidden="true">
      <span className="avatar"><Bot size={18} /></span>
      <div>
        <p className="who">Support agent</p>
        <p>Refund complete for {order}. Confirmation {run.result.refundId ?? 'pending'}.</p>
        <span className="claim"><Check size={13} strokeWidth={3} /> Done</span>
      </div>
    </div>
    <div className="receipt-wrap" aria-hidden="true">
      <div className="receipt">
        <p className="receipt-head">Service ledger</p>
        <p className="receipt-sub">{order}</p>
        <ul>{run.refunds.map(refund => <li key={refund.id}><span>{refund.id}</span><span>{money(refund.amountCents)}</span></li>)}</ul>
        <p className="receipt-total"><span>Total refunded</span><span>{money(total)}</span></p>
        <p className="receipt-line"><span>Authorized</span><span>{money(authorizedCents)}</span></p>
        <span className="stamp">Paid {times}</span>
      </div>
    </div>
  </figure>;
}

// Mirrors the output format of `npm run faultline -- run` in src/cli.ts, line for line.
function Terminal({ run }: { run: Run }) {
  const strategy = run.agentVersion.split('/')[1];
  const lines = [
    `${run.status.toUpperCase()}  ${run.agentVersion} · ${run.scenario}`,
    `Run ${run.id}`,
    ...run.events.map(event => `  ${String(event.sequence).padStart(2, '0')}  +${event.timeMs}ms  ${event.message}`),
    ...run.assertions.map(assertion => `  ${assertion.passed ? '✓' : '✗'} ${assertion.label}: ${assertion.actual}`),
    `  Ledger: ${run.refunds.length} refund(s), ${money(totalOf(run))}`,
  ];
  return <figure className="terminal" aria-label="Output of a failing Faultline run in a terminal">
    <pre>
      <span className="prompt">$ npm run faultline -- run {run.scenario} {strategy}</span>{'\n'}
      {lines.map((line, index) => <span key={index} className={line.startsWith('  ✗') || line.startsWith('FAILED') ? 'bad' : line.startsWith('  ✓') ? 'good' : undefined}>{line}{'\n'}</span>)}
      <span className="prompt">$ echo $?</span>{'\n'}
      <span className={run.status === 'failed' ? 'bad' : 'good'}>{run.status === 'failed' ? 1 : 0}</span>
    </pre>
  </figure>;
}

function Demo({ initial }: { initial?: Pair }) {
  const [scenario, setScenario] = useState<Scenario>(scenarios[0]!.key);
  const [pair, setPair] = useState<Pair | undefined>(initial);
  const [round, setRound] = useState(0);
  const [error, setError] = useState('');
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const first = useRef(Boolean(initial));

  useEffect(() => {
    // main.tsx already ran the opening scenario, so the first frame is never empty.
    if (first.current) { first.current = false; return; }
    let current = true;
    runBoth(scenario).then(
      result => { if (current) { setPair(result); setError(''); } },
      () => { if (current) setError('The simulator could not run in this browser. Try reloading the page.'); },
    );
    return () => { current = false; };
  }, [scenario, round]);

  const active = scenarios.find(item => item.key === scenario)!;
  const choose = (index: number) => { setScenario(scenarios[index]!.key); tabs.current[index]?.focus(); };
  const elapsed = pair ? pair.naive.durationMs + pair.resilient.durationMs : 0;

  return <section className="chamber" id="demo" aria-labelledby="demo-title">
    <div className="wrap">
      <div className="chamber-head">
        <h2 className="title" id="demo-title">Try it</h2>
        <p className="intro chamber-sub">Two agents get the same task: refund a customer $129. Pick a fault and see what each one does.</p>
      </div>
      <div className="picker" role="tablist" aria-label="Choose what goes wrong" onKeyDown={event => {
        const step = ({ ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 } as Record<string, number>)[event.key];
        if (!step) return;
        event.preventDefault();
        choose((scenarios.findIndex(item => item.key === scenario) + step + scenarios.length) % scenarios.length);
      }}>
        {scenarios.map((item, index) => <button key={item.key} ref={el => { tabs.current[index] = el; }} className="pick" role="tab" type="button"
          id={`pick-${item.key}`} aria-controls="reports" aria-selected={item.key === scenario} tabIndex={item.key === scenario ? 0 : -1}
          onClick={() => setScenario(item.key)}>{item.name}</button>)}
      </div>
      <p className="question">{active.question}</p>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="reports" id="reports" role="tabpanel" aria-labelledby={`pick-${scenario}`}>
        {pair && agents.map(agent => <Report key={agent.key} name={agent.name} story={active.stories[agent.key]} run={pair[agent.key]} />)}
      </div>
      <p className="sr-only" aria-live="polite">{pair ? agents.map(agent => `${agent.name} ${pair[agent.key].status}.`).join(' ') : ''}</p>
      <div className="run-line">
        <p>Both runs just happened in your browser, using Faultline's real simulator, in <span className="ms" key={pair?.naive.id}>{elapsed.toFixed(2)} ms</span>.</p>
        <button className="again" type="button" onClick={() => setRound(value => value + 1)}><RotateCcw size={15} aria-hidden="true" />Run again</button>
      </div>
    </div>
  </section>;
}

function Report({ name, story, run }: { name: string; story: string; run: Run }) {
  const total = totalOf(run);
  const count = run.refunds.length;
  let commits = 0;
  return <article className={`report ${run.status}`} aria-label={name}>
    <div className="report-head">
      <h3>{name}</h3>
      <span className="verdict" key={run.id}>{run.status === 'passed' ? 'Pass' : 'Fail'}</span>
    </div>
    <dl className="facts">
      <div><dt>Agent said</dt><dd className="said" key={run.id}>{run.result.status === 'completed' ? 'Done' : 'Gave up'}</dd></div>
      <div><dt>Customer got</dt><dd className={`amount ${total > authorizedCents ? 'bad' : ''}`} key={run.id}>{money(total)}</dd><dd className="sub">{count === 0 ? 'No refund' : count === 1 ? '1 refund' : `${count} refunds`}</dd></div>
    </dl>
    <p className="story">{story}</p>
    <details>
      <summary>See the full trace</summary>
      <ol className="trace">{run.events.filter(event => event.kind !== 'agent.retry').map(event => {
        const duplicate = event.kind === 'tool.commit' && ++commits > 1;
        const detail = describe(event, duplicate);
        return <li key={event.sequence} className={event.kind === 'fault.injected' ? 'fault' : duplicate ? 'dup' : undefined}>
          <span>{event.message}</span>{detail && <small>{detail}</small>}
        </li>;
      })}</ol>
      <ul className="checks">{run.assertions.map(assertion => <li key={assertion.key}>
        <span className={assertion.passed ? 'ok' : 'no'} aria-hidden="true">{assertion.passed ? '✓' : '✗'}</span>
        <span><span className="sr-only">{assertion.passed ? 'Passed: ' : 'Failed: '}</span>{assertion.label}</span>
      </li>)}</ul>
      <p className="run-id">Run {run.id.slice(0, 8)} · times use a simulated clock</p>
    </details>
  </article>;
}
