import { useCallback, useEffect, useState } from 'react';
import { api, type SessionRow } from './api';
import { authApi, LoginPage, SettingsModal, useMe } from './Auth';
import { NewSession } from './NewSession';
import { SessionView } from './SessionView';
import { WorkflowsPage } from './WorkflowsPage';

function SessionsScreen({
  selected,
  setSelected,
}: {
  selected: string | 'new';
  setSelected: (v: string | 'new') => void;
}) {
  const [sessions, setSessions] = useState<SessionRow[]>([]);

  const refresh = useCallback(() => {
    api.sessions().then(setSessions).catch(console.error);
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 8_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const current = sessions.find((s) => s.id === selected);

  return (
    <div className="sessions-screen">
      <aside>
        <button className="new-btn" onClick={() => setSelected('new')}>
          ＋ 新建会话
        </button>
        <div className="session-list">
          {sessions.map((s) => (
            <div
              key={s.id}
              className={`session-item ${selected === s.id ? 'active' : ''}`}
              onClick={() => setSelected(s.id)}
            >
              <span className={`dot state-${s.state}`} />
              <div className="session-item-body">
                <div className="session-item-title">{s.cwd.split('/').pop() || s.cwd}</div>
                <div className="dim">
                  {s.machineId} · {s.model ?? 'claude'}
                  {s.runId ? ' · 工作流' : ''}
                </div>
              </div>
            </div>
          ))}
        </div>
      </aside>
      <main>
        {current ? (
          <SessionView key={current.id} session={current} />
        ) : (
          <NewSession
            onCreated={(id) => {
              refresh();
              setSelected(id);
            }}
          />
        )}
      </main>
    </div>
  );
}

export function App() {
  const [tab, setTab] = useState<'sessions' | 'workflows'>('sessions');
  const [selectedSession, setSelectedSession] = useState<string | 'new'>('new');
  const [showSettings, setShowSettings] = useState(false);
  const { me, refresh } = useMe();

  const openSession = (sessionId: string) => {
    setSelectedSession(sessionId);
    setTab('sessions');
  };

  if (me === undefined) {
    return <div className="dim" style={{ padding: 40 }}>加载中…</div>;
  }
  if (me === null) {
    return <LoginPage onLoggedIn={refresh} />;
  }

  return (
    <div className="app">
      <nav className="topbar">
        <span className="brand">code-orchestrator</span>
        <button className={`tab ${tab === 'sessions' ? 'active' : ''}`} onClick={() => setTab('sessions')}>
          会话
        </button>
        <button className={`tab ${tab === 'workflows' ? 'active' : ''}`} onClick={() => setTab('workflows')}>
          工作流
        </button>
        <div className="topbar-right">
          <span className="dim">
            {me.user.email}
            {me.gitcode.bound ? ` · gitcode:${me.gitcode.login}` : ' · gitcode 未绑定'}
          </span>
          <button className="tab" onClick={() => setShowSettings(true)}>
            设置
          </button>
          <button
            className="tab"
            onClick={() => {
              void authApi.signOut().then(refresh);
            }}
          >
            退出
          </button>
        </div>
      </nav>
      <div className="app-body">
        {tab === 'sessions' ? (
          <SessionsScreen selected={selectedSession} setSelected={setSelectedSession} />
        ) : (
          <WorkflowsPage onOpenSession={openSession} />
        )}
      </div>
      {showSettings && <SettingsModal me={me} onClose={() => setShowSettings(false)} onChanged={refresh} />}
    </div>
  );
}
