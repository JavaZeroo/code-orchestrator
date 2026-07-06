import { LogOut, MessageSquare, Plus, Settings, Workflow, Zap } from 'lucide-react';
import { useState } from 'react';
import { authApi, LoginPage, SettingsModal, useMe } from './Auth';
import { NewSession } from './NewSession';
import { NotificationBell } from './Notifications';
import { SessionView } from './SessionView';
import { TriggersPage } from './TriggersPage';
import { WorkflowsPage } from './WorkflowsPage';
import { Button } from './components/ui/button';
import { Spinner } from './components/ui/primitives';
import { useSessions } from './lib/queries';
import { cn } from './lib/utils';

const STATE_DOT: Record<string, string> = {
  idle: 'bg-ok',
  thinking: 'bg-accent animate-pulse',
  starting: 'bg-accent animate-pulse',
  waiting_approval: 'bg-warn',
  waiting_input: 'bg-warn',
  dead: 'bg-line',
};

function SessionsScreen({ selected, setSelected }: { selected: string | 'new'; setSelected: (v: string | 'new') => void }) {
  const { data: sessions = [] } = useSessions();
  const current = sessions.find((s) => s.id === selected);

  return (
    <div className="flex flex-1 overflow-hidden">
      <aside className="flex w-64 shrink-0 flex-col gap-2 border-r border-line bg-panel p-3">
        <Button variant="secondary" className="w-full" onClick={() => setSelected('new')}>
          <Plus size={14} /> 新建会话
        </Button>
        <div className="flex flex-1 flex-col gap-1 overflow-y-auto">
          {sessions.map((s) => (
            <button
              key={s.id}
              className={cn(
                'flex items-center gap-2 rounded-md p-2 text-left transition-colors hover:bg-panel-2',
                selected === s.id && 'bg-panel-2',
              )}
              onClick={() => setSelected(s.id)}
            >
              <span className={cn('size-2 shrink-0 rounded-full', STATE_DOT[s.state] ?? 'bg-dim')} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{s.cwd.split('/').pop() || s.cwd}</span>
                <span className="block truncate text-xs text-dim">
                  {s.machineId} · {s.model ?? 'claude'}
                  {s.runId ? ' · 工作流' : ''}
                </span>
              </span>
            </button>
          ))}
        </div>
      </aside>
      <main className="flex flex-1 overflow-hidden">
        {current ? (
          <SessionView key={current.id} session={current} />
        ) : (
          <NewSession onCreated={(id) => setSelected(id)} />
        )}
      </main>
    </div>
  );
}

export function App() {
  const [tab, setTab] = useState<'sessions' | 'workflows' | 'triggers'>('sessions');
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

  return (
    <div className="flex h-full flex-col">
      <nav className="flex items-center gap-1 border-b border-line bg-panel px-3 py-2">
        <span className="mr-4 font-semibold tracking-tight">code-orchestrator</span>
        <Button variant={tab === 'sessions' ? 'secondary' : 'ghost'} size="sm" onClick={() => setTab('sessions')}>
          <MessageSquare size={14} /> 会话
        </Button>
        <Button variant={tab === 'workflows' ? 'secondary' : 'ghost'} size="sm" onClick={() => setTab('workflows')}>
          <Workflow size={14} /> 工作流
        </Button>
        <Button variant={tab === 'triggers' ? 'secondary' : 'ghost'} size="sm" onClick={() => setTab('triggers')}>
          <Zap size={14} /> 触发器
        </Button>
        <div className="ml-auto flex items-center gap-2">
          <NotificationBell onOpenSession={openSession} onOpenRun={openRun} />
          <span className="text-xs text-dim">
            {me.user.email}
            {(() => {
              const bound = Object.entries(me.forges).filter(([, b]) => b.bound);
              return bound.length > 0 ? (
                <span className="ml-1 text-ok">· {bound.map(([k, b]) => `${k}:${b.login}`).join(' ')}</span>
              ) : (
                <span className="ml-1 text-warn">· forge 未绑定</span>
              );
            })()}
          </span>
          <Button variant="ghost" size="icon" onClick={() => setShowSettings(true)} title="设置">
            <Settings size={15} />
          </Button>
          <Button variant="ghost" size="icon" onClick={() => void authApi.signOut().then(refresh)} title="退出">
            <LogOut size={15} />
          </Button>
        </div>
      </nav>
      <div className="flex flex-1 overflow-hidden">
        {tab === 'sessions' && <SessionsScreen selected={selectedSession} setSelected={setSelectedSession} />}
        {tab === 'workflows' && (
          <WorkflowsPage onOpenSession={openSession} openRunId={openRunId} onOpenRunConsumed={() => setOpenRunId(null)} />
        )}
        {tab === 'triggers' && <TriggersPage me={me} onOpenRun={openRun} />}
      </div>
      {showSettings && <SettingsModal me={me} onClose={() => setShowSettings(false)} onChanged={refresh} />}
    </div>
  );
}
