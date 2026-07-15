import type {
  AgentAttempt,
  AgentOutcome,
  CapabilityLoopState,
  Evidence,
  EvaluationResult,
  TaskContract,
  UsageEvidence,
} from '@co/protocol';
import type { ContextPack } from './contextPack';

export type { CapabilityLoopState } from '@co/protocol';

export interface CapabilityEvaluationInput {
  summary: string;
  endedAt: string;
  evaluations: EvaluationResult[];
  evidence?: Evidence[];
}

export interface CommandExecutionRequest {
  command: string;
  cwd: string;
  timeoutMs: number;
}

export interface CommandExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type CommandExecutor = (request: CommandExecutionRequest) => Promise<CommandExecutionResult>;

export type CapabilityTransition =
  | { action: 'complete'; state: CapabilityLoopState }
  | { action: 'retry'; state: CapabilityLoopState; feedback: string }
  | { action: 'blocked'; state: CapabilityLoopState }
  | { action: 'exhausted'; state: CapabilityLoopState };

export function startCapabilityLoop(
  contract: TaskContract,
  sessionId: string,
  startedAt: string,
): CapabilityLoopState {
  return {
    kind: 'capability_loop',
    phase: 'attempt_running',
    contract,
    attempts: [{
      number: 1,
      sessionId,
      startedAt,
      status: 'running',
      evaluations: [],
      evidence: [],
    }],
    execution: 'running',
  };
}

export function markCapabilityEvaluating(state: CapabilityLoopState): CapabilityLoopState {
  const current = state.attempts.at(-1);
  if (state.phase === 'evaluating' && current?.status === 'evaluating') return state;
  if (state.phase !== 'attempt_running' || current?.status !== 'running') {
    throw new Error(`capability loop is not ready to evaluate (phase=${state.phase})`);
  }
  return {
    ...state,
    phase: 'evaluating',
    attempts: [...state.attempts.slice(0, -1), { ...current, status: 'evaluating' }],
  };
}

/** 把成功契约放进 Agent 可见上下文；Evaluator 仍独立执行，不能由 Agent 自报通过。 */
export function taskContractInstruction(contract: TaskContract): string {
  const criteria = contract.acceptanceCriteria
    .map((criterion) => `- [${criterion.id}] ${criterion.description}`)
    .join('\n');
  const constraints = contract.constraints.length > 0
    ? contract.constraints.map((constraint) => `- ${constraint}`).join('\n')
    : '- 无额外约束';
  return [
    '你正在执行一份带独立验证的任务契约。回合结束不代表任务完成；Harness 会运行验收器，并在失败时提供反馈。',
    contract.objective ? `目标：${contract.objective}` : undefined,
    '验收标准：',
    criteria,
    '约束：',
    constraints,
    `Attempt 预算：最多 ${contract.budget.maxAttempts} 次。`,
  ].filter((line): line is string => Boolean(line)).join('\n');
}

export function beginNextCapabilityAttempt(
  state: CapabilityLoopState,
  sessionId: string,
  startedAt: string,
  contextPack?: ContextPack,
): CapabilityLoopState {
  if (state.phase !== 'feedback_ready') {
    throw new Error(`capability loop is not ready for another attempt (phase=${state.phase})`);
  }
  const number = state.attempts.length + 1;
  if (number > state.contract.budget.maxAttempts) {
    throw new Error(`capability loop attempt budget exhausted (${state.contract.budget.maxAttempts})`);
  }
  return {
    ...state,
    phase: 'attempt_running',
    attempts: [...state.attempts, {
      number,
      sessionId,
      startedAt,
      status: 'running',
      evaluations: [],
      evidence: [],
    }],
    execution: 'running',
    contextPack,
    pendingFeedback: undefined,
  };
}

