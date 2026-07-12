import { useState } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/primitives';

export type ApprovalDecisionHandler = (
  id: string,
  behavior: 'allow' | 'deny',
  message?: string,
) => void;

export interface RejectionFeedbackState {
  editing: boolean;
  reason: string;
}

export function cancelRejection(): RejectionFeedbackState {
  return { editing: false, reason: '' };
}

export function confirmRejection(
  id: string,
  reason: string,
  onDecide: ApprovalDecisionHandler,
): boolean {
  const message = reason.trim();
  if (!message) return false;
  onDecide(id, 'deny', message);
  return true;
}

export function RejectionFeedback({ approvalId, onDecide }: {
  approvalId: string;
  onDecide: ApprovalDecisionHandler;
}) {
  const [state, setState] = useState<RejectionFeedbackState>(cancelRejection);
  const { editing, reason } = state;

  const cancel = () => {
    setState(cancelRejection());
  };

  if (!editing) {
    return (
      <Button variant="danger" size="sm" onClick={() => setState({ editing: true, reason: '' })}>
        拒绝
      </Button>
    );
  }

  return (
    <div className="flex min-w-64 flex-1 flex-wrap items-center gap-2">
      <Input
        autoFocus
        aria-label="拒绝原因"
        value={reason}
        placeholder="说明拒绝原因或需要修改的内容"
        className="min-w-48 flex-1"
        onChange={(event) => setState({ editing: true, reason: event.target.value })}
        onKeyDown={(event) => {
          if (event.key === 'Escape') cancel();
          if (event.key === 'Enter' && confirmRejection(approvalId, reason, onDecide)) cancel();
        }}
      />
      <Button
        variant="danger"
        size="sm"
        disabled={!reason.trim()}
        onClick={() => {
          if (confirmRejection(approvalId, reason, onDecide)) cancel();
        }}
      >
        确认拒绝
      </Button>
      <Button variant="ghost" size="sm" onClick={cancel}>取消</Button>
    </div>
  );
}
