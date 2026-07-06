import { ExternalLink, GitPullRequest, ShieldCheck, Workflow } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api, type LlmEndpointRow } from './api';
import { Dialog, DialogContent, DialogTitle } from './components/ui/dialog';
import { Button } from './components/ui/button';
import { Badge, Input } from './components/ui/primitives';
import { cn } from './lib/utils';

export interface ForgeBinding {
  bound: boolean;
  login?: string;
}
export interface Me {
  user: { id: string; email: string; name: string };
  forges: Record<string, ForgeBinding>;
  llm?: Record<string, { bound: boolean }>;
  lark?: { bound: boolean; enabled: boolean };
}

export const FORGES: Array<{ key: string; label: string; tokenUrl: string; hint: string }> = [
  { key: 'gitcode', label: 'GitCode', tokenUrl: 'https://gitcode.com/setting/token-classic', hint: '个人设置 → 访问令牌' },
  { key: 'github', label: 'GitHub', tokenUrl: 'https://github.com/settings/tokens', hint: 'Settings → Developer settings → PAT（勾 repo）' },
];

export const LLM_PROVIDERS: Array<{ key: string; label: string; keyUrl: string; hint: string }> = [
  { key: 'deepseek', label: 'DeepSeek', keyUrl: 'https://platform.deepseek.com/api_keys', hint: '开放平台 → API keys' },
  { key: 'glm', label: 'GLM', keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys', hint: '智谱开放平台 → API Keys' },
];

async function jauth<T>(r: Response): Promise<T> {
  if (!r.ok) {
    const body = (await r.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new Error(body.error ?? body.message ?? `HTTP ${r.status}`);
  }
  return r.json() as Promise<T>;
}

const post = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export const authApi = {
  me: () => fetch('/api/me').then((r) => (r.status === 401 ? null : jauth<Me>(r))),
  signIn: (email: string, password: string) => post('/api/auth/sign-in/email', { email, password }).then(jauth),
  signUp: (name: string, email: string, password: string) =>
    post('/api/auth/sign-up/email', { name, email, password }).then(jauth),
  signOut: () => post('/api/auth/sign-out', {}).then(jauth),
  bindForge: (forge: string, token: string) =>
    fetch(`/api/me/forge-token/${forge}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    }).then((r) => jauth<{ ok: boolean; login: string }>(r)),
  unbindForge: (forge: string) => fetch(`/api/me/forge-token/${forge}`, { method: 'DELETE' }).then(jauth),
  bindLlmKey: (provider: string, key: string) =>
    fetch(`/api/me/llm-key/${provider}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key }),
    }).then((r) => jauth<{ ok: boolean }>(r)),
  unbindLlmKey: (provider: string) => fetch(`/api/me/llm-key/${provider}`, { method: 'DELETE' }).then(jauth),
  bindLark: (url: string) =>
    fetch('/api/me/lark-webhook', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
    }).then((r) => jauth<{ ok: boolean }>(r)),
  setLarkEnabled: (enabled: boolean) =>
    fetch('/api/me/lark-webhook', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled }),
    }).then((r) => jauth<{ ok: boolean }>(r)),
  unbindLark: () => fetch('/api/me/lark-webhook', { method: 'DELETE' }).then(jauth),
  testLark: () =>
    fetch('/api/lark/test', { method: 'POST' }).then((r) => jauth<{ ok: boolean; code?: number; msg?: string }>(r)),
};

function AuthMark() {
  return (
    <svg viewBox="0 0 44 44" className="size-11" fill="none" aria-hidden>
      <rect x="1" y="1" width="42" height="42" rx="12" fill="var(--color-accent)" opacity="0.14" />
      <rect x="1.5" y="1.5" width="41" height="41" rx="11.5" stroke="var(--color-accent)" strokeOpacity="0.5" />
      <circle cx="22" cy="22" r="12.5" stroke="var(--color-accent)" strokeWidth="1.7" strokeDasharray="3.5 3.5" opacity="0.8" />
      <circle cx="22" cy="22" r="4.4" fill="var(--color-accent)" />
      <circle cx="22" cy="9.5" r="2.6" fill="var(--color-accent)" />
      <circle cx="33" cy="28" r="2.2" fill="var(--color-ink)" opacity="0.55" />
      <circle cx="11" cy="28" r="2.2" fill="var(--color-ink)" opacity="0.55" />
    </svg>
  );
}

const PITCH: { icon: typeof Workflow; text: string }[] = [
  { icon: Workflow, text: 'PM 规划' },
  { icon: GitPullRequest, text: 'Agent 落地' },
  { icon: ShieldCheck, text: '你审合入' },
];

