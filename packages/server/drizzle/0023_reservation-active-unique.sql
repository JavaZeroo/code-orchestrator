-- 资源预留 TOCTOU 兜底（design-v2 Q4 一机一任务）：同一台机器同时至多一个 active 预留。
-- 部分唯一索引把并发事务的"先查后插"竞态收敛为唯一冲突，由 scheduler 的 ON CONFLICT DO NOTHING 转为入队。additive only。
CREATE UNIQUE INDEX IF NOT EXISTS "reservations_active_machine_uidx"
  ON "resource_reservations" ("machine_id")
  WHERE "status" = 'active';
