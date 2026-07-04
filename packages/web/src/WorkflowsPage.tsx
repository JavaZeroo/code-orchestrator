import { useCallback, useEffect, useState } from 'react';
import { api, type RunRow, type WorkflowDefRow } from './api';
import { Designer } from './Designer';
import { RunView } from './RunView';

function StartForm({ def, onStarted }: { def: WorkflowDefRow; onStarted: (runId: string) => void }) {
  const varKeys = Object.keys(def.graph.vars ?? {});
  const needsCwd = def.graph.nodes.some((n) => n.type === 'agent' && !n.cwd);
  const [vars, setVars] = useState<Record<string, string>>({ ...(def.graph.vars ?? {}) });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const keys = needsCwd && !varKeys.includes('cwd') ? ['cwd', ...varKeys] : varKeys;

  const start = () => {
    setBusy(true);
    api
      .startRun(def.id, vars)
      .then((d) => onStarted(d.runId))
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="start-form">
      {keys.map((k) => (
        <label key={k}>
          {k}
          <input
            value={vars[k] ?? ''}
            placeholder={k === 'cwd' ? '/path/to/repo（agent 节点工作目录）' : ''}
            onChange={(e) => setVars({ ...vars, [k]: e.target.value })}
          />
        </label>
      ))}
      {error && <div className="error">{error}</div>}
      <button disabled={busy} onClick={start}>
        {busy ? '启动中…' : '▶ 启动'}
      </button>
    </div>
  );
}

export function WorkflowsPage({ onOpenSession }: { onOpenSession: (sessionId: string) => void }) {
  const [view, setView] = useState<'list' | 'designer' | { run: string }>('list');
  const [defs, setDefs] = useState<WorkflowDefRow[]>([]);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api.workflows().then(setDefs).catch(console.error);
    api.runs().then(setRuns).catch(console.error);
  }, []);

  useEffect(() => {
    if (view === 'list') {
      refresh();
      const timer = setInterval(refresh, 8_000);
      return () => clearInterval(timer);
    }
    return undefined;
  }, [view, refresh]);

  if (view === 'designer') {
    return (
      <Designer
        onBack={() => setView('list')}
        onSaved={() => {
          setView('list');
        }}
      />
    );
  }
  if (typeof view === 'object') {
    return <RunView runId={view.run} onOpenSession={onOpenSession} onBack={() => setView('list')} />;
  }

  return (
    <div className="workflows-page">
      <section>
        <header>
          <h2>工作流</h2>
          <button onClick={() => setView('designer')}>💬 对话式新建</button>
        </header>
        {defs.length === 0 && <p className="dim">还没有工作流——点"对话式新建"，跟 agent 说你要什么流程。</p>}
        {defs.map((d) => (
          <div key={d.id} className="card">
            <div className="card-head" onClick={() => setExpanded(expanded === d.id ? null : d.id)}>
              <b>{d.name}</b>
              <span className="dim">
                {d.graph.nodes.length} 节点 · v{d.version} · {d.createdVia === 'chat' ? '对话生成' : '手工'}
              </span>
            </div>
            {expanded === d.id && <StartForm def={d} onStarted={(runId) => setView({ run: runId })} />}
          </div>
        ))}
      </section>
      <section>
        <header>
          <h2>运行记录</h2>
        </header>
        {runs.map((r) => (
          <div key={r.id} className="card card-row" onClick={() => setView({ run: r.id })}>
            <span className={`chip run-${r.status}`}>{r.status}</span>
            <span>{defs.find((d) => d.id === r.defId)?.name ?? r.defId.slice(0, 8)}</span>
            <span className="dim">{new Date(r.startedAt).toLocaleString()}</span>
          </div>
        ))}
      </section>
    </div>
  );
}
