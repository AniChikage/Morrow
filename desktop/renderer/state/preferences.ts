/**
 * View preferences, kept in this browser profile's storage and nowhere else. A read falls back to
 * the legacy key the app wrote before the Morrow rename, so a preference set then still applies; a
 * write only ever uses the current key. Every access is wrapped, because touching `localStorage` at
 * all throws in a private window or with site data blocked, and no view preference is worth a
 * failed render: a read then reports nothing saved and a write applies for this session only.
 */
export function readPreference(key: string, legacyKey?: string): string | null {
  try {
    return localStorage.getItem(key) ?? (legacyKey ? localStorage.getItem(legacyKey) : null);
  } catch {
    return null;
  }
}
export function writePreference(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* The preference holds for this session; nothing here is worth interrupting the interface. */
  }
}
