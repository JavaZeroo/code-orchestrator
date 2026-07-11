import type { RunRow } from '../api';

export const RUN_TITLE_MAX_LENGTH = 120;

export function normalizeRunTitle(value: string): string | null {
  const title = value.trim();
  return title.length > 0 && title.length <= RUN_TITLE_MAX_LENGTH ? title : null;
}

export function runDisplayTitle(
  run: Pick<RunRow, 'title' | 'defName' | 'defId'>,
  definitionName?: string | null,
): string {
  return run.title ?? definitionName ?? run.defName ?? run.defId.slice(0, 8);
}

export function runMatchesSearch(
  run: Pick<RunRow, 'id' | 'title' | 'defName' | 'defId'>,
  query: string,
): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return [run.title, run.defName, run.defId, run.id]
    .some((value) => value?.toLowerCase().includes(normalized));
}
