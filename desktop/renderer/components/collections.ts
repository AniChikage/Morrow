/**
 * Keeps the previous value whenever the incoming one carries the same content, so a poll that
 * returns an unchanged payload does not re-render the page around it. `JSON.stringify` is the same
 * comparison `state/workspace.tsx`'s snapshot fingerprint uses, and the payloads here are the ones
 * the polls replace wholesale, so order and key sets are part of the comparison on purpose.
 */
export const replaceIfChanged = <T>(previous: T, next: T): T =>
  JSON.stringify(previous) === JSON.stringify(next) ? previous : next;

/**
 * Rows from both lists keyed by id. For an id both hold, `next` supplies the row, so a live
 * snapshot merged over loaded pages refreshes them; the position is where the id first appeared,
 * so a page of older rows placed first keeps its place. `sort` orders the result when the caller
 * needs its own order rather than the merged one.
 */
export const mergeById = <T extends { id: string }>(previous: T[], next: T[], sort?: (a: T, b: T) => number): T[] => {
  const merged = [...new Map([...previous, ...next].map((row) => [row.id, row])).values()];
  return sort ? merged.sort(sort) : merged;
};
