-- 机器调度暂停态：只阻止新任务放置，不改变在线态或存量会话。additive only。
ALTER TABLE "machines" ADD COLUMN IF NOT EXISTS "scheduling_paused" boolean NOT NULL DEFAULT false;
