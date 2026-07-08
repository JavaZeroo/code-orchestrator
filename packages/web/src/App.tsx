import { FolderGit2, type LucideIcon, LogOut, MessageSquareText, Settings } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { authApi, LoginPage, SettingsModal, useMe, type Me } from './Auth';
import { NewSession } from './NewSession';
import { TaskIntake } from './NewTask';
import { NotificationBell } from './Notifications';
import { ProjectsPage } from './ProjectsPage';
import { RunView } from './RunView';
import { SessionView } from './SessionView';
import { Button } from './components/ui/button';
import { Spinner, StatusDot } from './components/ui/primitives';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './components/ui/select';
import { isWaitingRun, isWaitingSession, waitingCountByProject, type AttentionItem } from './lib/attention';
import { useProjects, useRuns, useSessions } from './lib/queries';
import { ProjectProvider, useCurrentProject, useProjectScope } from './lib/project';
import { cn, relTime, fmtCost, shortModel } from './lib/utils';

type Tab = 'home' | 'projects';

type Selected = 'new' | 'newTask' | { session: string } | { run: string };

const NAV: { id: Tab; label: string; icon: LucideIcon; hint: string }[] = [
  { id: 'home', label: '对话', icon: MessageSquareText, hint: '线程 · 会话 · 运行' },
  { id: 'projects', label: '项目', icon: FolderGit2, hint: '策略容器 · 自治开关' },
];

const STATE_DOT: Record<string, string> = {
  idle: 'ok',
  thinking: 'run',
  starting: 'run',
  waiting_approval: 'human',
  waiting_input: 'human',
  dead: 'neutral',
};

const RUN_TONE: Record<string, string> = {
  running: 'run',
  waiting_human: 'human',
  done: 'ok',
  failed: 'danger',
  cancelled: 'neutral',
};
const RUN_LABEL: Record<string, string> = { running: '运行中', waiting_human: '待处理', done: '完成', failed: '失败', cancelled: '取消' };

function BrandMark() {
  return (
    <svg viewBox="0 0 32 32" className="size-8 shrink-0" fill="none" aria-hidden>
      <rect x="1" y="1" width="30" height="30" rx="9" fill="var(--color-accent)" opacity="0.14" />
      <rect x="1.5" y="1.5" width="29" height="29" rx="8.5" stroke="var(--color-accent)" strokeOpacity="0.5" />
      <circle cx="16" cy="16" r="9" stroke="var(--color-accent)" strokeWidth="1.6" strokeDasharray="3 3" opacity="0.8" />
      <circle cx="16" cy="16" r="3.2" fill="var(--color-accent)" />
      <circle cx="16" cy="7" r="1.9" fill="var(--color-accent)" />
      <circle cx="24" cy="20" r="1.6" fill="var(--color-ink)" opacity="0.55" />
      <circle cx="8" cy="20" r="1.6" fill="var(--color-ink)" opacity="0.55" />
    </svg>
  );
}

