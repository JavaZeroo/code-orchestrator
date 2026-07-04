import * as z from 'zod';

/** tool = 会话内工具调用审批（canUseTool 挂起）；gate = 工作流 human gate */
export const approvalKindSchema = z.enum(['tool', 'gate']);
export type ApprovalKind = z.infer<typeof approvalKindSchema>;

/** 决议形状对齐 Claude Agent SDK 的 canUseTool 返回值，便于驱动层直接透传 */
export const approvalDecisionSchema = z.discriminatedUnion('behavior', [
  z.object({
    behavior: z.literal('allow'),
    updatedInput: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    behavior: z.literal('deny'),
    message: z.string().optional(),
  }),
]);
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;

export const approvalStatusSchema = z.enum(['pending', 'approved', 'denied', 'expired']);
export type ApprovalStatus = z.infer<typeof approvalStatusSchema>;

export const approvalRequestSchema = z.object({
  id: z.string(),
  kind: approvalKindSchema,
  sessionId: z.string().optional(),
  runId: z.string().optional(),
  nodeId: z.string().optional(),
  title: z.string(),
  /** tool: { toolName, input, description? }；gate: 由工作流节点定义 */
  payload: z.record(z.string(), z.unknown()),
  risk: z.enum(['low', 'medium', 'high']).optional(),
  requestedAt: z.number(),
});
export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;
