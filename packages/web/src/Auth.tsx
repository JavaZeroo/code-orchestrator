import { ExternalLink, GitPullRequest, ShieldCheck, Workflow } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api, type AllMachineRow, type LlmProviderRow } from './api';
import { Dialog, DialogContent, DialogTitle } from './components/ui/dialog';
import { Button } from './components/ui/button';
import { Badge, Input, StatusDot } from './components/ui/primitives';
import { invalidate, useAllMachines, useLlmProviders } from './lib/queries';
import { cn, relTime } from './lib/utils';

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

export const BUILTIN_PROVIDERS = ['anthropic', 'deepseek', 'glm'];

function extractDomain(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}

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
      <circle cx="33" cy="28" r="2.2" fill="var(--color-accent)" />
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

function ProviderCard({
  provider,
  me,
  onChanged,
}: {
  provider: LlmProviderRow;
  me: Me;
  onChanged: () => void;
}) {
  const [newModel, setNewModel] = useState('');
  const [showKeyInput, setShowKeyInput] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [showUserKey, setShowUserKey] = useState(false);
  const [userKey, setUserKey] = useState('');
  const [busy, setBusy] = useState(false);

  const isBuiltin = BUILTIN_PROVIDERS.includes(provider.name);

  const updateProvider = (patch: { base_url?: string | null; api_key?: string; models?: string[]; default_model?: string | null }) => {
    setBusy(true);
    // 服务端 PUT 对 baseUrl/models/defaultModel 无条件写入，必须传全量
    api
      .saveProvider(provider.name, {
        base_url: provider.baseUrl,
        models: provider.models,
        default_model: provider.defaultModel,
        ...patch,
      })
      .then(() => {
        toast.success(`已更新 ${provider.name}`);
        onChanged();
      })
      .catch((e) => toast.error(`${e instanceof Error ? e.message : e}`))
      .finally(() => setBusy(false));
  };

  const addModel = () => {
    const m = newModel.trim();
    if (!m) return;
    updateProvider({ models: [...provider.models, m], default_model: provider.defaultModel });
    setNewModel('');
  };

  const deleteModel = (m: string) => {
    updateProvider({
      models: provider.models.filter((x) => x !== m),
      default_model: provider.defaultModel === m ? null : provider.defaultModel,
    });
  };

  const setDefaultModel = (m: string) => {
    updateProvider({ default_model: m });
  };

  const saveProviderKey = () => {
    if (apiKey.trim().length < 10) return;
    updateProvider({ api_key: apiKey.trim() });
    setApiKey('');
    setShowKeyInput(false);
  };

  const saveUserKey = () => {
    if (userKey.trim().length < 10) return;
    setBusy(true);
    authApi
      .bindLlmKey(provider.name, userKey.trim())
      .then(() => {
        toast.success(`已配置个人 key`);
        setUserKey('');
        setShowUserKey(false);
        onChanged();
      })
      .catch((e) => toast.error(`${e instanceof Error ? e.message : e}`))
      .finally(() => setBusy(false));
  };

  const deleteUserKey = () => {
    setBusy(true);
    authApi
      .unbindLlmKey(provider.name)
      .then(() => {
        toast.success(`已删除个人 key`);
        onChanged();
      })
      .catch((e) => toast.error(`${e instanceof Error ? e.message : e}`))
      .finally(() => setBusy(false));
  };

  const deleteProvider = () => {
    if (!confirm(`确定删除服务商「${provider.name}」？`)) return;
    setBusy(true);
    api
      .deleteProvider(provider.name)
      .then(() => {
        toast.success(`已删除 ${provider.name}`);
        onChanged();
      })
      .catch((e) => toast.error(`${e instanceof Error ? e.message : e}`))
      .finally(() => setBusy(false));
  };

  const baseUrlLabel = provider.baseUrl ? extractDomain(provider.baseUrl) : '官方直连';
  const userKeyBound = me.llm?.[provider.name]?.bound;

  return (
    <div className="rounded-lg border border-line p-3">
      {/* 卡片头 */}
      <div className="mb-2 flex items-center gap-2">
        <h4 className="text-sm font-medium capitalize">{provider.name}</h4>
        <Badge>{baseUrlLabel}</Badge>
        {provider.hasKey ? (
          <Badge tone="ok">已配置</Badge>
        ) : provider.baseUrl ? (
          <Badge tone="warn">未配置</Badge>
        ) : (
          <Badge title="官方直连无需 API key，使用执行机自身凭据">宿主凭据</Badge>
        )}
      </div>

      {/* 模型 chips + 添加 */}
      <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
        {provider.models.map((m) => (
          <span
            key={m}
            className={cn(
              'group inline-flex cursor-pointer items-center gap-1 rounded-full px-2 py-0.5 text-[11px] transition-colors',
              m === provider.defaultModel
                ? 'bg-accent/20 text-accent'
                : 'bg-bg-2/60 text-ink-2 hover:bg-accent/10',
            )}
            onClick={() => setDefaultModel(m)}
            title={m === provider.defaultModel ? '默认模型（点击取消）' : '设为默认'}
          >
            {m === provider.defaultModel && (
              <svg viewBox="0 0 12 12" className="size-2.5 fill-accent" aria-hidden>
                <path d="M5.5.5 7 4l3.5.5L8 7.5l.5 4L5.5 9.5 2 11.5l.5-4L0 4.5 4 4Z" />
              </svg>
            )}
            {m}
            <button
              onClick={(e) => {
                e.stopPropagation();
                deleteModel(m);
              }}
              className="ml-0.5 rounded-full p-0.5 text-faint opacity-0 transition-opacity group-hover:opacity-100 hover:text-danger"
            >
              <svg viewBox="0 0 12 12" className="size-2.5" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M3 3l6 6M9 3l-6 6" />
              </svg>
            </button>
          </span>
        ))}
        {/* 内联添加模型 */}
        <div className="inline-flex items-center">
          <input
            value={newModel}
            onChange={(e) => setNewModel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addModel();
            }}
            placeholder="+ 添加模型"
            className="h-5 w-22 rounded border border-line/50 bg-transparent px-1.5 text-[11px] text-ink outline-none placeholder:text-faint focus:border-accent/60"
          />
        </div>
      </div>

      {/* 操作行 */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
        {/* 更换 key（provider 级） */}
        <button
          className="text-accent underline hover:text-accent-2"
          onClick={() => setShowKeyInput(!showKeyInput)}
        >
          {showKeyInput ? '收起' : '更换密钥'}
        </button>

        {/* 我的 key（仅 deepseek/glm 显示 per-user） */}
        {isBuiltin && provider.name !== 'anthropic' && (
          <button
            className="text-accent underline hover:text-accent-2"
            onClick={() => setShowUserKey(!showUserKey)}
          >
            {userKeyBound ? '我的 key ✓' : '我的 key'}
          </button>
        )}

        {/* 删除（仅非内置 + 自己的） */}
        {!isBuiltin && provider.createdBy === me.user.id && (
          <button
            className="text-danger underline hover:text-danger/80"
            disabled={busy}
            onClick={deleteProvider}
          >
            删除服务商
          </button>
        )}
      </div>

      {/* 更换 key 输入 */}
      {showKeyInput && (
        <div className="mt-2 flex gap-2">
          <Input
            type="password"
            placeholder="新 API Key"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            className="h-7 text-[12px]"
          />
          <Button
            variant="default"
            size="sm"
            disabled={apiKey.trim().length < 10 || busy}
            onClick={saveProviderKey}
          >
            保存
          </Button>
        </div>
      )}

      {/* 我的 key（per-user）输入 */}
      {showUserKey && (
        <div className="mt-2">
          <div className="flex gap-2">
            <Input
              type="password"
              placeholder={userKeyBound ? '输入新 key 以更换' : '粘贴 API key'}
              value={userKey}
              onChange={(e) => setUserKey(e.target.value)}
              className="h-7 text-[12px]"
            />
            <Button
              variant="default"
              size="sm"
              disabled={userKey.trim().length < 10 || busy}
              onClick={saveUserKey}
            >
              保存
            </Button>
          </div>
          {userKeyBound && (
            <button
              className="mt-1 text-xs text-danger underline"
              disabled={busy}
              onClick={deleteUserKey}
            >
              删除个人 key
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function NewProviderForm({ onChanged }: { onChanged: () => void }) {
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [firstModel, setFirstModel] = useState('');
  const [busy, setBusy] = useState(false);

  const canSave = name.trim().length > 0 && apiKey.trim().length >= 10;

  const save = () => {
    if (!canSave) return;
    setBusy(true);
    api
      .saveProvider(name.trim(), {
        base_url: baseUrl.trim() || null,
        api_key: apiKey.trim(),
        models: firstModel.trim() ? [firstModel.trim()] : [],
      })
      .then((r) => {
        toast.success(`服务商 ${r.name} 已创建`);
        setName('');
        setBaseUrl('');
        setApiKey('');
        setFirstModel('');
        onChanged();
      })
      .catch((e) => toast.error(`${e instanceof Error ? e.message : e}`))
      .finally(() => setBusy(false));
  };

  return (
    <div className="rounded-lg border border-line p-3">
      <h4 className="mb-2 text-sm font-medium">新增服务商</h4>
      <div className="flex flex-col gap-2">
        <Input
          placeholder="名称（如 my-provider）"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Input
          placeholder="Base URL（Anthropic 兼容，可选留空=官方直连）"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
        />
        <Input
          type="password"
          placeholder="API Key（至少 10 位）"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
        <Input
          placeholder="首个模型名（可选）"
          value={firstModel}
          onChange={(e) => setFirstModel(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && canSave && save()}
        />
        <Button variant="default" disabled={busy || !canSave} onClick={save}>
          {busy ? '创建中…' : '添加服务商'}
        </Button>
      </div>
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

function installCommand(m: { id: string; labels: string[]; enrollToken: string | null }): string {
  const ws = location.origin.replace(/^http/, 'ws');
  return [
    `git clone https://github.com/JavaZeroo/code-orchestrator.git && cd code-orchestrator && pnpm install`,
    `SERVER_URL=${ws}/ws/runner \\`,
    `RUNNER_SHARED_TOKEN=${m.enrollToken ?? '<接入凭证>'} \\`,
    `MACHINE_ID=${m.id} \\`,
    `MACHINE_LABELS=${m.labels.join(',') || 'dev'} \\`,
    `pnpm dev:runner    # 生产用 pm2 托管，参考 deploy/ecosystem.config.cjs`,
  ].join('\n');
}

function MachineRow({ m }: { m: AllMachineRow }) {
  const [showCmd, setShowCmd] = useState(false);
  const [editing, setEditing] = useState(false);
  const [labelsText, setLabelsText] = useState(m.labels.join(','));

  const saveLabels = () => {
    setEditing(false);
    const labels = labelsText.split(',').map((x) => x.trim()).filter(Boolean);
    if (labels.join(',') === m.labels.join(',')) return;
    api.patchMachine(m.id, { labels })
      .then(() => { toast.success('labels 已更新（在线机下次注册全量生效）'); invalidate('machines-all'); })
      .catch((e) => toast.error(String(e)));
  };
  const remove = () => {
    if (!confirm(`删除机器 ${m.name}？（须先停掉该机 runner）`)) return;
    api.deleteMachine(m.id)
      .then(() => { toast.success('已删除'); invalidate('machines-all'); })
      .catch((e) => toast.error(String(e instanceof Error ? e.message : e)));
  };
  const regen = () => {
    api.regenMachineToken(m.id)
      .then(() => { toast.success('已重发凭证'); invalidate('machines-all'); setShowCmd(true); })
      .catch((e) => toast.error(String(e)));
  };
  const pending = m.status === 'offline' && !m.lastActiveAt;

  return (
    <div className="rounded-md bg-bg-2/40 px-2.5 py-1.5">
      <div className="flex items-center gap-2">
        <StatusDot tone={m.status === 'online' ? 'ok' : pending ? 'human' : 'neutral'} live={m.status === 'online'} />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink-2">{m.name}</span>
        {editing ? (
          <input
            autoFocus
            value={labelsText}
            onChange={(e) => setLabelsText(e.target.value)}
            onBlur={saveLabels}
            onKeyDown={(e) => { if (e.key === 'Enter') saveLabels(); if (e.key === 'Escape') setEditing(false); }}
            className="w-40 rounded border border-accent bg-bg px-1.5 py-0.5 font-mono text-[11px] text-ink outline-none"
            placeholder="dev,npu,docker"
          />
        ) : (
          <button className="flex items-center gap-1" title="点击编辑 labels" onClick={() => { setLabelsText(m.labels.join(',')); setEditing(true); }}>
            {m.labels.length > 0 ? m.labels.map((l) => <Badge key={l} tone="neutral">{l}</Badge>) : <span className="text-[11px] text-faint underline decoration-dotted">labels</span>}
          </button>
        )}
        <span className="shrink-0 text-[11px] text-faint">
          {m.status === 'online' ? '在线' : pending ? '待接入' : '离线'}
          {m.lastActiveAt && ` · ${relTime(m.lastActiveAt)}`}
        </span>
        {m.status !== 'online' && (
          <>
            <button className="shrink-0 text-[11px] text-accent hover:underline" onClick={() => (m.enrollToken ? setShowCmd(!showCmd) : regen())}>
              接入命令
            </button>
            <button className="shrink-0 text-[11px] text-danger/80 hover:underline" onClick={remove}>
              删除
            </button>
          </>
        )}
      </div>
      {showCmd && (
        <div className="mt-2">
          <pre className="overflow-x-auto rounded-md border border-line bg-bg p-2 font-mono text-[11px] leading-relaxed text-ink-2">{installCommand(m)}</pre>
          <div className="mt-1 flex items-center gap-3">
            <button className="text-[11px] text-accent hover:underline" onClick={() => { void navigator.clipboard.writeText(installCommand(m)); toast.success('已复制'); }}>
              复制
            </button>
            <button className="text-[11px] text-dim hover:underline" onClick={regen} title="旧凭证立即失效">
              重发凭证
            </button>
            <span className="text-[10px] text-faint">目标机需 git / node ≥20 / pnpm；跑起来后本行变为在线</span>
          </div>
        </div>
      )}
    </div>
  );
}

export function MachinesSection() {
  const { data: machines = [], isLoading } = useAllMachines();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [labels, setLabels] = useState('dev');
  const [busy, setBusy] = useState(false);
  const [createdId, setCreatedId] = useState<string | null>(null);

  const create = () => {
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true);
    api.createMachine({ name: n, labels: labels.split(',').map((x) => x.trim()).filter(Boolean) })
      .then((r) => {
        toast.success('机器已创建，按接入命令启动 runner');
        setCreatedId(r.id);
        setAdding(false);
        setName('');
        invalidate('machines-all');
      })
      .catch((e) => toast.error(String(e instanceof Error ? e.message : e)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="rounded-lg border border-line p-3">
      <div className="mb-2 flex items-center justify-between">
        <h4 className="text-sm font-medium">机器</h4>
        <button className="text-xs text-accent hover:underline" onClick={() => setAdding(!adding)}>
          ＋ 添加机器
        </button>
      </div>
      {adding && (
        <div className="mb-2 flex items-center gap-2 rounded-md border border-accent/30 bg-accent/5 px-2.5 py-2">
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="机器名（如 npu-a2-01）"
            className="w-40 rounded border border-line bg-bg px-2 py-1 text-[12px] text-ink outline-none focus:border-accent" />
          <input value={labels} onChange={(e) => setLabels(e.target.value)} placeholder="labels：dev,npu,docker"
            className="flex-1 rounded border border-line bg-bg px-2 py-1 font-mono text-[12px] text-ink outline-none focus:border-accent" />
          <Button variant="default" size="sm" disabled={!name.trim() || busy} onClick={create}>创建</Button>
        </div>
      )}
      {createdId && <p className="mb-2 text-[11px] text-ok">✓ 已创建，点该行「接入命令」复制到目标机执行</p>}
      {isLoading ? (
        <p className="text-xs text-dim">加载中…</p>
      ) : machines.length === 0 ? (
        <p className="text-xs text-dim">暂无机器。点右上「添加机器」生成接入命令。</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {machines.map((m) => <MachineRow key={m.id} m={m} />)}
        </div>
      )}
    </div>
  );
}

/* ──────── 设置分区（供全屏设置页复用） ──────── */

export function TokensSection({ me, onChanged }: { me: Me; onChanged: () => void }) {
  return (
    <div className="flex flex-col gap-3">
      {FORGES.map((f) => (
        <ForgeTokenRow key={f.key} forge={f} binding={me.forges[f.key] ?? { bound: false }} onChanged={onChanged} />
      ))}
    </div>
  );
}

export function NotifySection({ me, onChanged }: { me: Me; onChanged: () => void }) {
  return <LarkWebhookRow binding={me.lark ?? { bound: false, enabled: false }} onChanged={onChanged} />;
}

export function ProvidersSection({ me, onChanged }: { me: Me; onChanged: () => void }) {
  const { data: providers = [], refetch } = useLlmProviders();
  const onAnyChanged = () => {
    onChanged();
    void refetch();
  };
  return (
    <div className="flex flex-col gap-3">
      {providers.map((p) => (
        <ProviderCard key={p.name} provider={p} me={me} onChanged={onAnyChanged} />
      ))}
      <NewProviderForm onChanged={() => void refetch()} />
    </div>
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
