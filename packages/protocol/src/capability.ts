import * as z from 'zod';
import { contextPackSchema } from './contextPack';

export const commandEvaluatorSchema = z.object({
  kind: z.literal('command'),
  run: z.string().trim().min(1),
  timeoutMs: z.number().int().positive().max(3_600_000).default(300_000),
}).strict();
export type CommandEvaluator = z.infer<typeof commandEvaluatorSchema>;

export const evaluatorSchema = z.discriminatedUnion('kind', [commandEvaluatorSchema]);
export type Evaluator = z.infer<typeof evaluatorSchema>;

export const acceptanceCriterionSchema = z.object({
  id: z.string().trim().min(1),
  description: z.string().trim().min(1),
  evaluator: evaluatorSchema,
}).strict();
export type AcceptanceCriterion = z.infer<typeof acceptanceCriterionSchema>;

export const evidenceRequirementSchema = z.enum([
  'evaluation',
  'agent_summary',
  'session',
  'usage',
]);
export type EvidenceRequirement = z.infer<typeof evidenceRequirementSchema>;

export const executionBudgetSchema = z.object({
  maxAttempts: z.number().int().positive().max(20).default(3),
  maxTurns: z.number().int().positive().optional(),
  maxCostUsd: z.number().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
}).strict();
export type ExecutionBudget = z.infer<typeof executionBudgetSchema>;

export const taskContractSchema = z.object({
  version: z.literal(1).default(1),
  objective: z.string().trim().min(1).optional(),
  acceptanceCriteria: z.array(acceptanceCriterionSchema).min(1),
  requiredEvidence: z.array(evidenceRequirementSchema).min(1).default(['evaluation']),
  constraints: z.array(z.string().trim().min(1)).default([]),
  budget: executionBudgetSchema.default({ maxAttempts: 3 }),
}).strict();
export type TaskContract = z.infer<typeof taskContractSchema>;

export const commandEvidenceSchema = z.object({
  kind: z.literal('command'),
  criterionId: z.string().trim().min(1),
  command: z.string().trim().min(1),
  pass: z.boolean(),
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  durationMs: z.number().int().nonnegative(),
}).strict();
export type CommandEvidence = z.infer<typeof commandEvidenceSchema>;

export const agentSummaryEvidenceSchema = z.object({
  kind: z.literal('agent_summary'),
  text: z.string().trim().min(1),
}).strict();

export const sessionEvidenceSchema = z.object({
  kind: z.literal('session'),
  sessionId: z.string().min(1),
  backend: z.string().min(1),
  model: z.string().optional(),
}).strict();

export const usageEvidenceSchema = z.object({
  kind: z.literal('usage'),
  inputTokens: z.number().nonnegative().optional(),
  outputTokens: z.number().nonnegative().optional(),
  cacheReadTokens: z.number().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
  turns: z.number().int().nonnegative().optional(),
}).strict();
export type UsageEvidence = z.infer<typeof usageEvidenceSchema>;

export const evidenceSchema = z.discriminatedUnion('kind', [
  commandEvidenceSchema,
  agentSummaryEvidenceSchema,
  sessionEvidenceSchema,
  usageEvidenceSchema,
]);
export type Evidence = z.infer<typeof evidenceSchema>;

export const evaluationResultSchema = z.object({
  criterionId: z.string().trim().min(1),
  status: z.enum(['passed', 'failed', 'error']),
  detail: z.string(),
  evidence: commandEvidenceSchema,
}).strict();
export type EvaluationResult = z.infer<typeof evaluationResultSchema>;

export const agentAttemptSchema = z.object({
  number: z.number().int().positive(),
  sessionId: z.string().min(1),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().optional(),
  summary: z.string().optional(),
  status: z.enum(['running', 'evaluating', 'passed', 'failed', 'errored']),
  evaluations: z.array(evaluationResultSchema).default([]),
  evidence: z.array(evidenceSchema).default([]),
}).strict();
export type AgentAttempt = z.infer<typeof agentAttemptSchema>;

export const agentOutcomeSchema = z.object({
  status: z.enum(['achieved', 'blocked', 'exhausted']),
  summary: z.string(),
  evidence: z.array(evidenceSchema),
  attempts: z.array(agentAttemptSchema).min(1),
  failureType: z.enum([
    'agent_transport',
    'agent_execution',
    'acceptance_failed',
    'evaluator_infrastructure',
    'context_missing',
    'budget_exhausted',
    'human_required',
  ]).optional(),
}).strict().superRefine((outcome, ctx) => {
  if (outcome.status === 'achieved' && !outcome.evidence.some((item) => item.kind === 'command')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'achieved outcome requires evaluator evidence',
      path: ['evidence'],
    });
  }
});
export type AgentOutcome = z.infer<typeof agentOutcomeSchema>;

export const capabilityLoopPhaseSchema = z.enum([
  'attempt_running',
  'evaluating',
  'feedback_ready',
  'achieved',
  'blocked',
  'exhausted',
]);
export type CapabilityLoopPhase = z.infer<typeof capabilityLoopPhaseSchema>;

/** Server→Web 的可恢复 Capability Loop 投影；跨包字段只在 protocol 定义。 */
export const capabilityLoopStateSchema = z.object({
  kind: z.literal('capability_loop'),
  phase: capabilityLoopPhaseSchema,
  contract: taskContractSchema,
  attempts: z.array(agentAttemptSchema).min(1),
  outcome: agentOutcomeSchema.optional(),
  queuedTaskId: z.string().optional(),
  execution: z.enum(['queued', 'running']).optional(),
  contextPack: contextPackSchema.optional(),
  pendingFeedback: z.string().trim().min(1).optional(),
}).strict();
export type CapabilityLoopState = z.infer<typeof capabilityLoopStateSchema>;

export const capabilityAttemptEventPayloadSchema = z.object({
  nodeId: z.string().min(1),
  attempt: z.number().int().positive(),
  status: z.enum(['queued', 'running', 'evaluating']),
  respawned: z.boolean().optional(),
}).strict();
export type CapabilityAttemptEventPayload = z.infer<typeof capabilityAttemptEventPayloadSchema>;

export const capabilityEvaluationEventPayloadSchema = evaluationResultSchema.safeExtend({
  nodeId: z.string().min(1),
  attempt: z.number().int().positive(),
});
export type CapabilityEvaluationEventPayload = z.infer<typeof capabilityEvaluationEventPayloadSchema>;

export const capabilityEvidenceEventPayloadSchema = z.object({
  nodeId: z.string().min(1),
  attempt: z.number().int().positive(),
  evidence: evidenceSchema,
}).strict();
export type CapabilityEvidenceEventPayload = z.infer<typeof capabilityEvidenceEventPayloadSchema>;

export const capabilityContextPackEventPayloadSchema = contextPackSchema.safeExtend({
  nodeId: z.string().min(1),
});
export type CapabilityContextPackEventPayload = z.infer<typeof capabilityContextPackEventPayloadSchema>;

export const capabilityOutcomeEventPayloadSchema = agentOutcomeSchema.safeExtend({
  nodeId: z.string().min(1),
});
export type CapabilityOutcomeEventPayload = z.infer<typeof capabilityOutcomeEventPayloadSchema>;