export function eventBelongsToCurrentAttempt(state: CapabilityLoopState, eventCreatedAt: Date): boolean {
  const current = state.attempts.at(-1);
  if (!current) return false;
  return eventCreatedAt.getTime() >= new Date(current.startedAt).getTime();
}

const EVIDENCE_OUTPUT_LIMIT = 6_000;

export async function evaluateTaskContract(
  contract: TaskContract,
  cwd: string,
  execute: CommandExecutor,
  nowMs: () => number = Date.now,
): Promise<EvaluationResult[]> {
  const evaluations: EvaluationResult[] = [];
  for (const criterion of contract.acceptanceCriteria) {
    const evaluator = criterion.evaluator;
    const startedAt = nowMs();
    try {
      const result = await execute({
        command: evaluator.run,
        cwd,
        timeoutMs: evaluator.timeoutMs,
      });
      const durationMs = Math.max(0, Math.round(nowMs() - startedAt));
      const stdout = result.stdout.slice(-EVIDENCE_OUTPUT_LIMIT);
      const stderr = result.stderr.slice(-EVIDENCE_OUTPUT_LIMIT);
      const pass = result.exitCode === 0;
      const failureDetail = (stderr || stdout).trim();
      evaluations.push({
        criterionId: criterion.id,
        status: pass ? 'passed' : 'failed',
        detail: pass
          ? 'command exited 0'
          : `command exited ${result.exitCode}${failureDetail ? `: ${failureDetail}` : ''}`,
        evidence: {
          kind: 'command',
          criterionId: criterion.id,
          command: evaluator.run,
          pass,
          exitCode: result.exitCode,
          stdout,
          stderr,
          durationMs,
        },
      });
    } catch (error) {
      const durationMs = Math.max(0, Math.round(nowMs() - startedAt));
      const detail = error instanceof Error ? error.message : String(error);
      evaluations.push({
        criterionId: criterion.id,
        status: 'error',
        detail: `evaluator failed: ${detail}`,
        evidence: {
          kind: 'command',
          criterionId: criterion.id,
          command: evaluator.run,
          pass: false,
          exitCode: -1,
          stdout: '',
          stderr: detail.slice(-EVIDENCE_OUTPUT_LIMIT),
          durationMs,
        },
      });
    }
  }
  return evaluations;
}

function feedbackFrom(evaluations: EvaluationResult[]): string {
  const findings = evaluations
    .filter((evaluation) => evaluation.status !== 'passed')
    .map((evaluation) => `- [${evaluation.criterionId}] ${evaluation.detail}`)
    .join('\n');
  return [
    '任务尚未满足成功契约。请根据下面的验证结果继续修改；完成后说明改动，并等待重新验证。',
    '',
    findings || '- 验证结果不完整，请重新检查任务验收标准。',
  ].join('\n');
}

function evidenceFrom(attempts: AgentAttempt[]) {
  return attempts.flatMap((attempt) => [
    ...attempt.evaluations.map((evaluation) => evaluation.evidence),
    ...(attempt.evidence ?? []),
  ]);
}

const USAGE_KEYS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'costUsd', 'turns'] as const;

/** Runner 上报的是 session 累计值；Outcome 保存每个 Attempt 的 delta，避免成本重复累计。 */
export function usageEvidenceForAttempt(
  state: CapabilityLoopState,
  cumulative: Omit<UsageEvidence, 'kind'>,
): UsageEvidence {
  const sessionId = state.attempts.at(-1)?.sessionId;
  const prior: Record<(typeof USAGE_KEYS)[number], number> = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0,
    turns: 0,
  };
  for (const attempt of state.attempts) {
    if (attempt.sessionId !== sessionId) continue;
    for (const evidence of attempt.evidence) {
      if (evidence.kind !== 'usage') continue;
      for (const key of USAGE_KEYS) prior[key] += evidence[key] ?? 0;
    }
  }
  const delta: UsageEvidence = { kind: 'usage' };
  for (const key of USAGE_KEYS) {
    const value = cumulative[key];
    if (typeof value === 'number') delta[key] = Math.max(0, value - prior[key]);
  }
  return delta;
}

