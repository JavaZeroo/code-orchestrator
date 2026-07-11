export type ThreadSelection = 'new' | { session: string } | { run: string };

export function parseThreadSelection(search: string): ThreadSelection {
  const params = new URLSearchParams(search);
  const sessionId = params.get('session');
  if (sessionId) return { session: sessionId };

  const runId = params.get('run');
  if (runId) return { run: runId };

  return 'new';
}

export function pushThreadSelection(
  history: Pick<History, 'pushState'>,
  currentHref: string,
  selection: ThreadSelection,
): void {
  const url = new URL(currentHref);
  url.searchParams.delete('session');
  url.searchParams.delete('run');

  if (selection !== 'new') {
    if ('session' in selection) {
      url.searchParams.set('session', selection.session);
    } else {
      url.searchParams.set('run', selection.run);
    }
  }

  history.pushState(null, '', `${url.pathname}${url.search}${url.hash}`);
}

export function listenForThreadSelection(
  source: {
    readonly location: { readonly search: string };
    addEventListener(type: 'popstate', listener: () => void): void;
    removeEventListener(type: 'popstate', listener: () => void): void;
  },
  onSelection: (selection: ThreadSelection) => void,
): () => void {
  const restoreSelection = () => onSelection(parseThreadSelection(source.location.search));
  source.addEventListener('popstate', restoreSelection);
  return () => source.removeEventListener('popstate', restoreSelection);
}
