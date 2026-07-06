/**
 * 飞书消息格式化：将系统事件渲染为飞书群机器人交互式卡片。
 *
 * 纯函数——不读 env、不做 IO，便于单测。
 * 四类事件各生成一张 msg_type:'interactive' 卡片，其余类型返回 null。
 *
 * 自测点：
 *   formatLarkEvent({ type:'approval.requested', payload:{id:'a1',kind:'tool',title:'审批'}}, {baseUrl:'http://x'})
 *     → msg_type:'interactive', header.template='orange', 底部有按钮
 *   formatLarkEvent({ type:'approval.requested', payload:{id:'a1',kind:'gate',title:'门禁'}})
 *     → header.template='orange', 无按钮
 *   formatLarkEvent({ type:'run.finished', runId:'run_abc12345', payload:{status:'done'}})
 *     → header.template='green', 正文含 "abc12345"
 *   formatLarkEvent({ type:'run.finished', runId:'run_abc12345', payload:{status:'failed'}})
 *     → header.template='red'
 *   formatLarkEvent({ type:'run.finished', runId:'run_abc12345', payload:{status:'cancelled'}})
 *     → header.template='grey'
 *   formatLarkEvent({ type:'nudge.sent', payload:{message:'请处理', attempt:2}})
 *     → header.template='blue', 正文含 "第 2 次"
 *   formatLarkEvent({ type:'requirement.triggered', payload:{repo:'my/repo', issue:'42', title:'feat'}})
 *     → header.template='turquoise', 正文含 "my/repo#42"
 *   formatLarkEvent({ type:'unknown.event', payload:{}})
 *     → null
 */

export interface LarkMessage {
  msg_type: 'interactive' | 'text';
  card?: unknown;
  content?: unknown;
}

export interface NotifiableEvent {
  type: string;
  runId?: string;
  sessionId?: string;
  payload: unknown;
}

// ---------- Lark 卡片构建 helpers ----------

interface CardBlock {
  header: { title: { tag: 'plain_text'; content: string }; template: string };
  elements: unknown[];
  config?: { wide_screen_mode: boolean };
}

type ColorTemplate = 'orange' | 'green' | 'red' | 'grey' | 'blue' | 'turquoise';

function md(text: string): unknown {
  return { tag: 'markdown', content: text };
}

function hr(): unknown {
  return { tag: 'hr' };
}

function actionButton(btnUrl: string, text = '打开控制台'): unknown {
  return {
    tag: 'action',
    actions: [
      {
        tag: 'button',
        text: { tag: 'plain_text', content: text },
        url: btnUrl,
        type: 'primary',
      },
    ],
  };
}

function buildCard(
  title: string,
  template: ColorTemplate,
  bodyLines: string[],
  baseUrl?: string,
): LarkMessage {
  const card: CardBlock = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: title },
      template,
    },
    elements: bodyLines.map((line) => md(line)),
  };

  // 正文 + 分割线 + 按钮（有 baseUrl 时）
  if (baseUrl) {
    (card.elements as unknown[]).push(hr());
    (card.elements as unknown[]).push(actionButton(baseUrl));
  }

  return { msg_type: 'interactive', card };
}

/** 从 payload 安全读字符串字段 */
function str(val: unknown): string {
  return val == null ? '' : String(val);
}

/** 归一化 payload 访问 */
function getPayload(evt: NotifiableEvent): Record<string, unknown> {
  return (evt.payload as Record<string, unknown>) ?? {};
}

// ---------- 各事件类型卡片生成 ----------

function formatApprovalRequested(evt: NotifiableEvent, baseUrl?: string): LarkMessage {
  const p = getPayload(evt);
  const kind = str(p.kind) || 'unknown';
  const title = str(p.title) || '审批请求';
  const kindLabel = kind === 'gate' ? '工作流门禁' : kind === 'tool' ? '工具调用' : kind;

  const lines = [`**${title}**`, '', `类型：${kindLabel}`];
  if (p.id) lines.push(`审批 ID：\`${str(p.id)}\``);
  if (evt.sessionId) lines.push(`会话 ID：\`${evt.sessionId}\``);
  if (evt.runId) lines.push(`Run ID：\`${evt.runId}\``);

  return buildCard('待审批', 'orange', lines, baseUrl);
}

function formatRunFinished(evt: NotifiableEvent, baseUrl?: string): LarkMessage {
  const p = getPayload(evt);
  const status = str(p.status) || 'unknown';
  const shortRunId = evt.runId ? evt.runId.slice(0, 8) : 'N/A';

  const statusLabel: Record<string, string> = {
    done: '已完成',
    failed: '失败',
    cancelled: '已取消',
  };
  const templateMap: Record<string, ColorTemplate> = {
    done: 'green',
    failed: 'red',
    cancelled: 'grey',
  };
  const color = templateMap[status] ?? 'grey';
  const label = statusLabel[status] ?? status;

  const lines = [`**工作流 ${label}**`, '', `Run：\`${shortRunId}\``];
  if (evt.runId) lines.push(`完整 Run ID：\`${evt.runId}\``);

  return buildCard(`工作流 ${label}`, color, lines, baseUrl);
}

function formatNudgeSent(evt: NotifiableEvent, baseUrl?: string): LarkMessage {
  const p = getPayload(evt);
  const message = str(p.message) || '(无消息)';
  const attempt = p.attempt != null ? `第 ${p.attempt} 次` : '';

  const lines = [`**门禁回流提醒**`, '', message];
  if (attempt) lines.push(`尝试次数：${attempt}`);
  if (evt.sessionId) lines.push(`会话 ID：\`${evt.sessionId}\``);
  if (evt.runId) lines.push(`Run ID：\`${evt.runId}\``);

  return buildCard('门禁回流提醒', 'blue', lines, baseUrl);
}

function formatRequirementTriggered(evt: NotifiableEvent, baseUrl?: string): LarkMessage {
  const p = getPayload(evt);
  const repo = str(p.repo);
  const issue = str(p.issue);
  const title = str(p.title) || '(无标题)';

  const repoIssue = repo && issue ? `${repo}#${issue}` : repo || issue || '';
  const sub = repoIssue ? `${repoIssue} ${title}` : title;

  const lines = [`**需求已触发工作流**`, '', sub];
  if (p.triggerId) lines.push(`Trigger ID：\`${str(p.triggerId)}\``);

  return buildCard('需求已触发', 'turquoise', lines, baseUrl);
}

// ---------- 主入口 ----------

/**
 * 将系统事件格式化为飞书消息。
 * 仅识别四类事件：approval.requested / run.finished / nudge.sent / requirement.triggered。
 * 其余类型返回 null。
 *
 * @param evt  事件对象（OrchEvent 子集）
 * @param opts 可选：baseUrl 用于卡片底部按钮链接
 * @returns LarkMessage（msg_type:'interactive'）或 null
 */
export function formatLarkEvent(evt: NotifiableEvent, opts?: { baseUrl?: string }): LarkMessage | null {
  const baseUrl = opts?.baseUrl;

  switch (evt.type) {
    case 'approval.requested':
      return formatApprovalRequested(evt, baseUrl);
    case 'run.finished':
      return formatRunFinished(evt, baseUrl);
    case 'nudge.sent':
      return formatNudgeSent(evt, baseUrl);
    case 'requirement.triggered':
      return formatRequirementTriggered(evt, baseUrl);
    default:
      return null;
  }
}