function ProjectSwitcher({ waitingCounts }: { waitingCounts: Map<string, number> }) {
  const { data: projects = [] } = useProjects();
  const { projectId, setProjectId } = useCurrentProject();
  const totalOther = useMemo(() => {
    let n = 0;
    for (const [pid, c] of waitingCounts) {
      if (pid !== projectId) n += c;
    }
    return n;
  }, [waitingCounts, projectId]);

  useEffect(() => {
    if (projects.length > 0 && (!projectId || !projects.some((p) => p.id === projectId))) {
      setProjectId(projects[0]!.id);
    }
  }, [projectId, projects, setProjectId]);

  if (projects.length === 0) return null;

  return (
    <div className="px-2.5 pb-1">
      <Select value={projectId ?? ''} onValueChange={(v) => setProjectId(v)}>
        <SelectTrigger className="w-full">
          <span className="flex min-w-0 items-center gap-2">
            <FolderGit2 size={13} className="shrink-0 text-accent" />
            <SelectValue placeholder="选择项目" />
            {totalOther > 0 && (
              <span className="ml-auto flex size-4 items-center justify-center rounded-full bg-danger text-[9px] font-semibold text-white">
                {totalOther > 9 ? '9+' : totalOther}
              </span>
            )}
          </span>
        </SelectTrigger>
        <SelectContent>
          {projects.map((p) => {
            const cnt = waitingCounts.get(p.id) ?? 0;
            return (
              <SelectItem key={p.id} value={p.id}>
                <span className="flex items-center gap-2">
                  {p.name}
                  {cnt > 0 && (
                    <span className="flex size-4 items-center justify-center rounded-full bg-danger text-[9px] font-semibold text-white">
                      {cnt > 9 ? '9+' : cnt}
                    </span>
                  )}
                </span>
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    </div>
  );
}

function Sidebar({
  tab,
  setTab,
  me,
  onSettings,
  waitingCounts,
}: {
  tab: Tab;
  setTab: (t: Tab) => void;
  me: Me;
  onSettings: () => void;
  waitingCounts: Map<string, number>;
}) {
  const bound = Object.entries(me.forges).filter(([, b]) => b.bound);
  return (
    <aside className="flex w-[15.5rem] shrink-0 flex-col border-r border-line bg-bg-2/70 backdrop-blur-sm">
      <div className="flex items-center gap-2.5 px-4 pt-4 pb-3">
        <BrandMark />
        <div className="min-w-0 leading-tight">
          <div className="truncate font-display text-[15px] font-semibold tracking-tight text-ink">orchestrator</div>
          <div className="mono-nums text-[10px] tracking-wide text-faint">AUTONOMOUS · DEV · CONSOLE</div>
        </div>
      </div>

      <ProjectSwitcher waitingCounts={waitingCounts} />

      <nav className="flex flex-1 flex-col gap-0.5 px-2.5 pt-2">
        <div className="px-2 pb-1.5 text-[10px] font-semibold tracking-widest text-faint uppercase">Console</div>
        {NAV.map((n) => {
          const active = tab === n.id;
          return (
            <button
              key={n.id}
              onClick={() => setTab(n.id)}
              title={n.hint}
              className={cn(
                'group relative flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] transition-all',
                active ? 'bg-panel-2 text-ink shadow-[var(--shadow-panel)]' : 'text-dim hover:bg-panel/60 hover:text-ink-2',
              )}
            >
              {active && <span className="absolute top-1.5 bottom-1.5 left-0 w-[2.5px] rounded-full bg-accent" />}
              <n.icon size={16} className={cn('shrink-0 transition-colors', active ? 'text-accent' : 'text-faint group-hover:text-dim')} />
              <span className="font-medium">{n.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="mx-2.5 mb-2 rounded-lg border border-line bg-panel/50 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <StatusDot tone="ok" live />
          <span className="text-[12px] font-medium text-ink-2">系统运行中</span>
        </div>
        <div className="mt-1 flex flex-wrap gap-1">
          {bound.length > 0 ? (
            bound.map(([k, b]) => (
              <span key={k} className="mono-nums rounded bg-panel-2 px-1.5 py-0.5 text-[10px] text-dim">
                {k}:{b.login}
              </span>
            ))
          ) : (
            <span className="text-[11px] text-warn">forge 未绑定</span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 border-t border-line px-3 py-2.5">
        <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-accent/15 text-[12px] font-semibold text-accent uppercase">
          {me.user.email.slice(0, 1)}
        </div>
        <span className="min-w-0 flex-1 truncate text-[12px] text-dim">{me.user.email}</span>
        <Button variant="ghost" size="icon-sm" onClick={onSettings} title="设置">
          <Settings size={15} />
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={() => void authApi.signOut().then(() => location.reload())} title="退出">
          <LogOut size={15} />
        </Button>
      </div>
    </aside>
  );
}

/* ──────── HomeScreen：线程列表 + 对话/运行视图 ──────── */

type ThreadItem =
  | { kind: 'session'; session: import('./api').SessionRow }
  | { kind: 'run'; run: import('./api').RunRow };

function threadActiveTime(t: ThreadItem): string {
  if (t.kind === 'session') return t.session.createdAt;
  return t.run.endedAt ?? t.run.startedAt;
}

function threadTitle(t: ThreadItem): string {
  if (t.kind === 'session') return t.session.title ?? (t.session.cwd.split('/').pop() || t.session.cwd);
  return t.run.defName ?? t.run.defId.slice(0, 8);
}

function threadId(t: ThreadItem): string {
  return t.kind === 'session' ? t.session.id : t.run.id;
}

function isThreadWaiting(t: ThreadItem): boolean {
  return t.kind === 'session' ? isWaitingSession(t.session) : isWaitingRun(t.run);
}

function HomeScreen({
  selected,
  setSelected,
}: {
  selected: Selected;
  setSelected: (v: Selected) => void;
}) {
  const { data: allSessions = [] } = useSessions();
  const { data: runs = [] } = useRuns();
  const { projectId, inScope } = useProjectScope();

  const runMap = useMemo(() => new Map(runs.map((r) => [r.id, r])), [runs]);

  // 按当前项目过滤
  const sessions = useMemo(
    () => allSessions.filter((s) => inScope(s.projectId ?? (s.runId ? runMap.get(s.runId)?.projectId ?? null : null))),
    [allSessions, inScope, runMap],
  );
  const scopedRuns = useMemo(() => runs.filter((r) => inScope(r.projectId)), [runs, inScope]);

  // 顶层线程：manual 会话（无 runId）+ 所有 runs（工作流子会话由所属 run 代表）
  const allThreads: ThreadItem[] = useMemo(
    () => [
      ...sessions.filter((s) => !s.runId).map((s) => ({ kind: 'session' as const, session: s })),
      ...scopedRuns.map((r) => ({ kind: 'run' as const, run: r })),
    ],
    [sessions, scopedRuns],
  );

  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'session' | 'run'>('all');
  const [showHistory, setShowHistory] = useState(false);

  const q = search.trim().toLowerCase();
  const visible = useMemo(() => allThreads.filter((t) => {
    if (filter === 'session' && t.kind !== 'session') return false;
    if (filter === 'run' && t.kind !== 'run') return false;
    if (!q) return true;
    if (t.kind === 'session') {
      const s = t.session;
      return [s.title, s.cwd, s.model, s.id].some((v) => v?.toLowerCase().includes(q));
    }
    const r = t.run;
    return [r.defName, r.defId, r.id].some((v) => v?.toLowerCase().includes(q));
  }), [allThreads, filter, q]);

  // 分区
  const waiting = useMemo(() => visible.filter(isThreadWaiting), [visible]);
  const rest = useMemo(() => visible.filter((t) => !isThreadWaiting(t)), [visible]);

  // 其余按活跃时间降序
  const sortedRest = useMemo(
    () => [...rest].sort((a, b) => new Date(threadActiveTime(b)).getTime() - new Date(threadActiveTime(a)).getTime()),
    [rest],
  );

  const active = sortedRest.filter((t) => {
    if (t.kind === 'session') return t.session.state === 'thinking' || t.session.state === 'starting';
    return t.run.status === 'running';
  });
  const idle = sortedRest.filter((t) => {
    if (t.kind === 'session') return t.session.state === 'idle';
    return t.run.status === 'done';
  });
  const history = sortedRest.filter((t) => {
    if (t.kind === 'session') return t.session.state === 'dead';
    return t.run.status === 'failed' || t.run.status === 'cancelled';
  });

  const renderSessionRow = (s: import('./api').SessionRow) => (
    <div
      key={s.id}
      className={cn('flex items-center gap-2 rounded-lg pr-1', selectedIsSession(s.id) && 'bg-panel-2 shadow-[var(--shadow-panel)]')}
    >
      <button
        className="flex min-w-0 flex-1 items-center gap-2.5 p-2 text-left transition-colors hover:bg-panel-2"
        onClick={() => setSelected({ session: s.id })}
      >
        <StatusDot tone={STATE_DOT[s.state] ?? 'neutral'} live={s.state === 'thinking' || s.state === 'starting'} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-ink-2">{s.title ?? (s.cwd.split('/').pop() || s.cwd)}</span>
          <span className="mono-nums block truncate text-[10px] text-faint" title={shortModel(s.model).full}>
            {shortModel(s.model).display} · {relTime(s.createdAt)}{s.usage ? ` · ${fmtCost(s.usage.costUsd)}` : ''}
          </span>
        </span>
      </button>
      {isWaitingSession(s) && <span className="mr-2 size-2 rounded-full bg-danger" />}
    </div>
  );

  const renderRunRow = (r: import('./api').RunRow) => (
    <div
      key={`run:${r.id}`}
      className={cn('flex items-center gap-2 rounded-lg pr-1', selectedIsRun(r.id) && 'bg-panel-2 shadow-[var(--shadow-panel)]')}
    >
      <button
        className="flex min-w-0 flex-1 items-center gap-2.5 p-2 text-left transition-colors hover:bg-panel-2"
        onClick={() => setSelected({ run: r.id })}
      >
        <StatusDot tone={RUN_TONE[r.status] ?? 'neutral'} live={r.status === 'running'} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-ink-2">{r.defName ?? r.defId.slice(0, 8)}</span>
          <span className="mono-nums block truncate text-[10px] text-faint">
            {RUN_LABEL[r.status] ?? r.status} · run {r.id.slice(0, 8)} · {relTime(r.endedAt ?? r.startedAt)}
          </span>
        </span>
      </button>
      {isWaitingRun(r) && <span className="mr-2 size-2 rounded-full bg-danger" />}
    </div>
  );

  function selectedIsSession(id: string): boolean {
    return typeof selected === 'object' && 'session' in selected && selected.session === id;
  }
  function selectedIsRun(id: string): boolean {
    return typeof selected === 'object' && 'run' in selected && selected.run === id;
  }

  const renderThreadRow = (t: ThreadItem) => {
    if (t.kind === 'session') return renderSessionRow(t.session);
    return renderRunRow(t.run);
  };

  // 右侧面板
  const renderRight = () => {
    if (selected === 'new') return <NewSession onCreated={(id) => setSelected({ session: id })} />;
    if (selected === 'newTask') {
      return (
        <TaskIntake
          projectId={projectId}
          onStarted={(runId) => setSelected({ run: runId })}
          onBack={() => setSelected('new')}
        />
      );
    }
    if (typeof selected === 'object' && 'session' in selected) {
      const s = allSessions.find((s) => s.id === selected.session);
      if (!s) return <div className="p-6 text-sm text-dim">会话未找到</div>;
      return <SessionView key={s.id} session={s} />;
    }
    if (typeof selected === 'object' && 'run' in selected) {
      return <RunView runId={selected.run} onOpenSession={(id) => setSelected({ session: id })} onBack={() => setSelected('new')} />;
    }
    return null;
  };

  return (
    <div className="flex flex-1 overflow-hidden">
      <aside className="flex w-64 shrink-0 flex-col gap-2 border-r border-line bg-bg-2/40 p-3">
        {/* 新建区 */}
        <div className="flex gap-1.5">
          <Button variant="default" size="sm" className="flex-1 text-[11px]" onClick={() => setSelected('new')}>
            新建会话
          </Button>
          <Button variant="secondary" size="sm" className="flex-1 text-[11px]" onClick={() => setSelected('newTask')}>
            新建任务
          </Button>
        </div>

        {/* 搜索 */}
        <input
          type="text"
          placeholder="搜索标题/cwd/模型/id…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full rounded-lg border border-line bg-bg-2 px-2.5 py-1.5 text-[12px] text-ink-2 outline-none placeholder:text-faint focus:border-accent"
        />

        {/* 过滤 */}
        <div className="flex gap-1">
          <Button variant={filter === 'all' ? 'default' : 'secondary'} size="sm" className="flex-1 text-[11px]" onClick={() => setFilter('all')}>
            全部
          </Button>
          <Button variant={filter === 'session' ? 'default' : 'secondary'} size="sm" className="flex-1 text-[11px]" onClick={() => setFilter('session')}>
            会话
          </Button>
          <Button variant={filter === 'run' ? 'default' : 'secondary'} size="sm" className="flex-1 text-[11px]" onClick={() => setFilter('run')}>
            运行
          </Button>
        </div>

        {/* 线程列表 */}
        <div className="flex flex-1 flex-col gap-1 overflow-y-auto">
          {/* 等我处理置顶区 */}
          {waiting.length > 0 && (
            <>
              <div className="flex items-center gap-1.5 px-2 pt-1 pb-0.5">
                <span className="size-1.5 rounded-full bg-danger" />
                <span className="text-[10px] font-semibold tracking-wide text-danger uppercase">等我处理</span>
                <span className="mono-nums text-[10px] text-faint">{waiting.length}</span>
              </div>
              {waiting.map(renderThreadRow)}
            </>
          )}

          {active.length > 0 && (
            <>
              <div className="px-2 pt-2 pb-0.5 text-[10px] font-semibold tracking-wide text-faint uppercase">进行中</div>
              {active.map(renderThreadRow)}
            </>
          )}

          {idle.length > 0 && (
            <>
              <div className="px-2 pt-2 pb-0.5 text-[10px] font-semibold tracking-wide text-faint uppercase">空闲</div>
              {idle.map(renderThreadRow)}
            </>
          )}

          {history.length > 0 && (
            <>
              <button
                className="flex items-center gap-1.5 px-2 py-1.5 text-left text-[10px] font-semibold tracking-wide text-faint uppercase hover:text-ink-2"
                onClick={() => setShowHistory(!showHistory)}
              >
                历史 {history.length} 条 {showHistory ? '▾' : '▸'}
              </button>
              {showHistory && history.map(renderThreadRow)}
            </>
          )}

          {visible.length === 0 && <p className="px-2 py-6 text-center text-xs text-faint">还没有线程</p>}
        </div>
      </aside>

      <main className="flex flex-1 overflow-hidden">
        {renderRight()}
      </main>
    </div>
  );
}

/* ──────── AppShell（在 ProjectProvider 内） ──────── */

function AppShell({ me, refresh }: { me: Me; refresh: () => void }) {
  const [tab, setTab] = useState<Tab>('home');
  const [selected, setSelected] = useState<Selected>('new');
  const [showSettings, setShowSettings] = useState(false);
  const { setProjectId } = useCurrentProject();

  // 全局 WS 订阅：刷新 sessions/runs 缓存，让红点/铃铛更跟手
  useEffect(() => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws/client`);
    ws.onmessage = (e) => {
      try {
        const t = ((JSON.parse(e.data as string) as { type?: string }).type ?? '') as string;
        if (/^(run|session)\./.test(t)) {
          // invalidate 会让 react-query 自动 refetch
          void import('./lib/queries').then(({ invalidate }) => {
            invalidate('sessions');
            invalidate('runs');
          });
        }
      } catch { /* ignore */ }
    };
    return () => ws.close();
  }, []);

  // 铃铛跳转：切项目 + 切 tab + 选线程
  const handleBellJump = (item: AttentionItem) => {
    setProjectId(item.projectId);
    setTab('home');
    if (item.kind === 'session') {
      setSelected({ session: item.id });
    } else {
      setSelected({ run: item.id });
    }
  };

  // 计算 waitingCounts 供切换器
  const { data: allSessions = [] } = useSessions();
  const { data: allRuns = [] } = useRuns();
  const waitingCounts = useMemo(() => waitingCountByProject(allSessions, allRuns), [allSessions, allRuns]);

  const active = NAV.find((n) => n.id === tab)!;

  return (
    <div className="flex h-full overflow-hidden">
      <Sidebar tab={tab} setTab={setTab} me={me} onSettings={() => setShowSettings(true)} waitingCounts={waitingCounts} />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-13 shrink-0 items-center gap-3 border-b border-line bg-bg-2/40 px-5 py-3 backdrop-blur-sm">
          <active.icon size={17} className="text-accent" />
          <h1 className="font-display text-[15px] font-semibold tracking-tight text-ink">{active.label}</h1>
          <span className="hidden text-xs text-faint sm:inline">— {active.hint}</span>
          <div className="ml-auto flex items-center gap-1.5">
            <NotificationBell onJump={handleBellJump} />
          </div>
        </header>
        <main className="flex min-h-0 flex-1 overflow-hidden">
          <div key={tab} className="rise flex min-h-0 flex-1 overflow-hidden">
            {tab === 'home' && <HomeScreen selected={selected} setSelected={setSelected} />}
            {tab === 'projects' && <ProjectsPage me={me} onOpenSession={(id) => { setTab('home'); setSelected({ session: id }); }} onOpenRun={(runId) => { setTab('home'); setSelected({ run: runId }); }} />}
          </div>
        </main>
      </div>
      {showSettings && <SettingsModal me={me} onClose={() => setShowSettings(false)} onChanged={refresh} />}
    </div>
  );
}

/* ──────── App（入口） ──────── */

export function App() {
  const { me, refresh } = useMe();

  if (me === undefined) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-dim">
        <Spinner /> 加载中…
      </div>
    );
  }
  if (me === null) {
    return <LoginPage onLoggedIn={refresh} />;
  }

  return (
    <ProjectProvider>
      <AppShell me={me} refresh={refresh} />
    </ProjectProvider>
  );
}
