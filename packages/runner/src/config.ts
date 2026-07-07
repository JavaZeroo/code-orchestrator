import * as os from 'node:os';
import * as z from 'zod';

const envSchema = z.object({
  SERVER_URL: z.string().default('ws://127.0.0.1:8080/ws/runner'),
  RUNNER_SHARED_TOKEN: z.string().default('dev-runner-token'),
  MACHINE_ID: z.string().optional(),
  MACHINE_NAME: z.string().optional(),
  /** 逗号分隔，如 "npu,910b" */
  MACHINE_LABELS: z.string().default(''),
  /** 本机 code-server 地址（如 http://<host>:7621），注册进机器信息 */
  CODE_SERVER_URL: z.string().optional(),
  /** 本机数据盘根（design-v2 Q6）：co 在 <DATA_ROOT>/co/ 下铺物化目录，如 /data1 */
  DATA_ROOT: z.string().optional(),
  /** 加速器种类（design-v2 Q4，v1 静态声明），如 ascend-npu；空=无加速器机器 */
  ACCEL_KIND: z.string().optional(),
  /** 加速器张数（配合 ACCEL_KIND）：生成 resources=[{kind,index:0..count-1}]，M2 换真 detect */
  ACCEL_COUNT: z.coerce.number().int().nonnegative().default(0),
  /** 显式卡号（逗号分隔，如 "6,7"）；设了就覆盖 ACCEL_COUNT——共享机上只声明空闲卡 */
  ACCEL_INDICES: z.string().optional(),
});

const raw = envSchema.parse(process.env);

/** v1 静态加速器清单：优先 ACCEL_INDICES（显式空闲卡），否则 ACCEL_COUNT（0..count-1）；M2 换真 detect */
const accelIndices = raw.ACCEL_KIND
  ? raw.ACCEL_INDICES
    ? raw.ACCEL_INDICES.split(',').map((s) => Number.parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n))
    : Array.from({ length: raw.ACCEL_COUNT }, (_, i) => i)
  : [];
const resources = raw.ACCEL_KIND ? accelIndices.map((index) => ({ kind: raw.ACCEL_KIND!, index })) : [];

export const config = {
  serverUrl: raw.SERVER_URL,
  token: raw.RUNNER_SHARED_TOKEN,
  machineId: raw.MACHINE_ID ?? os.hostname(),
  machineName: raw.MACHINE_NAME ?? os.hostname(),
  labels: raw.MACHINE_LABELS.split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  codeServerUrl: raw.CODE_SERVER_URL,
  dataRoot: raw.DATA_ROOT,
  resources,
};