export function LoginPage({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    setBusy(true);
    setError(null);
    const action =
      mode === 'signin' ? authApi.signIn(email, password) : authApi.signUp(name || email.split('@')[0]!, email, password);
    action
      .then(onLoggedIn)
      .catch((e) => setError(String(e instanceof Error ? e.message : e)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="rise flex w-full max-w-sm flex-col items-center gap-6">
        {/* 品牌 */}
        <div className="flex flex-col items-center gap-3 text-center">
          <AuthMark />
          <div>
            <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">orchestrator</h1>
            <p className="mt-1 text-[13px] text-dim">自主软件开发编排台</p>
          </div>
        </div>

        {/* 表单卡 */}
        <div className="w-full surface rounded-2xl p-6 shadow-[var(--shadow-panel)]">
          <div className="mb-4 flex gap-1 rounded-xl border border-line bg-bg-2/60 p-1">
            {(['signin', 'signup'] as const).map((m) => (
              <button
                key={m}
                className={cn(
                  'flex-1 rounded-lg py-1.5 text-[13px] font-medium transition-all',
                  mode === m ? 'bg-panel-3 text-ink shadow-[var(--shadow-panel)]' : 'text-dim hover:text-ink-2',
                )}
                onClick={() => {
                  setMode(m);
                  setError(null);
                }}
              >
                {m === 'signin' ? '登录' : '注册'}
              </button>
            ))}
          </div>
          <div className="flex flex-col gap-2.5">
            {mode === 'signup' && <Input placeholder="姓名" value={name} onChange={(e) => setName(e.target.value)} />}
            <Input placeholder="邮箱" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            <Input
              placeholder="密码（至少 8 位）"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
            />
            {error && (
              <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">{error}</div>
            )}
            <Button variant="default" className="mt-1" disabled={busy || !email || password.length < 8} onClick={submit}>
              {busy ? '…' : mode === 'signin' ? '登录' : '注册并登录'}
            </Button>
          </div>
        </div>

        {/* 定位条 */}
        <div className="flex items-center gap-1.5 text-[11px] text-faint">
          {PITCH.map((p, i) => (
            <span key={p.text} className="flex items-center gap-1.5">
              {i > 0 && <span className="text-line-2">·</span>}
              <p.icon size={12} className="text-accent/70" />
              {p.text}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function ForgeTokenRow({ forge, binding, onChanged }: { forge: (typeof FORGES)[number]; binding: ForgeBinding; onChanged: () => void }) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);

  const bind = () => {
    setBusy(true);
    authApi
      .bindForge(forge.key, token.trim())
      .then((d) => {
        toast.success(`已绑定 ${forge.label} 账号：${d.login}`);
        setToken('');
        onChanged();
      })
      .catch((e) => toast.error(`${e instanceof Error ? e.message : e}`))
      .finally(() => setBusy(false));
  };

  return (
    <div className="rounded-lg border border-line p-3">
      <div className="mb-2 flex items-center gap-2">
        <h4 className="text-sm font-medium">{forge.label} 访问令牌</h4>
        {binding.bound && <Badge tone="ok">{binding.login}</Badge>}
        <a
          className="ml-auto inline-flex items-center gap-0.5 text-xs text-accent underline"
          href={forge.tokenUrl}
          target="_blank"
          rel="noreferrer"
        >
          创建 <ExternalLink size={10} />
        </a>
      </div>
      <p className="mb-2 text-xs text-dim">{forge.hint}。绑定后系统以你的身份在此 forge 创建 PR、发评论；令牌加密存储。</p>
      <div className="flex gap-2">
        <Input
          type="password"
          placeholder={binding.bound ? '输入新令牌以更换' : `粘贴 ${forge.label} 令牌`}
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
        <Button variant="default" disabled={busy || token.trim().length < 10} onClick={bind}>
          {busy ? '验证中…' : '绑定'}
        </Button>
      </div>
      {binding.bound && (
        <Button
          variant="ghost"
          size="sm"
          className="mt-2 self-start text-danger"
          onClick={() => void authApi.unbindForge(forge.key).then(onChanged)}
        >
          解绑
        </Button>
      )}
    </div>
  );
}

function LlmKeyRow({
  provider,
  binding,
  onChanged,
}: {
  provider: (typeof LLM_PROVIDERS)[number];
  binding: { bound: boolean };
  onChanged: () => void;
}) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);

  const bind = () => {
    setBusy(true);
    authApi
      .bindLlmKey(provider.key, key.trim())
      .then(() => {
        toast.success(`已配置 ${provider.label} API key`);
        setKey('');
        onChanged();
      })
      .catch((e) => toast.error(`${e instanceof Error ? e.message : e}`))
      .finally(() => setBusy(false));
  };

  return (
    <div className="rounded-lg border border-line p-3">
      <div className="mb-2 flex items-center gap-2">
        <h4 className="text-sm font-medium">{provider.label} API Key</h4>
        {binding.bound && <Badge tone="ok">已配置</Badge>}
        <a
          className="ml-auto inline-flex items-center gap-0.5 text-xs text-accent underline"
          href={provider.keyUrl}
          target="_blank"
          rel="noreferrer"
        >
          创建 <ExternalLink size={10} />
        </a>
      </div>
      <p className="mb-2 text-xs text-dim">{provider.hint}。会话选 {provider.key} 模型时优先用你的 key；密钥加密存储。</p>
      <div className="flex gap-2">
        <Input
          type="password"
          placeholder={binding.bound ? '输入新 key 以更换' : `粘贴 ${provider.label} API key`}
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
        <Button variant="default" disabled={busy || key.trim().length < 10} onClick={bind}>
          {busy ? '保存中…' : '保存'}
        </Button>
      </div>
      {binding.bound && (
        <Button
          variant="ghost"
          size="sm"
          className="mt-2 self-start text-danger"
          onClick={() => void authApi.unbindLlmKey(provider.key).then(onChanged)}
        >
          删除
        </Button>
      )}
    </div>
  );
}

function LarkWebhookRow({
  binding,
  onChanged,
}: {
  binding: { bound: boolean; enabled: boolean };
  onChanged: () => void;
}) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);

  const bind = () => {
    setBusy(true);
    authApi
      .bindLark(url.trim())
      .then(() => {
        toast.success('飞书 webhook 已配置');
        setUrl('');
        onChanged();
      })
      .catch((e) => toast.error(`${e instanceof Error ? e.message : e}`))
      .finally(() => setBusy(false));
  };

  const test = () => {
    setBusy(true);
    authApi
      .testLark()
      .then((r) => {
        if (r.ok) {
          toast.success('测试消息已发送，请查看飞书');
        } else {
          toast.error(`发送失败${r.code ? `（${r.code}）` : ''}${r.msg ? `：${r.msg}` : ''}`);
        }
      })
      .catch((e) => toast.error(`${e instanceof Error ? e.message : e}`))
      .finally(() => setBusy(false));
  };

  return (
    <div className="rounded-lg border border-line p-3">
      <div className="mb-2 flex items-center gap-2">
        <h4 className="text-sm font-medium">飞书 Webhook URL</h4>
        {binding.bound && (
          <Badge tone={binding.enabled ? 'ok' : 'warn'}>{binding.enabled ? '已配置' : '已暂停'}</Badge>
        )}
        <a
          className="ml-auto inline-flex items-center gap-0.5 text-xs text-accent underline"
          href="https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot"
          target="_blank"
          rel="noreferrer"
        >
          查看说明 <ExternalLink size={10} />
        </a>
      </div>
      <p className="mb-2 text-xs text-dim">
        填自定义群机器人 webhook。当前仅出站通知；URL 加密存储。
      </p>
      <div className="flex gap-2">
        <Input
          type="password"
          placeholder={binding.bound ? '输入新 URL 以更换' : '粘贴飞书 webhook URL'}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <Button variant="default" disabled={busy || url.trim().length < 10} onClick={bind}>
          {busy ? '保存中…' : '保存'}
        </Button>
      </div>
      {binding.bound && (
        <div className="mt-2 flex items-center gap-2">
          <Button variant="secondary" size="sm" disabled={busy} onClick={test}>
            发送测试
          </Button>
          <label className="flex items-center gap-1.5 text-xs text-dim">
            <input
              type="checkbox"
              checked={binding.enabled}
              onChange={(e) => {
                const v = e.target.checked;
                authApi.setLarkEnabled(v).then(onChanged).catch((e) => toast.error(`${e instanceof Error ? e.message : e}`));
              }}
              className="h-3.5 w-3.5 rounded border-line accent-accent"
            />
            启用
          </label>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto text-danger"
            onClick={() => void authApi.unbindLark().then(onChanged)}
          >
            删除
          </Button>
        </div>
      )}
    </div>
  );
}

function LlmEndpointRow({
  endpoint,
  onChanged,
}: {
  endpoint: LlmEndpointRow;
  onChanged: () => void;
}) {
  const [deleting, setDeleting] = useState(false);

  const remove = () => {
    setDeleting(true);
    api
      .deleteEndpoint(endpoint.label)
      .then(() => {
        toast.success(`已删除端点 ${endpoint.label}`);
        onChanged();
      })
      .catch((e) => toast.error(`${e instanceof Error ? e.message : e}`))
      .finally(() => setDeleting(false));
  };

  return (
    <div className="rounded-lg border border-line p-3">
      <div className="mb-1 flex items-center gap-2">
        <h4 className="text-sm font-medium">{endpoint.label}</h4>
        <Badge tone="ok">已配置</Badge>
      </div>
      <p className="text-xs text-dim">
        {endpoint.model} · {endpoint.baseUrl}
      </p>
      <Button
        variant="ghost"
        size="sm"
        className="mt-2 self-start text-danger"
        disabled={deleting}
        onClick={remove}
      >
        {deleting ? '删除中…' : '删除'}
      </Button>
    </div>
  );
}

function NewEndpointForm({ onChanged }: { onChanged: () => void }) {
  const [label, setLabel] = useState('');
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);

  const canSave = label.trim() && model.trim() && baseUrl.trim() && apiKey.trim().length >= 10;

  const save = () => {
    setBusy(true);
    api
      .upsertEndpoint(label.trim(), model.trim(), baseUrl.trim(), apiKey.trim())
      .then(() => {
        toast.success(`端点 ${label} 已保存`);
        setLabel('');
        setModel('');
        setBaseUrl('');
        setApiKey('');
        onChanged();
      })
      .catch((e) => toast.error(`${e instanceof Error ? e.message : e}`))
      .finally(() => setBusy(false));
  };

  return (
    <div className="rounded-lg border border-line p-3">
      <h4 className="mb-2 text-sm font-medium">新增自定义端点</h4>
      <div className="flex flex-col gap-2">
        <Input
          placeholder="label（如 my-deepseek）"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <Input
          placeholder="模型名（如 deepseek-chat）"
          value={model}
          onChange={(e) => setModel(e.target.value)}
        />
        <Input
          placeholder="Base URL（Anthropic 兼容，如 https://api.example.com/anthropic）"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
        />
        <Input
          type="password"
          placeholder="API Key（至少 10 位）"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && canSave && save()}
        />
        <Button variant="default" disabled={busy || !canSave} onClick={save}>
          {busy ? '保存中…' : '添加端点'}
        </Button>
      </div>    </div>
  );
}

