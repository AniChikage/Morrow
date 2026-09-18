// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { readPreference, writePreference } from './preferences';

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

it('reads the legacy key when the current one is unset and only ever writes the current one', () => {
  localStorage.setItem('nh:sidebar', 'closed');
  expect(readPreference('morrow:sidebar', 'nh:sidebar')).toBe('closed');
  writePreference('morrow:sidebar', 'open');
  expect(readPreference('morrow:sidebar', 'nh:sidebar')).toBe('open');
  // The legacy value is left where it is; nothing rewrites another app's key.
  expect(localStorage.getItem('nh:sidebar')).toBe('closed');
  // An empty saved value is a value, not a missing preference.
  writePreference('morrow:empty', '');
  expect(readPreference('morrow:empty', 'nh:empty')).toBe('');
  expect(readPreference('morrow:unset')).toBeNull();
  expect(readPreference('morrow:unset', 'nh:unset')).toBeNull();
});

it('reports nothing saved instead of failing when storage itself throws', () => {
  const blocked = () => {
    throw new DOMException('access denied', 'SecurityError');
  };
  vi.stubGlobal('localStorage', { getItem: blocked, setItem: blocked });
  expect(readPreference('morrow:sidebar', 'nh:sidebar')).toBeNull();
  expect(() => writePreference('morrow:sidebar', 'open')).not.toThrow();
});