function budgetViolations(
  contract: TaskContract,
  attempts: AgentAttempt[],
  endedAt: string,
  needsAnotherAttempt: boolean,
): string[] {
  const total = attempts.flatMap((attempt) => attempt.evidence)
    .filter((evidence): evidence is UsageEvidence => evidence.kind === 'usage')
    .reduce((usage, evidence) => ({
      turns: usage.turns + (evidence.turns ?? 0),
      costUsd: usage.costUsd + (evidence.costUsd ?? 0),
    }), { turns: 0, costUsd: 0 });
  const elapsedMs = Math.max(
    0,
    new Date(endedAt).getTime() - new Date(attempts[0]?.startedAt ?? endedAt).getTime(),
  );
  const violations: string[] = [];
  if (
    contract.budget.maxTurns !== undefined
    && (total.turns > contract.budget.maxTurns
      || (needsAnotherAttempt && total.turns >= contract.budget.maxTurns))
  ) {
    violations.push(`maxTurns ${total.turns}/${contract.budget.maxTurns}`);
  }
  if (
    contract.budget.maxCostUsd !== undefined
    && (total.costUsd > contract.budget.maxCostUsd
      || (needsAnotherAttempt && total.costUsd >= contract.budget.maxCostUsd))
  ) {
    violations.push(`maxCostUsd ${total.costUsd.toFixed(4)}/${contract.budget.maxCostUsd.toFixed(4)}`);
  }
  if (
    contract.budget.timeoutMs !== undefined
    && (elapsedMs > contract.budget.timeoutMs
      || (needsAnotherAttempt && elapsedMs >= contract.budget.timeoutMs))
  ) {
    violations.push(`timeoutMs ${elapsedMs}/${contract.budget.timeoutMs}`);
  }
  return violations;
}

function missingBudgetMeasurements(contract: TaskContract, attempts: AgentAttempt[]): string[] {
  const usage = attempts.flatMap((attempt) => attempt.evidence)
    .filter((evidence): evidence is UsageEvidence => evidence.kind === 'usage');
  const missing: string[] = [];
  if (contract.budget.maxTurns !== undefined && !usage.some((evidence) => evidence.turns !== undefined)) {
    missing.push('maxTurns');
  }
  if (contract.budget.maxCostUsd !== undefined && !usage.some((evidence) => evidence.costUsd !== undefined)) {
    missing.push('maxCostUsd');
  }
  return missing;
}

export function blockCapabilityLoop(
  state: CapabilityLoopState,
  summary: string,
  failureType: NonNullable<AgentOutcome['failureType']>,
): CapabilityLoopState {
  return {
    ...state,
    phase: 'blocked',
    outcome: {
      status: 'blocked',
      summary,
      evidence: evidenceFrom(state.attempts),
      attempts: state.attempts,
      failureType,
    },
  };
}

export function recordCapabilityFailure(
  state: CapabilityLoopState,
  input: {
    summary: string;
    endedAt: string;
    failureType: 'agent_transport' | 'agent_execution';
  },
): CapabilityLoopState {
  const current = state.attempts.at(-1);
  if (!current || current.status !== 'running') {
    throw new Error(`capability loop is not awaiting an Agent result (phase=${state.phase})`);
  }
  const attempts: AgentAttempt[] = [
    ...state.attempts.slice(0, -1),
    {
      ...current,
      endedAt: input.endedAt,
      summary: input.summary,
      status: 'errored',
    },
  ];
  return blockCapabilityLoop(
    { ...state, attempts },
    input.summary || 'Agent execution failed before the task could be evaluated.',
    input.failureType,
  );
}

