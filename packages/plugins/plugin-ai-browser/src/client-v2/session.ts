export type BrowserSession = {
  id: string;
  title?: string;
  liveUrl?: string;
  currentUrl?: string;
  startUrl?: string;
  status?: string;
  conversationId?: string;
  liveViewOpened?: boolean;
};

export function readSession(value: unknown): BrowserSession | undefined {
  if (!value || typeof value !== 'object') return;
  const source = value as Record<string, unknown>;
  if (typeof source.id !== 'string' || !source.id) return;
  const text = (key: string) => {
    const value = source[key];
    return typeof value === 'string' ? value : undefined;
  };
  return {
    id: source.id,
    title: text('title'),
    liveUrl: text('liveUrl'),
    currentUrl: text('currentUrl'),
    startUrl: text('startUrl'),
    status: text('status'),
    conversationId: text('conversationId'),
    liveViewOpened: source.liveViewOpened === true,
  };
}

export function decodeSessionValue(value?: string) {
  if (!value) return { liveUrl: value, sessionId: undefined };
  const marker = value.lastIndexOf('#id=');
  if (marker < 0) return { liveUrl: value, sessionId: undefined };
  let sessionId = value.slice(marker + 4);
  try {
    sessionId = decodeURIComponent(sessionId);
  } catch {
    /* Preserve old unescaped session identifiers. */
  }
  return { liveUrl: value.slice(0, marker), sessionId: sessionId || undefined };
}

export function normalizeLiveUrl(url: string | undefined, origin: string) {
  if (!url) return;
  const current = new URL(origin);
  const normalized = url.replace(/\/debugger\/?(\?|#|$)/, '/$1').replace(/__AI_BROWSER_HOST__/g, current.host);
  try {
    const parsed = new URL(normalized, origin);
    if (!['http:', 'https:'].includes(parsed.protocol)) return;
    if (['browser', 'browserless'].includes(parsed.hostname)) return '/ai-browser-live/';
    if (current.protocol === 'https:' && parsed.searchParams.has('ws')) {
      const ws = parsed.searchParams.get('ws');
      parsed.searchParams.delete('ws');
      parsed.searchParams.set('wss', ws || '');
      return parsed.origin === current.origin ? `${parsed.pathname}${parsed.search}${parsed.hash}` : parsed.href;
    }
  } catch {
    return;
  }
  return normalized;
}

export function shouldUseScreenshotFallback(url: string | undefined, origin: string) {
  if (!url) return true;
  try {
    const path = new URL(url, origin).pathname.replace(/\/+$/, '/');
    return path === '/ai-browser-live/' || path.includes('/devtools/');
  } catch {
    return false;
  }
}

export function getToolResultContent(toolCall: { content?: unknown; result?: unknown }): string {
  const result = toolCall.result;
  const content =
    toolCall.content ?? (result && typeof result === 'object' && 'content' in result ? result.content : result);
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content
      .map((item) =>
        item && typeof item === 'object' && 'text' in item && typeof item.text === 'string' ? item.text : '',
      )
      .join('\n');
  if (content == null) return '';
  try {
    return JSON.stringify(content) || '';
  } catch {
    return String(content);
  }
}

export function extractBrowserSession(content: string): Partial<BrowserSession> {
  let parsed: Record<string, unknown> = {};
  try {
    const data: unknown = JSON.parse(content);
    if (data && typeof data === 'object') parsed = data as Record<string, unknown>;
  } catch {
    /* Browser tools also return a human-readable result. */
  }
  const liveUrl = content.match(/Live Viewer:\s*(\S+)/)?.[1] || parsed.liveUrl;
  return {
    id: content.match(/Session ID:\s*([a-zA-Z0-9_-]+)/)?.[1] || (typeof parsed.id === 'string' ? parsed.id : undefined),
    liveUrl: typeof liveUrl === 'string' && /^(https?:\/\/|\/)/.test(liveUrl) ? liveUrl : undefined,
    currentUrl:
      content.match(/Current URL:\s*(\S+)/)?.[1] ||
      (typeof parsed.currentUrl === 'string' ? parsed.currentUrl : undefined),
  };
}
