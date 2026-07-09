/**
 * Agent 后端适配器（design-v2 Q5/Q8）：memory = 后端原生文件，co 只负责持久化+同步。
 * 每个后端声明「它的记忆文件在容器内哪个路径」；co 把持久卷挂在那里（跨容器持久），
 * 跨机一致（git 中心仓）留 v2。可插拔——opencode 等以后加一个 backend，co 同步机制不变。
 */

export interface AgentBackend {
  name: string;
  /**
   * 容器内该后端的记忆目录（会话 cwd=/workspace 下）。
   * Claude Code：`~/.claude/projects/<cwd-slug>/memory`，cwd=/workspace → slug `-workspace`。
   * Codex：`~/.codex/memories`。AGENTS.md 在仓内、随 worktree 走；这里只管仓外沉淀。
   */
  memoryContainerPath: string;
}

const claudeCode: AgentBackend = {
  name: 'claude',
  memoryContainerPath: '/root/.claude/projects/-workspace/memory',
};

const codex: AgentBackend = {
  name: 'codex',
  memoryContainerPath: '/root/.codex/memories',
};

const registry: Record<string, AgentBackend> = {
  [claudeCode.name]: claudeCode,
  [codex.name]: codex,
};

export function getAgentBackend(name: string): AgentBackend | null {
  return registry[name] ?? null;
}
