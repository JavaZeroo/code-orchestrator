import { describe, expect, it } from 'vitest';
import {
  conversationSearchSnippet,
  mapConversationSearchRows,
  type ConversationSearchDbRow,
} from './conversationSearch';

function row(overrides: Partial<ConversationSearchDbRow> = {}): ConversationSearchDbRow {
  return {
    eventSeq: 1,
    sessionId: 'session-1',
    sessionTitle: 'Release investigation',
    sessionCwd: '/work/release',
    sessionArchivedAt: null,
    runId: null,
    runTitle: null,
    defName: null,
    runArchivedAt: null,
    projectId: 'project-1',
    role: 'agent',
    text: 'The hidden regression is in the deployment handshake.',
    ...overrides,
  };
}

describe('conversation content search result mapping', () => {
  it('returns a useful bounded snippet around a match in a long message', () => {
    const text = `${'prefix '.repeat(40)}needle phrase${' suffix'.repeat(40)}`;
    const snippet = conversationSearchSnippet(text, 'needle phrase');

    expect(snippet).toContain('needle phrase');
    expect(snippet).toMatch(/^…/);
    expect(snippet).toMatch(/…$/);
    expect(snippet.length).toBeLessThanOrEqual(182);
  });

  it('maps standalone and archived workflow messages to navigable parent threads', () => {
    const results = mapConversationSearchRows([
      row({ eventSeq: 8, sessionId: 'node-session-old', runId: 'run-1', runTitle: 'Deploy release', role: 'user' }),
      row({
        eventSeq: 12,
        sessionId: 'node-session-new',
        runId: 'run-1',
        runTitle: 'Deploy release',
        runArchivedAt: new Date('2026-07-13T10:00:00Z'),
      }),
      row({ eventSeq: 10, sessionId: 'session-2', sessionTitle: null, sessionCwd: '/work/incident' }),
    ], 'regression');

    expect(results).toEqual([
      expect.objectContaining({
        kind: 'run', id: 'run-1', sessionId: 'node-session-new', title: 'Deploy release', archived: true, eventSeq: 12,
      }),
      expect.objectContaining({
        kind: 'session', id: 'session-2', title: 'incident', archived: false, eventSeq: 10,
      }),
    ]);
  });
});
