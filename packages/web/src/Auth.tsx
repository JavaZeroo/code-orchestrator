import { ExternalLink } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
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
}

export const FORGES: Array<{ key: string; label: string; tokenUrl: string; hint: string }> = [
  { key: 'gitcode', label: 'GitCode', tokenUrl: 'https://gitcode.com/setting/token-classic', hint: '个人设置 → 访问令牌' },
  { key: 'github', label: 'GitHub', tokenUrl: 'https://github.com/settings/tokens', hint: 'Settings → Developer settings → PAT（勾 repo）' },
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
};

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
    <div className="flex h-full items-center justify-center">
      <div className="flex w-80 flex-col gap-3 rounded-xl border border-line bg-panel p-7">
        <h2 className="text-center text-lg font-semibold">code-orchestrator</h2>
        <div className="flex gap-1 rounded-lg bg-bg p-1">
          {(['signin', 'signup'] as const).map((m) => (
            <button
              key={m}
              className={cn('flex-1 rounded-md py-1.5 text-sm transition-colors', mode === m ? 'bg-panel-2 text-ink' : 'text-dim')}
              onClick={() => setMode(m)}
            >
              {m === 'signin' ? '登录' : '注册'}
            </button>
          ))}
        </div>
        {mode === 'signup' && <Input placeholder="姓名" value={name} onChange={(e) => setName(e.target.value)} />}
        <Input placeholder="邮箱" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <Input
          placeholder="密码（至少 8 位）"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        {error && <div className="rounded-md border border-danger/40 bg-danger/10 px-2.5 py-1.5 text-xs text-danger">{error}</div>}
        <Button variant="default" disabled={busy || !email || password.length < 8} onClick={submit}>
          {busy ? '…' : mode === 'signin' ? '登录' : '注册并登录'}
        </Button>
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

export function SettingsModal({ me, onClose, onChanged }: { me: Me; onClose: () => void; onChanged: () => void }) {
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogTitle>设置</DialogTitle>
        <p className="mb-4 text-xs text-dim">{me.user.email}</p>
        <div className="flex flex-col gap-3">
          {FORGES.map((f) => (
            <ForgeTokenRow key={f.key} forge={f} binding={me.forges[f.key] ?? { bound: false }} onChanged={onChanged} />
          ))}
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
