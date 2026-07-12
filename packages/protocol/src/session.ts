import * as z from 'zod';

/** 支持的 agent CLI 执行器（与模型解耦：模型经 env 端点注入，见 rpc session.spawn） */
export const sessionAgentSchema = z.enum(['claude', 'codex', 'opencode']);
export type SessionAgent = z.infer<typeof sessionAgentSchema>;

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
