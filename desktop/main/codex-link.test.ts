import { describe, expect, it } from 'vitest';
import { codexAppLink } from './codex-link';
import { nativeHistoryInput, nativeMessageInput, nativeResponseInput } from './validation';

describe('native Codex conversation bridge', () => {
  it('opens the exact native thread without accepting arbitrary schemes or paths', () => {
    expect(codexAppLink({ threadId: '01a07725-b183-70d0-a9e3-2447b54f5f71', projectPath: '/tmp/a' })).toBe('codex://threads/01a07725-b183-70d0-a9e3-2447b54f5f71');
    expect(() => codexAppLink({ threadId: '../new?prompt=injected', projectPath: '/tmp/a' })).toThrow();
  });
  it('opens the native composer in the exact project directory without sending a prompt', () => {
    const url = new URL(codexAppLink({ projectPath: '/tmp/project & 文档#1' }));
    expect(url.hostname).toBe('threads');
    expect(url.pathname).toBe('/new');
    expect(url.searchParams.get('path')).toBe('/tmp/project & 文档#1');
    expect(url.searchParams.has('prompt')).toBe(false);
    expect(() => codexAppLink({ projectPath: '~/other' })).toThrow();
  });
  it('preserves exact chat text and requires a stable dispatch ID', () => {
    const text = '  第一行\n\n  ```sh\n echo hello\n  ```\n';
    expect(nativeMessageInput({ text, requestId: 'request-123' })).toEqual({ text, requestId: 'request-123' });
    expect(() => nativeMessageInput({ text, requestId: 'bad/id' })).toThrow();
    expect(() => nativeMessageInput({ text: ' ', requestId: 'request-123' })).toThrow();
    expect(() => nativeMessageInput({ text, requestId: 'request-123', model: 'override' })).toThrow();
  });
  it('bounds history and rejects malformed native responses', () => {
    expect(nativeHistoryInput({ before: 'native:turn:item', limit: 200 })).toEqual({ before: 'native:turn:item', limit: 200 });
    expect(() => nativeHistoryInput({ limit: 201 })).toThrow();
    expect(() => nativeResponseInput({ text: 'x'.repeat(65536) })).toThrow();
    expect(nativeResponseInput({ decision: 'decline' })).toEqual({ decision: 'decline' });
  });
});
