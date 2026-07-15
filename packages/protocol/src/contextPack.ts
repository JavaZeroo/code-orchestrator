import * as z from 'zod';

export const repositoryInstructionRefSchema = z.object({
  path: z.string().min(1),
  sha256: z.string().min(1),
  size: z.number().int().nonnegative(),
}).strict();
export type RepositoryInstructionRef = z.infer<typeof repositoryInstructionRefSchema>;

export const repositoryCheckpointSchema = z.object({
  gitHead: z.string().trim().min(1).optional(),
  dirty: z.boolean(),
}).strict();
export type RepositoryCheckpoint = z.infer<typeof repositoryCheckpointSchema>;

export const contextPackSchema = z.object({
  version: z.literal(1),
  createdAt: z.string().datetime(),
  task: z.object({
    objective: z.string().optional(),
    acceptanceCriteria: z.array(z.object({ id: z.string(), description: z.string() }).strict()),
    constraints: z.array(z.string()),
  }).strict(),
  attempt: z.object({
    number: z.number().int().positive(),
    maxAttempts: z.number().int().positive(),
  }).strict(),
  repository: z.object({
    cwd: z.string().min(1),
    instructions: z.array(repositoryInstructionRefSchema),
    checkpoint: repositoryCheckpointSchema,
  }).strict(),
  priorAttempts: z.array(z.object({
    number: z.number().int().positive(),
    status: z.string(),
    summary: z.string().optional(),
    findings: z.array(z.object({
      criterionId: z.string(),
      status: z.string(),
      detail: z.string(),
    }).strict()),
  }).strict()),
}).strict();
export type ContextPack = z.infer<typeof contextPackSchema>;
