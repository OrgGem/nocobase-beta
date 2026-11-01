import { useApp } from '@nocobase/client-v2';
import { useRequest } from 'ahooks';
import { Alert, Card, Empty, Spin } from 'antd';
import React, { useEffect, useRef, useState } from 'react';
import { useT } from '../locale';
import { decodeSessionValue, normalizeLiveUrl, shouldUseScreenshotFallback } from '../session';
import { SessionSelect } from './SessionSelect';

export type AIBrowserBlockProps = {
  liveUrl?: string;
  sessionId?: string;
  currentUrl?: string;
  title?: string;
  height?: string | number;
};

function LiveView({ liveUrl, sessionId, currentUrl, title, height = 640 }: AIBrowserBlockProps) {
  const api = useApp().apiClient;
  const t = useT();
  const normalized = normalizeLiveUrl(liveUrl, window.location.origin);
  const screenshotView = shouldUseScreenshotFallback(normalized, window.location.origin) && !!sessionId;
  const iframe = useRef<HTMLIFrameElement>(null);
  const [frameVersion, setFrameVersion] = useState(0);
  const screenshot = useRequest(
    async () => {
      const response = await api.request<{ data: { screenshot?: string; currentUrl?: string } }>({
        url: 'aiBrowser:getScreenshot',
        method: 'post',
        params: { filterByTk: sessionId },
      });
      return response.data.data;
    },
    { ready: screenshotView, pollingInterval: 1000, pollingWhenHidden: false },
  );

  useEffect(() => {
    if (sessionId)
      api.request({ url: 'aiBrowser:markLiveViewOpened', method: 'post', data: { sessionId } }).catch(() => {});
  }, [api, sessionId]);

  useEffect(() => {
    let frameDocument: Document | null;
    try {
      frameDocument = iframe.current?.contentDocument || null;
    } catch {
      return;
    }
    if (!frameDocument) return;
    const document = frameDocument;
    const style = document.createElement('style');
    style.textContent =
      'header, #side-nav, #code, #settings, #resize-main, #runner, .CodeMirror { display: none !important; } #editor { left: 0 !important; top: 0 !important; right: 0 !important; bottom: 0 !important; border: 0 !important; } #sessions { display: flex !important; width: 100% !important; height: 100% !important; }';
    document.head.appendChild(style);
    const radio = document.getElementById('sessions-button-radio');
    if (radio?.tagName === 'INPUT') (radio as HTMLInputElement).checked = true;
    const timer = window.setInterval(() => {
      const target = document.getElementById('sessions')?.querySelector<HTMLElement>('div[style*="cursor: pointer"]');
      if (target) {
        target.click();
        window.clearInterval(timer);
      }
    }, 500);
    return () => {
      window.clearInterval(timer);
      style.remove();
    };
  }, [frameVersion]);

  return (
    <Card
      title={title || screenshot.data?.currentUrl || currentUrl || sessionId || t('Readonly Browser')}
      styles={{ body: { padding: 0, position: 'relative', overflow: 'hidden' } }}
    >
      {screenshotView ? (
        <div
          style={{
            width: '100%',
            height,
            background: '#111',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {screenshot.data?.screenshot ? (
            <img
              src={`data:image/jpeg;base64,${screenshot.data.screenshot}`}
              alt={t('Readonly Browser')}
              style={{ width: '100%', height: '100%', objectFit: 'contain' }}
            />
          ) : screenshot.error ? (
            <Alert type="error" message={t('Failed to load browser preview')} />
          ) : (
            <Spin tip={t('Browser is starting...')} />
          )}
        </div>
      ) : normalized ? (
        <iframe
          ref={iframe}
          src={normalized}
          title={t('Readonly Browser')}
          sandbox="allow-same-origin allow-scripts"
          onLoad={() => setFrameVersion((version) => version + 1)}
          style={{ width: '100%', height, border: 0, display: 'block' }}
        />
      ) : (
        <div style={{ height, display: 'grid', placeItems: 'center' }}>
          <Empty description={t('No active browser session selected.')} />
        </div>
      )}
    </Card>
  );
}

export function AIBrowserBlock(props: AIBrowserBlockProps) {
  const initial = decodeSessionValue(props.liveUrl);
  const [selection, setSelection] = useState<AIBrowserBlockProps>({
    ...props,
    ...initial,
    sessionId: props.sessionId || initial.sessionId,
  });
  const t = useT();
  useEffect(() => {
    const decoded = decodeSessionValue(props.liveUrl);
    setSelection({
      ...decoded,
      sessionId: props.sessionId || decoded.sessionId,
      currentUrl: props.currentUrl,
      title: props.title,
      height: props.height,
    });
  }, [props.liveUrl, props.sessionId, props.currentUrl, props.title, props.height]);
  useEffect(() => {
    const onUpdate = (event: Event) => {
      const detail = (event as CustomEvent<AIBrowserBlockProps>).detail;
      if (!detail || (props.sessionId && detail.sessionId !== props.sessionId)) return;
      setSelection((previous) => ({ ...previous, ...detail }));
    };
    window.addEventListener('ai-browser:set-live-url', onUpdate);
    return () => window.removeEventListener('ai-browser:set-live-url', onUpdate);
  }, [props.sessionId]);
  if (!selection.liveUrl && !selection.sessionId)
    return (
      <Card title={props.title || t('Readonly Browser')}>
        <Empty description={t('No active browser session selected.')} />
        <SessionSelect
          style={{ width: '100%', marginTop: 16 }}
          onChange={(value) => setSelection((previous) => ({ ...previous, ...decodeSessionValue(value) }))}
        />
      </Card>
    );
  return <LiveView key={`${selection.sessionId || ''}:${selection.liveUrl || ''}`} {...selection} />;
}
