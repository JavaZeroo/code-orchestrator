/**
 * SSH 运维通道（design-machines-env A 期，决议①②）：
 * 职责限定为低频运维——公钥安装、连通测试、runner 重启/引导；执行面仍走 runner WS。
 * 凭据模型：实例级 ed25519 密钥对（私钥 AES-256-GCM 落库）；密码只做首连引导，用完即弃不落库。
 */

import ssh2 from 'ssh2';
const { Client, utils: sshUtils } = ssh2;
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index';
import { decryptSecret, encryptSecret } from './crypto';

const KEY_ID = 'ssh-instance-key';

export interface SshTarget {
  host: string;
  port: number;
  user: string;
}

async function generateAndStore(): Promise<{ privatePem: string; publicSsh: string }> {
  // ssh2 自带 keygen：直接产 OpenSSH 格式（node:crypto 的 PKCS8 ed25519 ssh2 不认）
  const pair = sshUtils.generateKeyPairSync('ed25519', { comment: 'co-orchestrator' });
  const priv = pair.private;
  const pub = pair.public;
  await getDb()
    .insert(schema.instanceSecrets)
    .values({ key: KEY_ID, valueEnc: encryptSecret(priv), publicValue: pub })
    .onConflictDoUpdate({ target: schema.instanceSecrets.key, set: { valueEnc: encryptSecret(priv), publicValue: pub, createdAt: new Date() } });
  return { privatePem: priv, publicSsh: pub };
}

/** 取实例密钥对（无则生成）。返回私钥 PEM 与 authorized_keys 格式公钥。 */
export async function getInstanceKey(): Promise<{ privatePem: string; publicSsh: string }> {
  const rows = await getDb().select().from(schema.instanceSecrets).where(eq(schema.instanceSecrets.key, KEY_ID)).limit(1);
  if (rows[0]?.publicValue) {
    return { privatePem: decryptSecret(rows[0].valueEnc), publicSsh: rows[0].publicValue };
  }
  return generateAndStore();
}

/** 轮换：生成新对并覆盖（旧公钥需逐机重装——由调用方/UI 提示） */
export async function rotateInstanceKey(): Promise<{ publicSsh: string }> {
  const { publicSsh } = await generateAndStore();
  return { publicSsh };
}

/** SSH 执行一条命令。auth：给 password 用密码，否则用实例私钥。 */
export function sshExec(
  target: SshTarget,
  cmd: string,
  auth: { password?: string; privatePem?: string },
  timeoutMs = 30_000,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const timer = setTimeout(() => {
      conn.end();
      reject(new Error(`ssh 超时（${timeoutMs}ms）`));
    }, timeoutMs);
    conn
      .on('ready', () => {
        conn.exec(cmd, (err, stream) => {
          if (err) {
            clearTimeout(timer);
            conn.end();
            return reject(err);
          }
          let stdout = '';
          let stderr = '';
          stream
            .on('data', (d: Buffer) => { stdout += d.toString(); })
            .stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
          stream.on('close', (code: number | null) => {
            clearTimeout(timer);
            conn.end();
            resolve({ exitCode: code ?? 1, stdout: stdout.slice(-4000), stderr: stderr.slice(-4000) });
          });
        });
      })
      .on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      })
      .connect({
        host: target.host,
        port: target.port,
        username: target.user,
        readyTimeout: Math.min(timeoutMs, 15_000),
        ...(auth.password ? { password: auth.password } : { privateKey: auth.privatePem }),
      });
  });
}

/** 用密码首连并安装实例公钥（幂等 append）；密码用完即弃。 */
export async function installInstanceKey(target: SshTarget, password: string): Promise<void> {
  const { publicSsh } = await getInstanceKey();
  const cmd = `mkdir -p ~/.ssh && chmod 700 ~/.ssh && grep -qF "${publicSsh}" ~/.ssh/authorized_keys 2>/dev/null || echo "${publicSsh}" >> ~/.ssh/authorized_keys; chmod 600 ~/.ssh/authorized_keys`;
  const res = await sshExec(target, cmd, { password });
  if (res.exitCode !== 0) {
    throw new Error(`公钥安装失败: ${res.stderr || res.stdout}`);
  }
}
