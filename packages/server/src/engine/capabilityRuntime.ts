import type { RunnerParams, RunnerResult } from '@co/protocol';

export type CapabilityFeedbackSender = (
  params: RunnerParams<'session.send'>,
) => Promise<RunnerResult<'session.send'>>;

/** JSON-RPC 成功不等于会话接受消息；把 `{ok:false}` 提升为可触发 respawn 的交付失败。 */
export async function deliverCapabilityFeedback(
  send: CapabilityFeedbackSender,
  request: RunnerParams<'session.send'>,
): Promise<void> {
  const result = await send(request);
  if (!result.ok) {
    throw new Error(result.error ?? `session rejected feedback: ${request.sessionId}`);
  }
}
