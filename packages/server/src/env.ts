import * as z from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().int().default(8080),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().optional(),
  RUNNER_SHARED_TOKEN: z.string().default('dev-runner-token'),
  /** better-auth 会话签名 + token 加密密钥派生源 */
  AUTH_SECRET: z.string().optional(),
  /** 浏览器访问的对外地址（better-auth baseURL 与受信 origin） */
  PUBLIC_URL: z.string().default('http://localhost:7620'),
});

export const env = envSchema.parse(process.env);
