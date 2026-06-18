import React, { useEffect, useState } from 'react';
import { Card, Spin, Typography, Empty } from 'antd';
import { useFieldSchema } from '@formily/react';
import { useT } from './locale';

const { Text } = Typography;
import { SessionSelect } from './SessionSelect';

export interface AIBrowserBlockProps {
  liveUrl?: string;
  sessionId?: string;
  currentUrl?: string;
  title?: string;
  height?: number | string;
}

function normalizeLiveUrl(url?: string) {
  if (!url) return url;
  const normalized = url.replace(/\/debugger\/?(\?|#|$)/, '/$1');
  const withHost = normalized.replace(/__AI_BROWSER_HOST__/g, window.location.host);
  try {
    const parsed = new URL(withHost, window.location.origin);
    if (['browser', 'browserless'].includes(parsed.hostname)) {
      return '/ai-browser-live/';
    }
    if (window.location.protocol === 'https:' && parsed.searchParams.has('ws')) {
      const ws = parsed.searchParams.get('ws');
      parsed.searchParams.delete('ws');
      parsed.searchParams.set('wss', ws || '');
      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
  } catch {
    // Keep relative URLs as-is.
  }
  return withHost;
}

function shouldUseScreenshotFallback(url?: string) {
  if (!url) return true;
  try {
    const parsed = new URL(url, window.location.origin);
    const normalizedPath = parsed.pathname.replace(/\/+$/, '/');
    return normalizedPath === '/ai-browser-live/' || normalizedPath.includes('/devtools/');
  } catch {
    return false;
  }
}

import { useApp } from '@nocobase/client-v2';

/**
 * AIBrowserBlock — readonly iframe/live viewer for the browser session.
 * Renders as a Card with an iframe pointing to the live URL.
 */
export const AIBrowserBlock: React.FC<AIBrowserBlockProps> = (props) => {
  const t = useT();
  const api = useApp().apiClient;
  const fieldSchema = useFieldSchema();
  const [liveUrl, setLiveUrl] = useState(props.liveUrl || fieldSchema?.['x-component-props']?.liveUrl);
  const [sessionId, setSessionId] = useState(props.sessionId || fieldSchema?.['x-component-props']?.sessionId);
  const [currentUrl, setCurrentUrl] = useState(props.currentUrl || fieldSchema?.['x-component-props']?.currentUrl);
  const [screenshot, setScreenshot] = useState<string>();
  const height = props.height || fieldSchema?.['x-component-props']?.height || 640;
  const normalizedLiveUrl = normalizeLiveUrl(liveUrl);
  const useScreenshotFallback = shouldUseScreenshotFallback(normalizedLiveUrl);

  useEffect(() => {
    if (sessionId && sessionId !== 'unknown') {
      api.resource('aiBrowser').markLiveViewOpened({
        values: { sessionId },
      }).catch(console.error);
    }
  }, [sessionId, api]);

  useEffect(() => {
    const customEventName = 'ai-browser:set-live-url';
    const handleSetUrl = (e: CustomEvent) => {
      if (e.detail?.liveUrl) {
        setLiveUrl(e.detail.liveUrl);
      }
      if (e.detail?.sessionId) {
        setSessionId(e.detail.sessionId);
      }
      if (e.detail?.currentUrl) {
        setCurrentUrl(e.detail.currentUrl);
      }
    };
    window.addEventListener(customEventName, handleSetUrl as EventListener);
    return () => {
      window.removeEventListener(customEventName, handleSetUrl as EventListener);
    };
  }, []);

  useEffect(() => {
    if (props.liveUrl) setLiveUrl(props.liveUrl);
    if (props.sessionId) setSessionId(props.sessionId);
    if (props.currentUrl) setCurrentUrl(props.currentUrl);
  }, [props.liveUrl, props.sessionId, props.currentUrl]);

  useEffect(() => {
    if (!useScreenshotFallback || !sessionId || sessionId === 'unknown') {
      return;
    }

    let cancelled = false;
    const loadScreenshot = async () => {
      try {
        const res = await api.resource('aiBrowser').getScreenshot({ filterByTk: sessionId });
        const data = res?.data?.data || res?.data || {};
        if (cancelled) return;
        if (data.screenshot) {
          setScreenshot(`data:image/jpeg;base64,${data.screenshot}`);
        }
        if (data.currentUrl) {
          setCurrentUrl(data.currentUrl);
        }
      } catch {
        // Keep the last rendered frame while the session is transitioning.
      }
    };

    loadScreenshot();
    const timer = window.setInterval(loadScreenshot, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [api, sessionId, useScreenshotFallback]);

  return (
    <Card
      bodyStyle={{ padding: 0, position: 'relative', overflow: 'hidden' }}
      title={props.title || currentUrl || sessionId || t('Readonly Browser')}
    >
      {useScreenshotFallback && sessionId && sessionId !== 'unknown' ? (
        <div
          style={{
            height,
            width: '100%',
            background: '#111',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'hidden',
          }}
        >
          {screenshot ? (
            <img
              src={screenshot}
              alt={t('Readonly Browser')}
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'contain',
                display: 'block',
              }}
            />
          ) : (
            <Spin tip={t('Browser is starting...')} />
          )}
        </div>
      ) : liveUrl ? (
        <iframe
          src={normalizedLiveUrl}
          style={{
            width: '100%',
            height,
            border: 'none',
            display: 'block',
          }}
          sandbox="allow-same-origin allow-scripts"
          title={t('Readonly Browser')}
          onLoad={(e) => {
            try {
              const iframe = e.target as HTMLIFrameElement;
              const doc = iframe.contentDocument;
              if (!doc) return;

              if (normalizedLiveUrl?.includes('/devtools/')) {
                const hideCss = `
                  /* Hide EVERYTHING except screencast */
                  .tabbed-pane-header,
                  .split-widget-sidebar,
                  .split-widget-resizer,
                  .inspector-view-tabbed-pane,
                  .drawer-view,
                  .vbox:not(.screencast),
                  [aria-label="Quick Console"],
                  [aria-label="Elements panel"],
                  [aria-label="Network panel"],
                  devtools-tabbed-pane:not(.screencast) {
                    display: none !important;
                    opacity: 0 !important;
                    width: 0 !important;
                    flex: 0 !important;
                  }
                  
                  /* Force main split widget to 100% */
                  .split-widget-main,
                  [slot="main"],
                  .screencast,
                  .screencast-app,
                  #main-panels {
                    display: block !important;
                    width: 100% !important;
                    flex: 1 1 auto !important;
                    min-width: 100% !important;
                    height: 100% !important;
                  }
                `;
                const style = doc.createElement('style');
                style.textContent = hideCss;
                doc.head.appendChild(style);

                // Chrome DevTools uses Shadow DOM. We must inject styles into all shadow roots.
                const injectedShadows = new WeakSet();
                const injectShadows = (node: Node) => {
                  if (node instanceof Element && node.shadowRoot && !injectedShadows.has(node.shadowRoot)) {
                    injectedShadows.add(node.shadowRoot);
                    const s = doc.createElement('style');
                    s.textContent = hideCss;
                    node.shadowRoot.appendChild(s);
                  }
                  node.childNodes.forEach(injectShadows);
                  if (node instanceof Element && node.shadowRoot) {
                    node.shadowRoot.childNodes.forEach(injectShadows);
                  }
                };

                // Periodically scan and inject (since DevTools UI loads dynamically)
                const interval = setInterval(() => {
                  if (!iframe.contentDocument) {
                    clearInterval(interval);
                    return;
                  }
                  injectShadows(iframe.contentDocument.body);
                }, 500);

                return;
              }

              const style = doc.createElement('style');
              style.textContent = `
                header, #side-nav, #code, #settings, #resize-main, #runner { display: none !important; }
                #editor { left: 0 !important; top: 0 !important; right: 0 !important; bottom: 0 !important; border: none !important; }
                #sessions { display: flex !important; width: 100% !important; height: 100% !important; }
                /* Force hide any code editors that might leak out */
                .CodeMirror { display: none !important; }
              `;
              doc.head.appendChild(style);
              
              // Auto-switch to sessions tab
              const radio = doc.getElementById('sessions-button-radio') as HTMLInputElement;
              if (radio) radio.checked = true;

              // Try to auto-click the first available session to start live streaming
              const autoClickSession = () => {
                const sessionsPanel = doc.getElementById('sessions');
                if (sessionsPanel) {
                  // Find all clickable elements inside sessions panel
                  const elements = sessionsPanel.querySelectorAll('*');
                  for (let i = 0; i < elements.length; i++) {
                    const el = elements[i] as HTMLElement;
                    // Usually session items have an id or text with the tracking ID or ws://
                    if (el.tagName === 'DIV' && el.style.cursor === 'pointer') {
                      el.click();
                      return; // Found and clicked
                    }
                  }
                }
                setTimeout(autoClickSession, 1000);
              };
              setTimeout(autoClickSession, 500);
            } catch (err) {
              console.error('Failed to inject live viewer CSS:', err);
            }
          }}
        />
      ) : (
        <div style={{ height, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
          <Empty description={t('No active browser session selected.')} />
          <div style={{ width: 300 }}>
            <SessionSelect style={{ width: '100%' }} onChange={(val: string) => setLiveUrl(val)} />
          </div>
        </div>
      )}
    </Card>
  );
};

export default AIBrowserBlock;
