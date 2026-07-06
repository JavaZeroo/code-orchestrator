/**
 * Vendored from slopus/happy @ d2ef88deffa337546f0c477f28385d470188cb38
 * (packages/happy-wire/src/messageMeta.ts, MIT — see LICENSE.happy)
 */

import * as z from 'zod';

export const MessageMetaSchema = z.object({
  sentFrom: z.string().optional(),
  permissionMode: z.enum(['default', 'acceptEdits', 'bypassPermissions', 'plan', 'read-only', 'safe-yolo', 'yolo']).optional(),
  model: z.string().nullable().optional(),
  fallbackModel: z.string().nullable().optional(),
  customSystemPrompt: z.string().nullable().optional(),
  appendSystemPrompt: z.string().nullable().optional(),
  allowedTools: z.array(z.string()).nullable().optional(),
  disallowedTools: z.array(z.string()).nullable().optional(),
  /** 推理强度（Claude 模型；不支持的模型 SDK 会静默降级） */
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).nullable().optional(),
  displayText: z.string().optional(),
});
export type MessageMeta = z.infer<typeof MessageMetaSchema>;
