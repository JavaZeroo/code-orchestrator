import * as z from 'zod';

/** 单个加速器设备（design-v2 Q4）：kind 可扩展（ascend-npu / nvidia-gpu…），index 为本机序号 */
export const acceleratorSchema = z.object({
  kind: z.string(),
  index: z.number().int().nonnegative(),
  model: z.string().optional(),
});
export type Accelerator = z.infer<typeof acceleratorSchema>;

export const machineInfoSchema = z.object({
  /** 稳定标识，默认 hostname，可用 MACHINE_ID 环境变量覆盖 */
  id: z.string().min(1),
  name: z.string().min(1),
  /** 调度选择器用标签，如 ["npu", "910b"] */
  labels: z.array(z.string()).default([]),
  arch: z.string().optional(),
  /** 该机数据盘根（design-v2 Q6）：co 在 <dataRoot>/co/ 下铺物化目录。DATA_ROOT 环境变量设定 */
  dataRoot: z.string().optional(),
  /** 加速器清单（design-v2 Q4）：v1 由 ACCEL_KIND/ACCEL_COUNT 静态声明，M2 换 npu-smi detect */
  resources: z.array(acceleratorSchema).default([]),
  runnerVersion: z.string().optional(),
  /** 该机器上 code-server 的访问地址（网页"在编辑器打开"深链用） */
  codeServerUrl: z.string().optional(),
  startedAt: z.number(),
});
export type MachineInfo = z.infer<typeof machineInfoSchema>;

export const machineStatusSchema = z.enum(['online', 'offline']);
export type MachineStatus = z.infer<typeof machineStatusSchema>;
