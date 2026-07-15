export interface CapabilityMetricEvent {
  type: string;
  payload: unknown;
}

export interface CapabilityMetrics {
  outcomes: number;
  achieved: number;
  solveRate: number;
  firstPassRate: number;
  averageAttempts: number;
  evaluations: {
    total: number;
    passed: number;
    failed: number;
    error: number;
    passRate: number;
  };
  contextPacks: number;
  totalCostUsd: number;
  failuresByType: Record<string, number>;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

export function projectCapabilityMetrics(events: CapabilityMetricEvent[]): CapabilityMetrics {
  let outcomes = 0;
  let achieved = 0;
  let firstPass = 0;
  let attempts = 0;
  let contextPacks = 0;
  let totalCostUsd = 0;
  const evaluationCounts = { passed: 0, failed: 0, error: 0 };
  const failuresByType: Record<string, number> = {};

  for (const event of events) {
    const payload = record(event.payload);
    if (event.type === 'run.capability.context_pack') {
      contextPacks++;
      continue;
    }
    if (event.type === 'run.capability.evaluation') {
      const status = payload.status;
      if (status === 'passed' || status === 'failed' || status === 'error') evaluationCounts[status]++;
      continue;
    }
    if (event.type !== 'run.capability.outcome') continue;
    outcomes++;
    const outcomeAttempts = Array.isArray(payload.attempts) ? payload.attempts.length : 0;
    attempts += outcomeAttempts;
    if (payload.status === 'achieved') {
      achieved++;
      if (outcomeAttempts === 1) firstPass++;
    }
    if (typeof payload.failureType === 'string') {
      failuresByType[payload.failureType] = (failuresByType[payload.failureType] ?? 0) + 1;
    }
    if (Array.isArray(payload.evidence)) {
      for (const rawEvidence of payload.evidence) {
        const evidence = record(rawEvidence);
        if (evidence.kind === 'usage' && typeof evidence.costUsd === 'number') totalCostUsd += evidence.costUsd;
      }
    }
  }

  const totalEvaluations = evaluationCounts.passed + evaluationCounts.failed + evaluationCounts.error;
  return {
    outcomes,
    achieved,
    solveRate: ratio(achieved, outcomes),
    firstPassRate: ratio(firstPass, outcomes),
    averageAttempts: ratio(attempts, outcomes),
    evaluations: {
      total: totalEvaluations,
      ...evaluationCounts,
      passRate: ratio(evaluationCounts.passed, totalEvaluations),
    },
    contextPacks,
    totalCostUsd,
    failuresByType,
  };
}
