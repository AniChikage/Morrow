import { expect, it } from 'vitest';
import { mergeById, replaceIfChanged } from './collections';

it('merges rows by id, letting the incoming list win, and keeps first appearance without a sort', () => {
  const loaded = [
    { id: 'a', text: 'loaded a' },
    { id: 'b', text: 'loaded b' },
  ];
  const live = [
    { id: 'b', text: 'live b' },
    { id: 'c', text: 'live c' },
  ];
  // The live snapshot refreshes a loaded row and adds its own, each staying where it first appeared.
  expect(mergeById(loaded, live)).toEqual([
    { id: 'a', text: 'loaded a' },
    { id: 'b', text: 'live b' },
    { id: 'c', text: 'live c' },
  ]);
  expect(mergeById(live, loaded)).toEqual([
    { id: 'b', text: 'loaded b' },
    { id: 'c', text: 'live c' },
    { id: 'a', text: 'loaded a' },
  ]);
  expect(mergeById(loaded, live, (a, b) => b.id.localeCompare(a.id)).map((row) => row.id)).toEqual(['c', 'b', 'a']);
  expect(mergeById([], [])).toEqual([]);
});

it('keeps the previous value for an unchanged payload and takes every real change', () => {
  const previous = { runs: [{ id: 'run-1', status: 'running' }] };
  // A poll that read the same page hands back a fresh object with the same content.
  expect(replaceIfChanged(previous, structuredClone(previous))).toBe(previous);
  const changed = { runs: [{ id: 'run-1', status: 'completed' }] };
  expect(replaceIfChanged(previous, changed)).toBe(changed);
  // Order and key sets are part of the payload, so both count as a change.
  const reordered = { runs: [{ status: 'running', id: 'run-1' }] };
  expect(replaceIfChanged(previous, reordered)).toBe(reordered);
  const added = {
    runs: [
      { id: 'run-1', status: 'running' },
      { id: 'run-2', status: 'running' },
    ],
  };
  expect(replaceIfChanged(previous, added)).toBe(added);
  // The first read of an empty state still arrives, and a repeated absence stays absent.
  expect(replaceIfChanged(undefined, previous)).toBe(previous);
  expect(replaceIfChanged(null, null)).toBeNull();
});
