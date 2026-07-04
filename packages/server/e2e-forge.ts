/**
 * 一次性验证脚本（用后可删）：用绑定的 per-user token 在用户自己命名空间下
 * 完成 repo/branch/file/PR 的写路径验证。不触碰上游 mindspore/mindformers。
 * 运行：cd packages/server && tsx --env-file=.env e2e-forge.ts [--comment <pr>]
 */

import { gitcode } from './src/forge/gitcode';
import { anyForgeToken } from './src/forge/tokens';

const REPO_NAME = 'co-orchestrator-e2e';
const UA = 'Mozilla/5.0 (X11; Linux aarch64) code-orchestrator-e2e/0.1';

const token = await anyForgeToken();
if (!token) {
  throw new Error('没有可用 token');
}

async function raw(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown; text: string }> {
  const res = await fetch(`https://api.gitcode.com/api/v5${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'user-agent': UA,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* keep text */
  }
  return { status: res.status, json, text: text.slice(0, 400) };
}

const who = await gitcode.getUser(token);
console.log(`[1] whoami: ${who.login} (id=${who.id})`);
const owner = who.login;
const repo = `${owner}/${REPO_NAME}`;

// --list 模式：看评论列表原始结构
const listIdx = process.argv.indexOf('--list');
if (listIdx > 0) {
  const pr = Number(process.argv[listIdx + 1]);
  const res = await raw('GET', `/repos/${repo}/pulls/${pr}/comments?per_page=100`);
  console.log(`[list] status=${res.status}`);
  console.log(JSON.stringify(res.json, null, 1).slice(0, 1200));
  process.exit(0);
}

// --comment 模式：只发 PR 评论（Phase B 用）
const commentIdx = process.argv.indexOf('--comment');
if (commentIdx > 0) {
  const pr = Number(process.argv[commentIdx + 1]);
  const c = await gitcode.createPullComment(repo, pr, '【评审意见】变量命名建议更语义化：`data` → `weight_meta`。请处理。', token);
  console.log(`[comment] posted id=${c.id} on ${repo}!${pr}`);
  process.exit(0);
}

// [2] ensure 测试仓
const repoCheck = await raw('GET', `/repos/${repo}`);
if (repoCheck.status === 200) {
  console.log(`[2] repo 已存在: ${repo}`);
} else {
  const created = await raw('POST', '/user/repos', {
    name: REPO_NAME,
    description: 'code-orchestrator 端到端验证仓（可删除）',
    private: true,
    auto_init: true,
  });
  console.log(`[2] create repo → ${created.status}: ${created.text.slice(0, 120)}`);
  if (created.status >= 300) {
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 3000));
}

// [3] 建分支
const branch = `e2e-${Date.now()}`;
const br = await raw('POST', `/repos/${repo}/branches`, { refs: 'main', branch_name: branch });
if (br.status >= 300) {
  // 默认分支可能是 master
  const br2 = await raw('POST', `/repos/${repo}/branches`, { refs: 'master', branch_name: branch });
  console.log(`[3] create branch(${branch}) from master → ${br2.status}: ${br2.text.slice(0, 100)}`);
  if (br2.status >= 300) {
    process.exit(1);
  }
} else {
  console.log(`[3] create branch(${branch}) from main → ${br.status}`);
}

// [4] 分支上提交一个文件
const file = await raw('POST', `/repos/${repo}/contents/e2e-${branch}.md`, {
  content: Buffer.from(`# e2e\n验证提交 @ ${new Date().toISOString()}\n`).toString('base64'),
  message: 'e2e: add verification file',
  branch,
});
console.log(`[4] create file → ${file.status}: ${file.status >= 300 ? file.text.slice(0, 150) : 'ok'}`);
if (file.status >= 300) {
  process.exit(1);
}

// [5] 用我们的客户端建 PR（ensure 语义）
const base = br.status < 300 ? 'main' : 'master';
const pr = await gitcode.createPull(
  repo,
  { title: `e2e 验证 PR（${branch}）`, head: branch, base, body: 'code-orchestrator 全链路验证：poller 跟踪 + nudge 注入。' },
  token,
);
console.log(`[5] PR → !${pr.number} (existed=${pr.existed}) https://gitcode.com/${repo}/merge_requests/${pr.number}`);
console.log(JSON.stringify({ repo, number: pr.number }));