export function recordCapabilityEvaluation(
  state: CapabilityLoopState,
  input: CapabilityEvaluationInput,
): CapabilityTransition {
  const current = state.attempts.at(-1);
  if (!current || !['running', 'evaluating'].includes(current.status)) {
    throw new Error(`capability loop is not awaiting an evaluation (phase=${state.phase})`);
  }

  const expected = new Set(state.contract.acceptanceCriteria.map((criterion) => criterion.id));
  const received = new Set(input.evaluations.map((evaluation) => evaluation.criterionId));
  const evaluationComplete = input.evaluations.length === expected.size
    && received.size === expected.size
    && [...received].every((criterionId) => expected.has(criterionId));
  const evaluatorErrored = !evaluationComplete
    || input.evaluations.some((evaluation) => evaluation.status === 'error');
  const availableEvidence = new Set<string>();
  if (input.evaluations.length > 0) availableEvidence.add('evaluation');
  for (const evidence of input.evidence ?? []) availableEvidence.add(evidence.kind);
  const missingEvidence = state.contract.requiredEvidence.filter((kind) => !availableEvidence.has(kind));
  const hasError = evaluatorErrored || missingEvidence.length > 0;
  const passed = !hasError
    && input.evaluations.every((evaluation) => evaluation.status === 'passed');
  const attempt: AgentAttempt = {
    ...current,
    endedAt: input.endedAt,
    summary: input.summary,
    status: hasError ? 'errored' : passed ? 'passed' : 'failed',
    evaluations: input.evaluations,
    evidence: input.evidence ?? [],
  };
  const attempts = [...state.attempts.slice(0, -1), attempt];

  if (hasError) {
    const missing = missingEvidence.length > 0;
    const outcome: AgentOutcome = {
      status: 'blocked',
      summary: missing
        ? `Required evidence is missing: ${missingEvidence.join(', ')}`
        : 'Evaluator infrastructure failed; the task result could not be verified.',
      evidence: evidenceFrom(attempts),
      attempts,
      failureType: missing ? 'context_missing' : 'evaluator_infrastructure',
    };
    return { action: 'blocked', state: { ...state, phase: 'blocked', attempts, outcome } };
  }

  const unmeasurable = missingBudgetMeasurements(state.contract, attempts);
  if (unmeasurable.length > 0) {
    const outcome: AgentOutcome = {
      status: 'blocked',
      summary: `Configured execution budget cannot be measured: ${unmeasurable.join(', ')}`,
      evidence: evidenceFrom(attempts),
      attempts,
      failureType: 'context_missing',
    };
    return { action: 'blocked', state: { ...state, phase: 'blocked', attempts, outcome } };
  }

  const exceeded = budgetViolations(state.contract, attempts, input.endedAt, !passed);
  if (exceeded.length > 0) {
    const outcome: AgentOutcome = {
      status: 'exhausted',
      summary: `Execution budget exceeded: ${exceeded.join(', ')}`,
      evidence: evidenceFrom(attempts),
      attempts,
      failureType: 'budget_exhausted',
    };
    return { action: 'exhausted', state: { ...state, phase: 'exhausted', attempts, outcome } };
  }

  if (passed) {
    const outcome: AgentOutcome = {
      status: 'achieved',
      summary: input.summary,
      evidence: evidenceFrom(attempts),
      attempts,
    };
    return { action: 'complete', state: { ...state, phase: 'achieved', attempts, outcome } };
  }

  if (attempt.number >= state.contract.budget.maxAttempts) {
    const outcome: AgentOutcome = {
      status: 'exhausted',
      summary: input.summary,
      evidence: evidenceFrom(attempts),
      attempts,
      failureType: 'budget_exhausted',
    };
    return { action: 'exhausted', state: { ...state, phase: 'exhausted', attempts, outcome } };
  }

  const feedback = feedbackFrom(input.evaluations);
  return {
    action: 'retry',
    state: { ...state, phase: 'feedback_ready', attempts, pendingFeedback: feedback },
    feedback,
  };
}
