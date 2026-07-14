export interface ThreadOrder<T> {
  isWaiting: (thread: T) => boolean;
  pinnedAt: (thread: T) => string | null;
  activeAt: (thread: T) => string;
}

/** Urgent threads always win; operator-pinned threads form the next persistent section. */
export function partitionThreadList<T>(threads: T[], order: ThreadOrder<T>): {
  waiting: T[];
  pinned: T[];
  rest: T[];
} {
  const waiting = threads.filter(order.isWaiting);
  const nonWaiting = threads.filter((thread) => !order.isWaiting(thread));
  const pinned = nonWaiting
    .filter((thread) => order.pinnedAt(thread) !== null)
    .sort((a, b) => new Date(order.pinnedAt(b)!).getTime() - new Date(order.pinnedAt(a)!).getTime());
  const rest = nonWaiting
    .filter((thread) => order.pinnedAt(thread) === null)
    .sort((a, b) => new Date(order.activeAt(b)).getTime() - new Date(order.activeAt(a)).getTime());
  return { waiting, pinned, rest };
}
