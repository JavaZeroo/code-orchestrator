import { describe, expect, it, vi } from 'vitest';
import { listenForThreadSelection, parseThreadSelection, pushThreadSelection } from './urlSelection';

describe('thread URL selection', () => {
  it('opens an encoded session or run from the query string', () => {
    expect(parseThreadSelection('?session=session%2Fshared%20thread')).toEqual({ session: 'session/shared thread' });
    expect(parseThreadSelection('?run=run%2Frelease%20pipeline')).toEqual({ run: 'run/release pipeline' });
    expect(parseThreadSelection('?project=widgets')).toBe('new');
  });

  it('pushes mutually exclusive history entries and clears them for a new conversation', () => {
    const pushState = vi.fn();
    const history = { pushState };

    pushThreadSelection(
      history,
      'https://orchestrator.example/conversations?project=widgets&run=old-run#activity',
      { session: 'session/shared thread' },
    );
    expect(pushState).toHaveBeenNthCalledWith(
      1,
      null,
      '',
      '/conversations?project=widgets&session=session%2Fshared+thread#activity',
    );

    pushThreadSelection(
      history,
      'https://orchestrator.example/conversations?project=widgets&session=old-session#activity',
      { run: 'run/release pipeline' },
    );
    expect(pushState).toHaveBeenNthCalledWith(
      2,
      null,
      '',
      '/conversations?project=widgets&run=run%2Frelease+pipeline#activity',
    );

    pushThreadSelection(
      history,
      'https://orchestrator.example/conversations?project=widgets&session=old-session#activity',
      'new',
    );
    expect(pushState).toHaveBeenNthCalledWith(3, null, '', '/conversations?project=widgets#activity');
  });

  it('restores the current URL selection on Back and Forward navigation', () => {
    const listeners = new Set<() => void>();
    const source = {
      location: { search: '?session=session%2Ffirst' },
      addEventListener: vi.fn((_type: 'popstate', listener: () => void) => listeners.add(listener)),
      removeEventListener: vi.fn((_type: 'popstate', listener: () => void) => listeners.delete(listener)),
    };
    const onSelection = vi.fn();

    const stop = listenForThreadSelection(source, onSelection);
    source.location.search = '?run=run%2Fsecond';
    for (const listener of listeners) listener();
    expect(onSelection).toHaveBeenLastCalledWith({ run: 'run/second' });

    source.location.search = '';
    for (const listener of listeners) listener();
    expect(onSelection).toHaveBeenLastCalledWith('new');

    stop();
    expect(listeners).toHaveLength(0);
  });
});
