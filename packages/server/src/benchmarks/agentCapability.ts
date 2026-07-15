import * as z from 'zod';
import { agentOutcomeSchema, sessionAgentSchema, taskContractSchema } from '@co/protocol';

export const agentCapabilityCaseSchema = z.object({
  version: z.literal(1).default(1),
  id: z.string().trim().min(1).regex(/^[a-z0-9][a-z0-9-]*$/),
  title: z.string().trim().min(1),
  category: z.enum(['bugfix', 'feature', 'refactor', 'ui', 'ci', 'recovery', 'clarification']),
  repository: z.object({
    path: z.string().trim().min(1),
    baseRef: z.string().trim().min(1),
  }).strict(),
  prompt: z.string().trim().min(1),
  contract: taskContractSchema,
  expectations: z.object({
    status: z.enum(['achieved', 'blocked', 'exhausted']).default('achieved'),
    maxAttempts: z.number().int().positive().optional(),
    maxHumanInterventions: z.number().int().nonnegative().optional(),
  }).strict(),
  tags: z.array(z.string().trim().min(1)).default([]),
}).strict();
export type AgentCapabilityCase = z.infer<typeof agentCapabilityCaseSchema>;

export const agentCapabilityObservationSchema = z.object({
  caseId: z.string().trim().min(1),
  harnessVersion: z.string().trim().min(1),
  backend: sessionAgentSchema,
  model: z.string().trim().min(1).optional(),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime(),
  humanInterventions: z.number().int().nonnegative().default(0),
  outcome: agentOutcomeSchema,
}).strict();
export type AgentCapabilityObservation = z.infer<typeof agentCapabilityObservationSchema>;

export interface AgentCapabilityMetrics {
  total: number;
  achieved: number;
  solveRate: number;
  firstPassRate: number;
  averageAttempts: number;
  humanInterventions: number;
  averageDurationMs: number;
  totalCostUsd: number;
}

export interface AgentCapabilityAssessment {
  pass: boolean;
  reasons: string[];
}

export function assessAgentCapabilityObservation(
  rawCase: AgentCapabilityCase,
  rawObservation: AgentCapabilityObservation,
): AgentCapabilityAssessment {
  const benchmarkCase = agentCapabilityCaseSchema.parse(rawCase);
  const observation = agentCapabilityObservationSchema.parse(rawObservation);
  const reasons: string[] = [];
  if (observation.caseId !== benchmarkCase.id) {
    reasons.push(`case id mismatch: expected ${benchmarkCase.id}, got ${observation.caseId}`);
  }
  if (observation.outcome.status !== benchmarkCase.expectations.status) {
    reasons.push(`outcome: expected ${benchmarkCase.expectations.status}, got ${observation.outcome.status}`);
  }
  const maxAttempts = benchmarkCase.expectations.maxAttempts;
  if (maxAttempts !== undefined && observation.outcome.attempts.length > maxAttempts) {
    reasons.push(`attempts: expected <= ${maxAttempts}, got ${observation.outcome.attempts.length}`);
  }
  const maxHumanInterventions = benchmarkCase.expectations.maxHumanInterventions;
  if (maxHumanInterventions !== undefined && observation.humanInterventions > maxHumanInterventions) {
    reasons.push(`human interventions: expected <= ${maxHumanInterventions}, got ${observation.humanInterventions}`);
  }
  return { pass: reasons.length === 0, reasons };
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

export function summarizeAgentCapabilityBenchmark(
  rawObservations: AgentCapabilityObservation[],
): AgentCapabilityMetrics {
  const observations = rawObservations.map((observation) => agentCapabilityObservationSchema.parse(observation));
  const total = observations.length;
  const achieved = observations.filter((observation) => observation.outcome.status === 'achieved').length;
  const firstPass = observations.filter((observation) =>
    observation.outcome.status === 'achieved' && observation.outcome.attempts.length === 1).length;
  const attemptCount = observations.reduce((sum, observation) => sum + observation.outcome.attempts.length, 0);
  const humanInterventions = observations.reduce((sum, observation) => sum + observation.humanInterventions, 0);
  const durationMs = observations.reduce((sum, observation) =>
    sum + Math.max(0, new Date(observation.endedAt).getTime() - new Date(observation.startedAt).getTime()), 0);
  const totalCostUsd = observations.reduce((totalCost, observation) =>
    totalCost + observation.outcome.evidence.reduce((outcomeCost, evidence) =>
      outcomeCost + (evidence.kind === 'usage' ? evidence.costUsd ?? 0 : 0), 0), 0);
  return {
    total,
    achieved,
    solveRate: ratio(achieved, total),
    firstPassRate: ratio(firstPass, total),
    averageAttempts: ratio(attemptCount, total),
    humanInterventions,
    averageDurationMs: ratio(durationMs, total),
    totalCostUsd,
  };
}

export function summarizeAgentCapabilityBenchmarkByVersion(
  rawObservations: AgentCapabilityObservation[],
): Record<string, AgentCapabilityMetrics> {
  const observations = rawObservations.map((observation) => agentCapabilityObservationSchema.parse(observation));
  const versions = [...new Set(observations.map((observation) => observation.harnessVersion))].sort();
  return Object.fromEntries(versions.map((version) => [
    version,
    summarizeAgentCapabilityBenchmark(observations.filter((observation) => observation.harnessVersion === version)),
  ]));
}
