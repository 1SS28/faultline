import type { Run } from '../core/types.js';

/** A nominal 95% Wilson interval for a pass rate. It assumes independent trials. */
export function wilson95(passed: number, count: number) {
  const p = passed / count, z = 1.96, divisor = 1 + z * z / count;
  const center = (p + z * z / (2 * count)) / divisor;
  const margin = z * Math.sqrt((p * (1 - p) + z * z / (4 * count)) / count) / divisor;
  return { lower: Math.max(0, center - margin), upper: Math.min(1, center + margin), method: 'Wilson; assumes independent trials' };
}

export function summarizeTrials(runs: Run[]) {
  const groups = new Map<string, Run[]>();
  for (const run of runs) {
    const key = `${run.agentVersion}:${run.scenario}`;
    const group = groups.get(key) ?? []; group.push(run); groups.set(key, group);
  }
  return [...groups.values()].map(group => {
    const count = group.length, passed = group.filter(run => run.status === 'passed').length;
    const p = passed / count;
    const live = group.every(run => run.metadata?.provider !== undefined && run.metadata.provider !== 'fixture');
    const keys = [...new Set(group.flatMap(run => run.assertions.map(item => item.key)))];
    const sum = (field: 'modelCalls' | 'inputTokens' | 'outputTokens' | 'textOnlyTurns' | 'truncatedTurns') =>
      group.reduce((total, run) => total + (run.metadata?.[field] ?? 0), 0);
    return {
      agentVersion: group[0]!.agentVersion, scenario: group[0]!.scenario, trials: count, passed,
      passRate: Math.round(p * 10000) / 100,
      // an interval means nothing for deterministic fixtures
      confidence95: live ? wilson95(passed, count) : null,
      failedAssertions: Object.fromEntries(keys.map(key => [key, group.filter(run => run.assertions.some(item => item.key === key && !item.passed)).length])),
      // so an exhausted turn budget never reads as a deliberate escalation
      stopReasons: live ? group.reduce<Record<string, number>>((counts, run) => {
        const reason = run.metadata?.stopReason ?? 'unknown'; counts[reason] = (counts[reason] ?? 0) + 1; return counts;
      }, {}) : null,
      modelCalls: sum('modelCalls'), inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'),
      textOnlyTurns: sum('textOnlyTurns'), truncatedTurns: sum('truncatedTurns'),
    };
  });
}
