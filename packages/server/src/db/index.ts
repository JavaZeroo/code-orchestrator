import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '../env';
import * as schema from './schema';

function create(url: string) {
  const client = postgres(url);
  return drizzle(client, { schema });
}

let _db: ReturnType<typeof create> | null = null;

/** 懒连接：骨架阶段允许无 DB 启动（事件持久化见任务「准备 Postgres 实例」） */
export function getDb() {
  if (!_db) {
    if (!env.DATABASE_URL) {
      throw new Error('DATABASE_URL 未配置，无法访问数据库');
    }
    _db = create(env.DATABASE_URL);
  }
  return _db;
}

export function hasDb(): boolean {
  return Boolean(env.DATABASE_URL);
}

export type Db = ReturnType<typeof getDb>;
export * as schema from './schema';
