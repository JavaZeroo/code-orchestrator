/**
 * 工作流定义 schema —— 三方契约：meta-agent 的 emit_workflow 按此产出、
 * React Flow 按此渲染、引擎按此执行（设计文档 §7）。
 */

import * as z from 'zod';
import { sessionAgentSchema } from './session';

const nodeBase = z.object({
  id: z.string().min(1),
  title: z.string().optional(),
});

export const agentNodeSchema = nodeBase.extend({
  type: z.literal('agent'),
  /** 角色 id（SE / PL / dev…），决定 system prompt、工具白名单与默认模型 */
  role: z.string().optional(),
  cli: sessionAgentSchema.default('claude'),
  /** 模型端点别名：claude | deepseek | glm …（server 侧解析为 env 注入） */
  model: z.string().optional(),
  machine: z
    .object({
      id: z.string().optional(),
      labels: z.array(z.string()).optional(),
    })
    .optional(),
  /** 工作目录（可含模板），缺省用运行时 vars.cwd */
  cwd: z.string().optional(),
  /** 任务描述，支持 {{vars.x}} 与 {{outputs.节点id}} 模板 */
  prompt: z.string().min(1),
  /** 权限模式：默认每个工具调用挂人工审批；bypassPermissions/acceptEdits 用于自主执行节点
   *  （如自我开发：agent 需自主跑 git/gh 提 PR，不能每条命令都等审批）。 */
  permissionMode: z.enum(['default', 'acceptEdits', 'bypassPermissions', 'plan']).optional(),
  /** 预期产物路径，供下游节点与 UI 展示 */
  outputs: z.array(z.string()).optional(),
});
export type AgentNode = z.infer<typeof agentNodeSchema>;

export const gateNodeSchema = nodeBase.extend({
  type: z.literal('gate'),
  approvers: z.array(z.string()).default([]),
  timeoutMs: z.number().int().positive().optional(),
  onTimeout: z.enum(['notify', 'fail', 'skip']).default('notify'),
});
export type GateNode = z.infer<typeof gateNodeSchema>;

export const meetingNodeSchema = nodeBase.extend({
  type: z.literal('meeting'),
  participants: z
    .array(
      z.object({
        model: z.string(),
        cli: sessionAgentSchema.default('claude'),
        role: z.string().optional(),
      }),
    )
    .min(2),
  /** 独立评审后允许的交叉反驳轮数 */
  rounds: z.number().int().min(1).default(1),
  /** 仲裁：指定模型 / 规则投票 / 升级给人 */
  arbiter: z.union([z.object({ model: z.string() }), z.enum(['vote', 'human'])]).default('human'),
  subject: z.string().optional(),
});
export type MeetingNode = z.infer<typeof meetingNodeSchema>;

export const fanoutNodeSchema = nodeBase.extend({
  type: z.literal('fanout'),
  /** 上游节点输出中的数组来源，如 "split.items" */
  itemsFrom: z.string().min(1),
  template: agentNodeSchema.omit({ id: true, type: true }),
});
export type FanoutNode = z.infer<typeof fanoutNodeSchema>;

export const conditionNodeSchema = nodeBase.extend({
  type: z.literal('condition'),
  /** 求值语义 M2 定义；先占位保 schema 稳定 */
  expr: z.string().min(1),
});
export type ConditionNode = z.infer<typeof conditionNodeSchema>;

export const workflowNodeSchema = z.discriminatedUnion('type', [
  agentNodeSchema,
  gateNodeSchema,
  meetingNodeSchema,
  fanoutNodeSchema,
  conditionNodeSchema,
]);
export type WorkflowNode = z.infer<typeof workflowNodeSchema>;

export const workflowEdgeSchema = z.tuple([z.string(), z.string()]);
export type WorkflowEdge = z.infer<typeof workflowEdgeSchema>;

export const workflowDefSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    /** 模板变量默认值，运行时可覆盖（如 issue_url） */
    vars: z.record(z.string(), z.string()).optional(),
    nodes: z.array(workflowNodeSchema).min(1),
    edges: z.array(workflowEdgeSchema).default([]),
  })
  .superRefine((def, ctx) => {
    const ids = new Set<string>();
    for (const node of def.nodes) {
      if (ids.has(node.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate node id: ${node.id}`,
          path: ['nodes'],
        });
      }
      ids.add(node.id);
    }
    def.edges.forEach(([from, to], i) => {
      if (!ids.has(from) || !ids.has(to)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `edge references unknown node: ${from} -> ${to}`,
          path: ['edges', i],
        });
      }
    });
  });
export type WorkflowDef = z.infer<typeof workflowDefSchema>;
