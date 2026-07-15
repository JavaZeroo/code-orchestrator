import * as z from 'zod';

/** 支持的 agent CLI 执行器（与模型解耦：模型经 env 端点注入，见 rpc session.spawn） */
export const sessionAgentSchema = z.enum(['claude', 'codex', 'opencode']);
export type SessionAgent = z.infer<typeof sessionAgentSchema>;

export const agentBackendCapabilitiesSchema = z.object({
  hostSession: z.boolean(),
  containerSession: z.boolean(),
  resume: z.boolean(),
  fork: z.boolean(),
  interrupt: z.boolean(),
  designerTools: z.boolean(),
  taskIntakeTools: z.boolean(),
}).strict();
export type AgentBackendCapabilities = z.infer<typeof agentBackendCapabilitiesSchema>;
export type AgentBackendCapability = keyof AgentBackendCapabilities;

export const agentBackendConstraintSchema = z.object({
  allOf: z.array(z.enum([
    'hostSession',
    'containerSession',
    'resume',
    'fork',
    'interrupt',
    'designerTools',
    'taskIntakeTools',
  ])).min(2),
  reason: z.string().trim().min(1),
}).strict();
export type AgentBackendConstraint = z.infer<typeof agentBackendConstraintSchema>;

export const agentBackendDescriptorSchema = z.object({
  name: sessionAgentSchema,
  capabilities: agentBackendCapabilitiesSchema,
  constraints: z.array(agentBackendConstraintSchema).default([]),
}).strict();
export type AgentBackendDescriptor = z.infer<typeof agentBackendDescriptorSchema>;

/** 内置 Backend 的能力单一事实源；server 与 runner 只补各自的 Implementation 信息。 */
export const builtinAgentBackendDescriptors = {
  claude: agentBackendDescriptorSchema.parse({
    name: 'claude',
    capabilities: {
      hostSession: true,
      containerSession: true,
      resume: true,
      fork: true,
      interrupt: true,
      designerTools: true,
      taskIntakeTools: true,
    },
    constraints: [
      {
        allOf: ['containerSession', 'designerTools'],
        reason: 'designer tools require a host session',
      },
      {
        allOf: ['containerSession', 'taskIntakeTools'],
        reason: 'task intake tools require a host session',
      },
    ],
  }),
  codex: agentBackendDescriptorSchema.parse({
    name: 'codex',
    capabilities: {
      hostSession: true,
      containerSession: true,
      resume: true,
      fork: true,
      interrupt: true,
      designerTools: false,
      taskIntakeTools: false,
    },
    constraints: [],
  }),
} as const satisfies Record<string, AgentBackendDescriptor>;

export function supportsAgentBackendCapability(
  backend: AgentBackendDescriptor,
  capability: AgentBackendCapability,
): boolean {
  return backend.capabilities[capability];
}

export const sessionStateSchema = z.enum([
  'starting',
  'idle',
  'thinking',
  'waiting_input',
  'waiting_approval',
  'dead',
]);
export type SessionState = z.infer<typeof sessionStateSchema>;

export const SESSION_NOTE_MAX_LENGTH = 20_000;
export const sessionNoteMarkdownSchema = z.string().trim().min(1).max(SESSION_NOTE_MAX_LENGTH);
export const sessionNotePayloadSchema = z.object({
  markdown: sessionNoteMarkdownSchema,
  author: z.string().trim().min(1),
}).strict();
export type SessionNotePayload = z.infer<typeof sessionNotePayloadSchema>;
export const sessionNoteRevisionPayloadSchema = z.object({
  noteId: z.number().int().positive(),
  markdown: sessionNoteMarkdownSchema,
}).strict();
export type SessionNoteRevisionPayload = z.infer<typeof sessionNoteRevisionPayloadSchema>;
export const sessionNoteDeletionPayloadSchema = z.object({
  noteId: z.number().int().positive(),
}).strict();
export type SessionNoteDeletionPayload = z.infer<typeof sessionNoteDeletionPayloadSchema>;
