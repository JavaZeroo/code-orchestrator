import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { cancelRejection, confirmRejection, RejectionFeedback } from './RejectionFeedback';

describe('RejectionFeedback', () => {
  it('starts with a reject action and does not submit a decision', () => {
    const onDecide = vi.fn();
    const markup = renderToStaticMarkup(
      <RejectionFeedback approvalId="approval-1" onDecide={onDecide} />,
    );

    expect(markup).toContain('拒绝');
    expect(markup).not.toContain('拒绝原因');
    expect(onDecide).not.toHaveBeenCalled();
  });

  it('confirms a non-empty trimmed reason with exact denial arguments', () => {
    const onDecide = vi.fn();

    expect(confirmRejection('approval-1', '  Change the deployment target.  ', onDecide)).toBe(true);
    expect(onDecide).toHaveBeenCalledWith('approval-1', 'deny', 'Change the deployment target.');
  });

  it('does not confirm empty feedback', () => {
    const onDecide = vi.fn();

    expect(confirmRejection('approval-1', '   ', onDecide)).toBe(false);
    expect(onDecide).not.toHaveBeenCalled();
  });

  it('cancels without deciding and clears the draft', () => {
    const onDecide = vi.fn();

    expect(cancelRejection()).toEqual({ editing: false, reason: '' });
    expect(onDecide).not.toHaveBeenCalled();
  });
});
