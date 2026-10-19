import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Activity, ArrowDown, ArrowDownToLine, ArrowRight, Check, CheckCheck, ChevronRight, CircleAlert, Clock3, Database, FlaskConical, History, LoaderCircle, Play, RotateCcw, ShieldCheck, Terminal, X, Zap } from 'lucide-react';
import type { Run, Scenario, Strategy, TraceEvent } from '../../src/core/types';
import { api, type RunSummary } from './api';
import type { Job } from '../../src/jobs/types';

const scenarioInfo: Record<Scenario, { name: string; short: string; description: string; code: string }> = {
  'timeout-after-commit': { name: 'Timeout after commit', short: 'Lost acknowledgement', description: 'The refund succeeds. The response never arrives. Does the agent safely retry?', code: 'FAULT_01' },
  'rate-limit': { name: 'Rate limit', short: '429 · Retry-After', description: 'The service rejects requests for one second. Does the agent wait before retrying?', code: 'FAULT_02' },
  'malformed-response': { name: 'Malformed response', short: 'Missing confirmation', description: 'The refund succeeds, but the response has no confirmation ID. Does the agent verify the outcome?', code: 'FAULT_03' },
  baseline: { name: 'Healthy baseline', short: 'No fault injected', description: 'All tools respond normally. Establish that both agents complete the same task.', code: 'CONTROL' },
};
const scenarioOrder: Scenario[] = ['timeout-after-commit', 'rate-limit', 'malformed-response', 'baseline'];
const money = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
const strategyOf = (run: Pick<Run, 'agentVersion' | 'metadata'>): Strategy => run.agentVersion.includes('/resilient/') || run.metadata?.promptVariant === 'recovery' ? 'resilient' : 'naive';
const names: Record<Strategy, string> = { naive: 'Naive agent', resilient: 'Resilient agent' };
const isLive = (run: Pick<Run, 'metadata'>) => run.metadata?.provider !== undefined && run.metadata.provider !== 'fixture';
const agentName = (run: Pick<Run, 'agentVersion' | 'metadata'>) => isLive(run) ? `${run.metadata!.model ?? run.metadata!.provider} · ${run.metadata!.promptVariant ?? 'custom'}` : names[strategyOf(run)];
const explain = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Try again.';

