/**
 * Keeps the previous value whenever the incoming one carries the same content, so a poll that
 * returns an unchanged payload does not re-render the page around it. `JSON.stringify` is the same
 * comparison `state/workspace.tsx`'s snapshot fingerprint uses, and the payloads here are the ones
 * the polls replace wholesale, so order and key sets are part of the comparison on purpose.
 */
export const replaceIfChanged = <T>(previous: T, next: T): T =>
  JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
