import { useCallback, useEffect, useState } from 'react';

export interface Me {
  user: { id: string; email: string; name: string };
  gitcode: { bound: boolean; login?: string };
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
  bindGitcode: (token: string) =>
    fetch('/api/me/gitcode-token', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    }).then((r) => jauth<{ ok: boolean; login: string }>(r)),
  unbindGitcode: () => fetch('/api/me/gitcode-token', { method: 'DELETE' }).then(jauth),
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
    <div className="login-page">
      <div className="login-card">
        <h2>code-orchestrator</h2>
        <div className="login-tabs">
          <button className={mode === 'signin' ? 'active' : ''} onClick={() => setMode('signin')}>
            登录
          </button>
          <button className={mode === 'signup' ? 'active' : ''} onClick={() => setMode('signup')}>
            注册
          </button>
        </div>
        {mode === 'signup' && <input placeholder="姓名" value={name} onChange={(e) => setName(e.target.value)} />}
        <input placeholder="邮箱" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input
          placeholder="密码（至少 8 位）"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        {error && <div className="error">{error}</div>}
        <button disabled={busy || !email || password.length < 8} onClick={submit}>
          {busy ? '…' : mode === 'signin' ? '登录' : '注册并登录'}
        </button>
      </div>
    </div>
  );
}

export function SettingsModal({ me, onClose, onChanged }: { me: Me; onClose: () => void; onChanged: () => void }) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const bind = () => {
    setBusy(true);
    setMsg(null);
    authApi
      .bindGitcode(token.trim())
      .then((d) => {
        setMsg(`✅ 已绑定 gitcode 账号：${d.login}`);
        setToken('');
        onChanged();
      })
      .catch((e) => setMsg(`❌ ${e instanceof Error ? e.message : e}`))
      .finally(() => setBusy(false));
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>设置</h3>
        <p className="dim">{me.user.email}</p>
        <h4>gitcode 访问令牌</h4>
        <p className="dim">
          在 gitcode.com → 个人设置 → 访问令牌 创建（
          <a href="https://gitcode.com/setting/token-classic" target="_blank" rel="noreferrer">
            直达链接
          </a>
          ）。录入后系统以你的身份创建 PR、发评论；令牌加密存储。
        </p>
        {me.gitcode.bound && (
          <p>
            当前绑定：<b>{me.gitcode.login}</b>{' '}
            <button
              className="deny"
              onClick={() => {
                void authApi.unbindGitcode().then(onChanged);
              }}
            >
              解绑
            </button>
          </p>
        )}
        <div className="token-row">
          <input
            type="password"
            placeholder={me.gitcode.bound ? '输入新令牌以更换' : '粘贴 gitcode 令牌'}
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          <button disabled={busy || token.trim().length < 10} onClick={bind}>
            {busy ? '验证中…' : '验证并绑定'}
          </button>
        </div>
        {msg && <p>{msg}</p>}
        <button className="dim-btn" onClick={onClose}>
          关闭
        </button>
      </div>
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