export function App() {
  const [view, setView] = useState<'lab' | 'history'>('lab');
  const [scenario, setScenario] = useState<Scenario>('timeout-after-commit');
  const [runs, setRuns] = useState<Partial<Record<Strategy, Run>>>({});
  const [active, setActive] = useState<Strategy>('naive');
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<RunSummary[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [jobs, setJobs] = useState<Job[]>([]);
  const [jobError, setJobError] = useState('');
  const [progress, setProgress] = useState<Job>();
  const [filter, setFilter] = useState<'all' | 'failed' | 'passed'>('all');
  const compareRef = useRef<HTMLDivElement>(null);
  const selectedRun = runs[active];
  const scenarioDetails = scenarioInfo[scenario];

  function openView(next: 'lab' | 'history') {
    setView(next);
    window.scrollTo(0, 0);
  }
  async function refreshHistory() {
    setLoadingHistory(true);
    try { setHistory((await api.list()).runs); }
    catch (error) { setError(explain(error)); }
    finally { setLoadingHistory(false); }
  }
  async function refreshJobs() {
    try { setJobs((await api.jobs()).jobs); setJobError(''); }
    catch { setJobError('Queue status is unavailable. Check the local API connection.'); }
  }
  useEffect(() => {
    void refreshHistory(); void refreshJobs();
    const timer = setInterval(() => { void refreshJobs(); }, 2000);
    return () => clearInterval(timer);
  }, []);
  async function runComparison() {
    setBusy(true); setError(''); setNotice('Running both fixtures…'); setRuns({}); setActive('naive'); setProgress(undefined);
    try {
      // Keep completed evidence visible even if the second request fails.
      const naive = await api.run(scenario, 'naive', setProgress);
      setRuns({ naive });
      const resilient = await api.run(scenario, 'resilient', setProgress);
      setRuns({ naive, resilient });
      setNotice(`Comparison complete. Naive agent ${naive.status}; resilient agent ${resilient.status}.`);
      await refreshHistory();
    } catch (error) { setError(explain(error)); setNotice('Comparison interrupted. Completed runs remain saved.'); }
    finally { setBusy(false); void refreshJobs(); }
  }
  function chooseScenario(next: Scenario) {
    setScenario(next); setRuns({}); setNotice(''); setError(''); setActive('naive'); setProgress(undefined);
  }
  async function inspectRun(id: string) {
    setBusy(true); setError('');
    try {
      const run = await api.get(id);
      const strategy = strategyOf(run);
      // Commit the lab view before scrolling, so the saved run's outcome is what the user lands on.
      flushSync(() => {
        setScenario(run.scenario); setRuns({ [strategy]: run }); setActive(strategy); setView('lab');
        setProgress(undefined); setNotice(`Inspecting saved run ${run.id.slice(0, 8)}.`);
      });
      compareRef.current?.scrollIntoView({ block: 'start' });
    } catch (error) { setError(explain(error)); }
    finally { setBusy(false); }
  }
  function exportReport() {
    const report = { fixture: Object.values(runs).every(run => !isLive(run)), exportedAt: new Date().toISOString(), runs: Object.values(runs) };
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `faultline-${scenario}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <div className="app">
    <a className="skip" href="#main">Skip to content</a>
    <aside className="sidebar">
      <a href="#" className="brand" onClick={event => { event.preventDefault(); openView('lab'); }} aria-label="Faultline home"><span className="brand-mark"><Zap size={23} fill="currentColor" /></span>faultline<span className="version">/ 01</span></a>
      <div className="workspace"><span className="workspace-avatar">F</span><div><strong>Local workspace</strong><span>Development</span></div></div>
      <p className="section-label">WORKSPACE</p>
      <nav aria-label="Main navigation">
        <button className={view === 'lab' ? 'nav-item current' : 'nav-item'} aria-current={view === 'lab' ? 'page' : undefined} onClick={() => openView('lab')}><FlaskConical size={18} />Failure lab<ChevronRight size={16} /></button>
        <button className={view === 'history' ? 'nav-item current' : 'nav-item'} aria-current={view === 'history' ? 'page' : undefined} onClick={() => openView('history')}><History size={18} />Run history<span className="nav-count">{history.length}{history.length === 50 ? '+' : ''}</span></button>
      </nav>
      <div className="sidebar-note"><Terminal size={19} /><strong>Evidence over assumptions.</strong><p>Assert against the service ledger, not the agent's success message.</p></div>
      <div className="sidebar-footer"><Database size={16} /><span>PostgreSQL persistence</span></div>
    </aside>
    <div className="shell">
      <header className="topbar"><div className="breadcrumbs">Workspace <ChevronRight size={14} /><span>{view === 'lab' ? 'Failure lab' : 'Run history'}</span></div><span className="environment"><span />{Object.values(runs).some(run => isLive(run)) ? 'LOCAL · MODEL EVIDENCE' : 'LOCAL · FIXTURE MODE'}</span></header>
      <main id="main">
        <div className="page-heading"><div><p className="eyebrow">AGENT RELIABILITY / {view === 'lab' ? 'EXPERIMENTS' : 'EVIDENCE'}</p><h1>{view === 'lab' ? 'Failure lab' : 'Run history'}</h1><p>{view === 'lab' ? 'Break the tool. See what the agent does next.' : 'Every execution, its outcome, and the evidence behind it.'}</p></div><span className="build-tag">PREVIEW 0.1</span></div>
        {error && <div className="error-banner" role="alert"><CircleAlert size={18} /><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError('')}><X size={17} /></button></div>}
        <div className="sr-only" role="status" aria-live="polite">{notice}</div>
        {view === 'lab' ? <>
          <section className="experiment" aria-labelledby="experiment-heading">
            <div className="experiment-settings"><div className="panel-kicker"><span className="step">01</span><h2 id="experiment-heading">Configure the fault</h2></div>
              <fieldset disabled={busy}><legend className="sr-only">Failure scenario</legend><div className="scenario-grid">{scenarioOrder.map(key => <label key={key} className={`scenario-option ${scenario === key ? 'selected' : ''}`}><input type="radio" name="scenario" value={key} checked={scenario === key} onChange={() => chooseScenario(key)} /><span className="radio-mark" /><span><strong>{scenarioInfo[key].name}</strong><small>{scenarioInfo[key].short}</small></span></label>)}</div></fieldset>
            </div>
            <div className="experiment-brief"><span className="mono accent">{scenarioDetails.code}</span><h3>{scenarioDetails.name}</h3><p>{scenarioDetails.description}</p><div className="task-row"><span>Task</span><strong>Refund {money(12900)}</strong></div><div className="task-row"><span>Tool</span><code>issue_refund</code></div><button className="primary-button" disabled={busy} onClick={() => void runComparison()}>{busy ? <LoaderCircle size={17} className="spin" /> : <Play size={16} fill="currentColor" />}{busy ? 'Running comparison…' : 'Run comparison'}{!busy && <ArrowRight size={17} />}</button><small className="fixture-note">Two deterministic fixtures. No real payments.</small></div>
          </section>
          {progress && <div className="job-progress" role="status"><span className={`job-badge ${progress.status}`}>{progress.status === 'running' || progress.status === 'queued' ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}{progress.status}</span><span>{names[progress.strategy]} <code>{progress.id.slice(0, 8)}</code></span><span>Attempt {progress.attempts}/{progress.maxAttempts}</span></div>}
          <div className="section-heading" ref={compareRef}><div className="panel-kicker"><span className="step">02</span><h2>Compare the outcome</h2></div><button className="text-button" disabled={!Object.keys(runs).length || busy} onClick={exportReport}><ArrowDownToLine size={16} />Export evidence</button></div>
          <section className="comparison-grid" aria-label="Agent comparison">{(['naive', 'resilient'] as Strategy[]).map(strategy => <Outcome key={strategy} strategy={strategy} run={runs[strategy]} selected={active === strategy} onSelect={() => setActive(strategy)} />)}</section>
          {selectedRun ? <section className="evidence-grid" aria-label="Execution evidence"><Trace run={selectedRun} /><Ledger run={selectedRun} /></section> : <section className="empty-evidence"><Activity size={30} /><div><h3>{busy ? 'Collecting execution evidence' : 'The next retry tells the story.'}</h3><p>{Object.keys(runs).length ? 'Select the completed agent to inspect its trace.' : 'Run a comparison to see tool calls, injected faults, and what actually changed.'}</p></div></section>}
          <footer className="lab-footer"><ShieldCheck size={16} /><span>Simulated services · isolated ledger per run · state-based assertions</span></footer>
        </> : <section className="history-panel" aria-label="Saved runs"><div className="history-controls"><div className="filter-group" aria-label="Filter by result">{(['all', 'failed', 'passed'] as const).map(value => <button key={value} aria-pressed={filter === value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{value === 'all' ? 'All runs' : value === 'failed' ? 'Failed' : 'Passed'}</button>)}</div><button className="text-button" disabled={loadingHistory || busy} onClick={() => void refreshHistory()}><RotateCcw size={16} className={loadingHistory ? 'spin' : ''} />Refresh</button></div>
          <div className="queue-section"><div className="queue-heading"><h2>Execution queue</h2><span>Recent jobs · updates every 2s</span></div>{jobError ? <p className="queue-empty" role="status">{jobError}</p> : jobs.length ? <ul>{jobs.slice(0, 6).map(job => <li key={job.id}><div><strong>{names[job.strategy]}</strong><span>{scenarioInfo[job.scenario].name}</span></div><span className={`job-badge ${job.status}`}>{job.status}</span><span className="attempt-count">{job.attempts}/{job.maxAttempts} attempts</span>{job.runId ? <button className="text-button" disabled={busy} onClick={() => void inspectRun(job.runId!)}>Inspect<ArrowRight size={14} /></button> : <code>{job.id.slice(0, 8)}</code>}{job.error && <p className="job-error">{job.error}</p>}</li>)}</ul> : <p className="queue-empty">No queued executions yet. Start a comparison in the lab.</p>}</div>
          {loadingHistory ? <div className="history-empty">Loading saved runs…</div> : history.filter(run => filter === 'all' || run.status === filter).length ? <div className="table-scroll"><table className="history-table"><thead><tr><th>Run / agent</th><th>Scenario</th><th>Result</th><th>Started</th><th><span className="sr-only">Inspect</span></th></tr></thead><tbody>{history.filter(run => filter === 'all' || run.status === filter).map(run => <tr key={run.id}><td><strong>{agentName(run)}</strong><code>{run.id.slice(0, 8)}</code></td><td>{scenarioInfo[run.scenario]?.name ?? run.scenario}</td><td><Status status={run.status} /></td><td className="date">{new Date(run.startedAt).toLocaleString()}</td><td><button className="inspect-button" disabled={busy} onClick={() => void inspectRun(run.id)} aria-label={`Inspect run ${run.id.slice(0, 8)}`}>Inspect<ArrowRight size={15} /></button></td></tr>)}</tbody></table></div> : <div className="history-empty"><History size={28} /><h3>No {filter === 'all' ? '' : filter + ' '}runs yet.</h3><p>Run a comparison in the failure lab to save your first evidence.</p><button className="text-button" onClick={() => openView('lab')}>Open failure lab<ArrowRight size={16} /></button></div>}
          <p className="history-caption">Showing the latest 50 runs. Agent labels distinguish fixtures from live model evaluations.</p>
        </section>}
      </main>
    </div>
  </div>;
}

function Status({ status }: { status: Run['status'] }) {
  return <span className={`status ${status}`}>{status === 'passed' ? <Check size={13} /> : <X size={13} />}{status === 'passed' ? 'Passed' : 'Failed'}</span>;
}
function Outcome({ strategy, run, selected, onSelect }: { strategy: Strategy; run?: Run; selected: boolean; onSelect: () => void }) {
  const total = run?.refunds.reduce((sum, refund) => sum + refund.amountCents, 0);
  return <article className={`outcome ${run?.status ?? 'pending'} ${selected && run ? 'selected' : ''}`}>
    <div className="outcome-header"><div><span className="agent-icon">{strategy === 'naive' ? <RotateCcw size={19} /> : <ShieldCheck size={19} />}</span><h3>{run ? agentName(run) : names[strategy]}<span>{(run !== undefined && isLive(run)) ? 'Live model · simulated tools' : strategy === 'naive' ? 'Unprotected retries' : 'Idempotent retries + validation'}</span></h3></div>{run ? <Status status={run.status} /> : <span className="pending-label">Awaiting run</span>}</div>
    <div className="outcome-metrics"><div><span>Total refunded</span><strong>{total === undefined ? '—' : money(total)}</strong></div><div><span>Ledger entries</span><strong>{run ? String(run.refunds.length).padStart(2, '0') : '—'}</strong></div><div><span>Checks passed</span><strong>{run ? `${run.assertions.filter(item => item.passed).length}/${run.assertions.length}` : '—'}</strong></div></div>
    <div className="outcome-bottom"><span>{run ? (run.status === 'passed' ? 'All assertions satisfied' : `${run.assertions.filter(item => !item.passed).length} assertion${run.assertions.filter(item => !item.passed).length === 1 ? '' : 's'} failed`) : 'Run the experiment to collect evidence'}</span><button disabled={!run} onClick={onSelect} aria-pressed={selected && !!run}>{selected && run ? 'Viewing trace' : 'Inspect trace'}<ArrowDown size={14} /></button></div>
  </article>;
}
function eventIcon(event: TraceEvent) {
  if (event.kind === 'fault.injected') return <Zap size={15} />;
  if (event.kind === 'tool.commit') return <Database size={15} />;
  if (event.kind === 'agent.wait') return <Clock3 size={15} />;
  if (event.kind === 'agent.retry') return <RotateCcw size={15} />;
  if (event.kind === 'agent.result') return <CheckCheck size={15} />;
  return <ArrowRight size={15} />;
}
function Trace({ run }: { run: Run }) {
  return <div className="trace-panel"><div className="evidence-heading"><div><h2>Execution trace</h2><p>{agentName(run)} <span> / {run.id.slice(0, 8)}</span></p></div><span className="event-count">{run.events.length} events</span></div><ol className="trace-list">{run.events.map(event => <li key={event.sequence} className={event.kind === 'fault.injected' ? 'fault-event' : ''}><span className="event-number">{String(event.sequence).padStart(2, '0')}</span><span className="event-icon">{eventIcon(event)}</span><div className="event-content"><div><span className="event-kind">{event.kind}</span><time>+{event.timeMs}ms</time></div><p>{event.message}</p>{Object.keys(event.data).length > 0 && <details><summary>Payload</summary><pre>{JSON.stringify(event.data, null, 2)}</pre></details>}</div></li>)}</ol><div className="trace-footer"><Clock3 size={14} />Event timestamps use the simulation clock.</div></div>;
}
function Ledger({ run }: { run: Run }) {
  return <div className="verification-column"><section className="ledger-panel"><div className="evidence-heading"><div><h2>Service ledger</h2><p>The actual side effects</p></div><Database size={19} /></div><div className="ledger-rows">{run.refunds.length ? run.refunds.map(refund => <div className="ledger-row" key={refund.id}><div><strong>{refund.id}</strong><small>{refund.orderId}</small></div><span>{money(refund.amountCents)}</span></div>) : <p className="no-refunds">No refunds committed.</p>}</div><div className="ledger-total"><span>Authorized</span><strong>{money(12900)}</strong></div><div className={`ledger-total final ${run.refunds.reduce((sum, refund) => sum + refund.amountCents, 0) > 12900 ? 'over-budget' : ''}`}><span>Actual total</span><strong>{money(run.refunds.reduce((sum, refund) => sum + refund.amountCents, 0))}</strong></div></section><section className="assertions-panel"><div className="evidence-heading"><h2>Assertions</h2><span className="event-count">{run.assertions.length} checks</span></div><ul>{run.assertions.map(assertion => <li key={assertion.key} className={assertion.passed ? 'assertion-pass' : 'assertion-fail'}><span className="assertion-icon">{assertion.passed ? <Check size={14} /> : <X size={14} />}</span><div><h3>{assertion.label}</h3><p>Observed: {assertion.actual}</p>{!assertion.passed && <p>Expected: {assertion.expected}</p>}</div></li>)}</ul></section></div>;
}
