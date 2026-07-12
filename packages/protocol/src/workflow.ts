/**
 * 工作流定义 schema —— 三方契约：meta-agent 的 emit_workflow 按此产出、
 * React Flow 按此渲染、引擎按此执行（设计文档 §7）。
 */

import * as z from 'zod';
import { sessionAgentSchema } from './session';

export const RUN_NOTE_MAX_LENGTH = 20_000;
export const runNoteMarkdownSchema = z.string().trim().min(1).max(RUN_NOTE_MAX_LENGTH);
export const runNotePayloadSchema = z.object({
  markdown: runNoteMarkdownSchema,
  author: z.string().trim().min(1),
}).strict();
export type RunNotePayload = z.infer<typeof runNotePayloadSchema>;
export const runNoteRevisionPayloadSchema = z.object({
  noteId: z.number().int().positive(),
  markdown: runNoteMarkdownSchema,
}).strict();
export type RunNoteRevisionPayload = z.infer<typeof runNoteRevisionPayloadSchema>;

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
  /** 推理强度（Claude 模型有效，如评审节点用 high 提高严谨度）。 */
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  /** 评审→返工闭环：本节点（评审）判定「需改进」时，把意见回灌 target 节点的会话让其修改，
   *  再重跑本节点，最多 maxRounds 轮；达标（LGTM）或轮次耗尽才继续下游。 */
  reviseLoop: z
    .object({ target: z.string().min(1), maxRounds: z.number().int().positive().default(2) })
    .optional(),
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

/** command-critic 节点：在 run 的 worktree 里跑一条命令，exit 0 = pass。
 *  产出结构化裁决 {pass, detail}；配 reviseLoop 则失败时回灌 target 返工、重跑本 check，
 *  ≤maxRounds 轮 —— 这就是 TDD 红绿内环 / typecheck 门 的机制。 */
export const checkNodeSchema = nodeBase.extend({
  type: z.literal('check'),
  critic: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('command'),
      /** 在 {{vars.cwd}} 下执行的命令，支持 {{vars.x}}/{{outputs.节点}} 模板 */
      run: z.string().min(1),
      timeoutMs: z.number().int().positive().default(300_000),
    }),
  ]),
  reviseLoop: z.object({ target: z.string().min(1), maxRounds: z.number().int().positive().default(2) }).optional(),
});
export type CheckNode = z.infer<typeof checkNodeSchema>;

export const workflowNodeSchema = z.discriminatedUnion('type', [
  agentNodeSchema,
  gateNodeSchema,
  meetingNodeSchema,
  fanoutNodeSchema,
  conditionNodeSchema,
  checkNodeSchema,
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
