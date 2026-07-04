import { useEffect, useState } from 'react';
import { api, type MachineRow } from './api';

export function NewSession({ onCreated }: { onCreated: (sessionId: string) => void }) {
  const [machines, setMachines] = useState<MachineRow[]>([]);
  const [machineId, setMachineId] = useState('');
  const [cwd, setCwd] = useState('/root');
  const [model, setModel] = useState('claude');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .machines()
      .then((m) => {
        setMachines(m);
        if (m.length > 0 && !machineId) {
          setMachineId(m[0]!.id);
        }
      })
      .catch((e) => setError(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = () => {
    if (!machineId || !cwd) {
      return;
    }
    setBusy(true);
    setError(null);
    api
      .spawn({ machineId, cwd, model, prompt: prompt.trim() || undefined })
      .then((d) => onCreated(d.sessionId))
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="new-session">
      <h2>新建会话</h2>
      {error && <div className="error">{error}</div>}
      <label>
        机器
        <select value={machineId} onChange={(e) => setMachineId(e.target.value)}>
          {machines.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name} {m.labels.length > 0 ? `[${m.labels.join(',')}]` : ''}
            </option>
          ))}
        </select>
      </label>
      <label>
        工作目录
        <input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="/path/to/repo" />
      </label>
      <label>
        模型
        <select value={model} onChange={(e) => setModel(e.target.value)}>
          <option value="claude">claude（默认）</option>
          <option value="deepseek">deepseek（Anthropic 兼容端点）</option>
          <option value="glm">glm（Anthropic 兼容端点）</option>
        </select>
      </label>
      <label>
        首条消息（可选）
        <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={4} placeholder="要做什么？" />
      </label>
      <button disabled={busy || !machineId} onClick={submit}>
        {busy ? '创建中…' : '创建会话'}
      </button>
      {machines.length === 0 && <p className="dim">没有在线机器——先在目标机器上启动 runner。</p>}
    </div>
  );
}
