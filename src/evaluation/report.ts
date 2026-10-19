import type { Run } from '../core/types.js';
export function summarizeTrials(runs: Run[]) {
  const groups = new Map<string, Run[]>();
  for (const run of runs) {
    const key = `${run.agentVersion}:${run.scenario}`;
    const group = groups.get(key) ?? []; group.push(run); groups.set(key, group);
  }
  return [...groups.values()].map(group => {
    const count = group.length, passed = group.filter(run => run.status === 'passed').length;
    const p = passed / count, z = 1.96, divisor = 1 + z * z / count;
    const center = (p + z * z / (2 * count)) / divisor;
    const margin = z * Math.sqrt((p * (1 - p) + z * z / (4 * count)) / count) / divisor;
    const live = group.every(run => run.metadata?.provider !== undefined && run.metadata.provider !== 'fixture');
    return {
      agentVersion: group[0]!.agentVersion, scenario: group[0]!.scenario, trials: count, passed,
      passRate: Math.round(p * 10000) / 100,
      // Nominal interval assumes independent trials; not meaningful for deterministic fixtures.
      confidence95: live ? { lower: Math.max(0, center - margin), upper: Math.min(1, center + margin), method: 'Wilson; assumes independent trials' } : null,
      failedAssertions: Object.fromEntries([...new Set(group.flatMap(run => run.assertions.map(item => item.key)))].map(key => [key, group.filter(run => run.assertions.some(item => item.key === key && !item.passed)).length])),
      // Separates the model's own finish call from loop limits, so an exhausted turn budget never reads as a deliberate escalation.
      stopReasons: live ? group.reduce<Record<string, number>>((counts, run) => {
        const reason = run.metadata?.stopReason ?? 'unknown'; counts[reason] = (counts[reason] ?? 0) + 1; return counts;
      }, {}) : null,
      modelCalls: group.reduce((sum, run) => sum + (run.metadata?.modelCalls ?? 0), 0),
      inputTokens: group.reduce((sum, run) => sum + (run.metadata?.inputTokens ?? 0), 0),
      outputTokens: group.reduce((sum, run) => sum + (run.metadata?.outputTokens ?? 0), 0),
      textOnlyTurns: group.reduce((sum, run) => sum + (run.metadata?.textOnlyTurns ?? 0), 0),
      truncatedTurns: group.reduce((sum, run) => sum + (run.metadata?.truncatedTurns ?? 0), 0),
    };
  });
}
