/**
 * 通知中心 → 跨项目待办聚合流。
 *
 * 从共享 react-query 缓存（useSessions/useRuns/useProjects）派生「等我处理」列表，
 * 不再独立订阅 WS。徽章数 = 跨项目 waiting 线程总数。
 *
 * 面板按项目分组列出待办项，点击 → 自动切项目 + 选中该线程。
 * 保留点击面板外/Esc 关闭。
 *
 * 已移除：WS 累积、localStorage 已读游标、信息型通知（run.finished/nudge 等）。
 * 若需信息型「活动流」，后续可另做。
 */

import { Bell, FolderGit2 } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import type { AttentionItem } from './lib/attention';
import { crossProjectWaiting } from './lib/attention';
import { useProjects, useRuns, useSessions } from './lib/queries';

export function NotificationBell({
  onJump,
}: {
  /** 跳转到指定线程：切项目 + 选中 */
  onJump: (item: AttentionItem) => void;
}) {
  const { data: allSessions = [] } = useSessions();
  const { data: allRuns = [] } = useRuns();
  const { data: projects = [] } = useProjects();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const items = useMemo(
    () => crossProjectWaiting(allSessions, allRuns, projects),
    [allSessions, allRuns, projects],
  );

  const unread = items.length;

  // 按 project 分组
  const grouped = useMemo(() => {
    const map = new Map<string, AttentionItem[]>();
    for (const item of items) {
      const arr = map.get(item.projectId) ?? [];
      arr.push(item);
      map.set(item.projectId, arr);
    }
    return [...map.entries()];
  }, [items]);

  // 点击面板外或 Esc 关闭
  const close = () => setOpen(false);
  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    setOpen((v) => !v);
  };

  return (
    <div ref={rootRef} className="relative" onClick={(e) => e.stopPropagation()}>
      <button
        className="relative inline-flex items-center justify-center rounded-md p-2 text-dim transition-colors hover:bg-panel-2 hover:text-ink-2"
        title="待办"
        onClick={toggle}
      >
        <Bell size={15} />
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] leading-none font-semibold text-white">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      {open && (
        <>
          {/* 背景遮罩 */}
          <div className="fixed inset-0 z-40" onClick={close} />
          <div className="surface absolute top-full right-0 z-50 mt-2 w-80 overflow-hidden shadow-[var(--shadow-pop)]">
            <div className="flex items-center justify-between border-b border-line bg-bg-2/40 px-3 py-2">
              <span className="font-display text-[13px] font-semibold text-ink">等我处理</span>
            </div>
            <div className="max-h-96 overflow-y-auto">
              {grouped.length === 0 && (
                <p className="p-4 text-center text-sm text-dim">暂无待办 ✓</p>
              )}
              {grouped.map(([pid, group]) => (
                <div key={pid}>
                  <div className="flex items-center gap-1.5 border-b border-line/40 bg-bg-2/20 px-3 py-1.5">
                    <FolderGit2 size={11} className="text-faint" />
                    <span className="text-[11px] font-medium text-dim">{group[0]!.projectName}</span>
                  </div>
                  {group.map((item) => (
                    <button
                      key={`${item.kind}:${item.id}`}
                      className="flex w-full items-center gap-2.5 border-b border-line/60 px-3 py-2.5 text-left transition-colors last:border-b-0 hover:bg-panel-2"
                      onClick={() => { onJump(item); close(); }}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-ink-2">{item.title}</span>
                        <span className="block truncate text-xs text-dim">{item.subtitle}</span>
                      </span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
