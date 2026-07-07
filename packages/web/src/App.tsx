import { FolderGit2, type LucideIcon, LayoutDashboard, LogOut, MessageSquareText, Settings, Workflow, Zap } from 'lucide-react';
import { useEffect, useState } from 'react';
import { authApi, LoginPage, SettingsModal, useMe, type Me } from './Auth';
import { Dashboard } from './Dashboard';
import { NewSession } from './NewSession';
import { NotificationBell } from './Notifications';
import { ProjectsPage } from './ProjectsPage';
import { SessionView } from './SessionView';
import { TriggersPage } from './TriggersPage';
import { WorkflowsPage } from './WorkflowsPage';
import { Button } from './components/ui/button';
import { Spinner, StatusDot } from './components/ui/primitives';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './components/ui/select';
import { useProjects, useRuns, useSessions } from './lib/queries';
import { ProjectProvider, useCurrentProject, useProjectScope } from './lib/project';
import { cn } from './lib/utils';

type Tab = 'dashboard' | 'projects' | 'triggers' | 'workflows' | 'sessions';

const NAV: { id: Tab; label: string; icon: LucideIcon; hint: string }[] = [
  { id: 'dashboard', label: '看板', icon: LayoutDashboard, hint: '总览 · 谁在干活 · 谁等我' },
  { id: 'projects', label: '项目', icon: FolderGit2, hint: '策略容器 · 自治开关' },
  { id: 'triggers', label: '需求', icon: Zap, hint: 'issue → 自动起流水线' },
  { id: 'workflows', label: '工作流', icon: Workflow, hint: '流水线与运行' },
  { id: 'sessions', label: '会话', icon: MessageSquareText, hint: 'Agent 会话' },
];

const STATE_DOT: Record<string, string> = {
  idle: 'ok',
  thinking: 'run',
  starting: 'run',
  waiting_approval: 'human',
  waiting_input: 'human',
  dead: 'neutral',
};

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

function ProjectSwitcher() {
  const { data: projects = [] } = useProjects();
  const { projectId, setProjectId } = useCurrentProject();
  // 项目总是被选中：无选择或选中的已删除 → 落到第一个（去掉了"全部项目"视图）
  useEffect(() => {
    if (projects.length > 0 && (!projectId || !projects.some((p) => p.id === projectId))) {
      setProjectId(projects[0]!.id);
    }
  }, [projectId, projects, setProjectId]);
  if (projects.length === 0) {
    return null;
  }
  return (
    <div className="px-2.5 pb-1">
      <Select value={projectId ?? ''} onValueChange={(v) => setProjectId(v)}>
        <SelectTrigger className="w-full">
          <span className="flex min-w-0 items-center gap-2">
            <FolderGit2 size={13} className="shrink-0 text-accent" />
            <SelectValue placeholder="选择项目" />
          </span>
        </SelectTrigger>
        <SelectContent>
          {projects.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {p.name}
            </SelectItem>
          ))}
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
}: {
  tab: Tab;
  setTab: (t: Tab) => void;
  me: Me;
  onSettings: () => void;
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

      <ProjectSwitcher />

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

function SessionsScreen({ selected, setSelected }: { selected: string | 'new'; setSelected: (v: string | 'new') => void }) {
  const { data: allSessions = [] } = useSessions();
  const { data: runs = [] } = useRuns();
  const { inScope } = useProjectScope();
  const runProj = new Map(runs.map((r) => [r.id, r.projectId]));
  // 会话作用域：自身 projectId，否则经其 run 归属（工作流会话）
  const sessions = allSessions.filter((s) => inScope(s.projectId ?? (s.runId ? runProj.get(s.runId) ?? null : null)));
  const current = allSessions.find((s) => s.id === selected);
  return (
    <div className="flex flex-1 overflow-hidden">
      <aside className="flex w-64 shrink-0 flex-col gap-2 border-r border-line bg-bg-2/40 p-3">
        <Button variant="default" className="w-full" onClick={() => setSelected('new')}>
          新建会话
        </Button>
        <div className="flex flex-1 flex-col gap-1 overflow-y-auto">
          {sessions.map((s) => (
            <button
              key={s.id}
              className={cn(
                'flex items-center gap-2.5 rounded-lg p-2 text-left transition-colors hover:bg-panel-2',
                selected === s.id && 'bg-panel-2 shadow-[var(--shadow-panel)]',
              )}
              onClick={() => setSelected(s.id)}
            >
              <StatusDot tone={STATE_DOT[s.state] ?? 'neutral'} live={s.state === 'thinking' || s.state === 'starting'} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-ink-2">{s.cwd.split('/').pop() || s.cwd}</span>
                <span className="mono-nums block truncate text-[10px] text-faint">
                  {s.model ?? 'claude'}
                  {s.runId ? ' · 工作流' : ''}
                </span>
              </span>
            </button>
          ))}
          {sessions.length === 0 && <p className="px-2 py-6 text-center text-xs text-faint">还没有会话</p>}
        </div>
      </aside>
      <main className="flex flex-1 overflow-hidden">
        {current ? <SessionView key={current.id} session={current} /> : <NewSession onCreated={(id) => setSelected(id)} />}
      </main>
    </div>
  );
}

export function App() {
  const [tab, setTab] = useState<Tab>('dashboard');
  const [selectedSession, setSelectedSession] = useState<string | 'new'>('new');
  const [showSettings, setShowSettings] = useState(false);
  const [openRunId, setOpenRunId] = useState<string | null>(null);
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

  const openSession = (id: string) => {
    setSelectedSession(id);
    setTab('sessions');
  };
  const openRun = (runId: string) => {
    setOpenRunId(runId);
    setTab('workflows');
  };
  const active = NAV.find((n) => n.id === tab)!;

  return (
    <ProjectProvider>
    <div className="flex h-full overflow-hidden">
      <Sidebar tab={tab} setTab={setTab} me={me} onSettings={() => setShowSettings(true)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-13 shrink-0 items-center gap-3 border-b border-line bg-bg-2/40 px-5 py-3 backdrop-blur-sm">
          <active.icon size={17} className="text-accent" />
          <h1 className="font-display text-[15px] font-semibold tracking-tight text-ink">{active.label}</h1>
          <span className="hidden text-xs text-faint sm:inline">— {active.hint}</span>
          <div className="ml-auto flex items-center gap-1.5">
            <NotificationBell onOpenSession={openSession} onOpenRun={openRun} />
          </div>
        </header>
        <main className="flex min-h-0 flex-1 overflow-hidden">
          <div key={tab} className="rise flex min-h-0 flex-1 overflow-hidden">
            {tab === 'dashboard' && <Dashboard onOpenSession={openSession} onOpenRun={openRun} />}
            {tab === 'projects' && <ProjectsPage onOpenSession={openSession} />}
            {tab === 'triggers' && <TriggersPage me={me} onOpenRun={openRun} />}
            {tab === 'workflows' && (
              <WorkflowsPage onOpenSession={openSession} openRunId={openRunId} onOpenRunConsumed={() => setOpenRunId(null)} />
            )}
            {tab === 'sessions' && <SessionsScreen selected={selectedSession} setSelected={setSelectedSession} />}
          </div>
        </main>
      </div>
      {showSettings && <SettingsModal me={me} onClose={() => setShowSettings(false)} onChanged={refresh} />}
    </div>
    </ProjectProvider>
  );
}
