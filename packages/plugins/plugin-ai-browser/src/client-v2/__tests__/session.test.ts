import {
  decodeSessionValue,
  extractBrowserSession,
  getToolResultContent,
  normalizeLiveUrl,
  readSession,
  shouldUseScreenshotFallback,
} from '../session';

describe('V2 browser session selection', () => {
  it('restores the session ID from the persisted liveUrl value without corrupting the viewer URL', () => {
    expect(decodeSessionValue('/viewer?ws=abc#id=session-1')).toEqual({
      liveUrl: '/viewer?ws=abc',
      sessionId: 'session-1',
    });
    expect(decodeSessionValue('/viewer#existing#id=session%2F1')).toEqual({
      liveUrl: '/viewer#existing',
      sessionId: 'session/1',
    });
    expect(decodeSessionValue('/viewer')).toEqual({ liveUrl: '/viewer', sessionId: undefined });
    expect(decodeSessionValue()).toEqual({ liveUrl: undefined, sessionId: undefined });
  });

  it('normalizes the host placeholder, internal browser hosts, and secure WebSocket viewers', () => {
    expect(normalizeLiveUrl('http://browser:3000/debugger', 'https://app.test')).toBe('/ai-browser-live/');
    expect(normalizeLiveUrl('https://__AI_BROWSER_HOST__/viewer', 'https://app.test')).toBe('https://app.test/viewer');
    expect(normalizeLiveUrl('/debugger?ws=host%2Fsession', 'https://app.test')).toBe('/?wss=host%2Fsession');
    expect(normalizeLiveUrl('https://viewer.test/live?ws=host%2Fsession', 'https://app.test')).toBe(
      'https://viewer.test/live?wss=host%2Fsession',
    );
    expect(normalizeLiveUrl('javascript:alert(1)', 'https://app.test')).toBeUndefined();
    expect(shouldUseScreenshotFallback('/ai-browser-live/', 'https://app.test')).toBe(true);
    expect(shouldUseScreenshotFallback('/devtools/page/1', 'https://app.test')).toBe(true);
    expect(shouldUseScreenshotFallback('/custom-viewer', 'https://app.test')).toBe(false);
  });

  it('rejects malformed session IDs and narrows optional response fields', () => {
    expect(readSession({ id: 123 })).toBeUndefined();
    expect(readSession({ id: 'session-1', liveUrl: {}, liveViewOpened: 'true' })).toMatchObject({
      id: 'session-1',
      liveUrl: undefined,
      liveViewOpened: false,
    });
  });
});

describe('V2 browser tool results', () => {
  it('reads the actual server text result and treats an unavailable live viewer as absent', () => {
    expect(
      extractBrowserSession('Session ID: session-1\nLive Viewer: /ai-browser-live/\nCurrent URL: https://example.test'),
    ).toEqual({ id: 'session-1', liveUrl: '/ai-browser-live/', currentUrl: 'https://example.test' });
    expect(extractBrowserSession('Session ID: session-1\nLive Viewer: not available').liveUrl).toBeUndefined();
  });

  it('supports JSON results and text content blocks without losing newlines', () => {
    expect(
      extractBrowserSession(
        getToolResultContent({
          result: { content: [{ type: 'text', text: 'Session ID: session-1\nCurrent URL: https://example.test' }] },
        }),
      ).id,
    ).toBe('session-1');
    expect(
      extractBrowserSession(getToolResultContent({ content: { id: 'session-1', liveUrl: '/viewer' } })),
    ).toMatchObject({ id: 'session-1', liveUrl: '/viewer' });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => getToolResultContent({ content: cyclic })).not.toThrow();
  });
});
