import * as os from 'node:os';
import * as z from 'zod';

const envSchema = z.object({
  SERVER_URL: z.string().default('ws://127.0.0.1:8080/ws/runner'),
  RUNNER_SHARED_TOKEN: z.string().default('dev-runner-token'),
  MACHINE_ID: z.string().optional(),
  MACHINE_NAME: z.string().optional(),
  /** 逗号分隔，如 "npu,910b" */
  MACHINE_LABELS: z.string().default(''),
  /** 本机 code-server 地址（如 http://192.168.9.186:7621），注册进机器信息 */
  CODE_SERVER_URL: z.string().optional(),
});

const raw = envSchema.parse(process.env);

export const config = {
  serverUrl: raw.SERVER_URL,
  token: raw.RUNNER_SHARED_TOKEN,
  machineId: raw.MACHINE_ID ?? os.hostname(),
  machineName: raw.MACHINE_NAME ?? os.hostname(),
  labels: raw.MACHINE_LABELS.split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  codeServerUrl: raw.CODE_SERVER_URL,
};
