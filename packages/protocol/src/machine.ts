import * as z from 'zod';

export const machineInfoSchema = z.object({
  /** 稳定标识，默认 hostname，可用 MACHINE_ID 环境变量覆盖 */
  id: z.string().min(1),
  name: z.string().min(1),
  /** 调度选择器用标签，如 ["npu", "910b"] */
  labels: z.array(z.string()).default([]),
  arch: z.string().optional(),
  npu: z
    .object({
      type: z.string(),
      count: z.number().int().nonnegative(),
    })
    .optional(),
  runnerVersion: z.string().optional(),
  /** 该机器上 code-server 的访问地址（网页"在编辑器打开"深链用） */
  codeServerUrl: z.string().optional(),
  startedAt: z.number(),
});
export type MachineInfo = z.infer<typeof machineInfoSchema>;

export const machineStatusSchema = z.enum(['online', 'offline']);
export type MachineStatus = z.infer<typeof machineStatusSchema>;