export function SettingsModal({ me, onClose, onChanged }: { me: Me; onClose: () => void; onChanged: () => void }) {
  const [endpoints, setEndpoints] = useState<LlmEndpointRow[]>([]);

  const refreshEndpoints = useCallback(() => {
    api.listEndpoints().then(setEndpoints).catch(() => setEndpoints([]));
  }, []);

  useEffect(() => {
    refreshEndpoints();
  }, [refreshEndpoints]);

  const onAnyChanged = () => {
    onChanged();
    refreshEndpoints();
  };

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogTitle>设置</DialogTitle>
        <p className="mb-4 text-xs text-dim">{me.user.email}</p>
        <div className="flex flex-col gap-3">
          {FORGES.map((f) => (
            <ForgeTokenRow key={f.key} forge={f} binding={me.forges[f.key] ?? { bound: false }} onChanged={onAnyChanged} />
          ))}
          <h4 className="mt-2 text-xs font-medium text-dim">LLM API Key</h4>
          {LLM_PROVIDERS.map((p) => (
            <LlmKeyRow key={p.key} provider={p} binding={me.llm?.[p.key] ?? { bound: false }} onChanged={onAnyChanged} />
          ))}
          <h4 className="mt-2 text-xs font-medium text-dim">飞书通知</h4>
          <LarkWebhookRow binding={me.lark ?? { bound: false, enabled: false }} onChanged={onChanged} />
          <h4 className="mt-2 text-xs font-medium text-dim">LLM 端点注册表</h4>
          {endpoints.map((ep) => (
            <LlmEndpointRow key={ep.id} endpoint={ep} onChanged={refreshEndpoints} />
          ))}
          <NewEndpointForm onChanged={refreshEndpoints} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function useMe() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const refresh = useCallback(() => {
    authApi
      .me()
      .then(setMe)
      .catch(() => setMe(null));
  }, []);
  useEffect(() => {
    refresh();
    const onUnauthorized = () => setMe(null);
    window.addEventListener('co:unauthorized', onUnauthorized);
    return () => window.removeEventListener('co:unauthorized', onUnauthorized);
  }, [refresh]);
  return { me, refresh };
}
