import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Card, Empty, Spin } from 'antd';
import { useRequest } from 'ahooks';
import { useApp } from '@nocobase/client-v2';
import { useT } from './locale';
import { DrawioBridge, buildDrawioEmbedUrl } from './lib/drawioBridge';
import { getDiagram, setDiagram, subscribeDiagramState } from './diagramStore';
import { getWrappedData } from './apiResponse';

type Props = {
  height?: number | string;
  ui?: 'min' | 'kennedy' | 'sketch' | 'atlas';
  baseUrlOverride?: string;
};

type DrawioConfig = {
  drawioBaseUrl?: string;
};

export const DrawioBlock: React.FC<Props> = ({ height = 'calc(100vh - 56px)', ui = 'kennedy', baseUrlOverride }) => {
  const t = useT();
  const api = useApp().apiClient;
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const bridgeRef = useRef<DrawioBridge | null>(null);
  const xmlRef = useRef<string>('');
  const [iframeReady, setIframeReady] = useState(false);
  const [diagram, setLocalDiagram] = useState(() => getDiagram());

  const { data: settingsData } = useRequest(() => api.resource('aiDrawio').getConfig(), { manual: !!baseUrlOverride });
  const settings = getWrappedData<DrawioConfig>(settingsData);
  const baseUrl = baseUrlOverride || settings?.drawioBaseUrl || 'https://embed.diagrams.net';

  const embedUrl = useMemo(() => buildDrawioEmbedUrl(baseUrl, { ui }), [baseUrl, ui]);

  // Keep local state in sync with the store.
  useEffect(() => {
    return subscribeDiagramState(() => {
      setLocalDiagram(getDiagram());
    });
  }, []);

  // Recreate the bridge only when the iframe origin changes. The draw.io iframe emits
  // its init event just once, so re-attaching on every diagram update loses that event.
  useEffect(() => {
    if (!iframeRef.current) {
      return;
    }
    const bridge = new DrawioBridge({ baseUrl });
    bridgeRef.current = bridge;

    bridge.attach(
      iframeRef.current,
      {
        onInit: () => {
          setIframeReady(true);
        },
        onLoad: (loadedXml) => {
          xmlRef.current = loadedXml;
        },
        onSave: (savedXml) => {
          xmlRef.current = savedXml;
          const current = getDiagram();
          if (current) {
            setDiagram(current.id, current.title, savedXml);
          }
        },
        onAutosave: (autosavedXml) => {
          xmlRef.current = autosavedXml;
          const current = getDiagram();
          if (current) {
            setDiagram(current.id, current.title, autosavedXml);
          }
        },
      },
      getDiagram()?.xml || '',
    );

    return () => {
      bridge.detach();
      bridgeRef.current = null;
      setIframeReady(false);
    };
  }, [baseUrl]);

  // Push store XML into the iframe whenever it changes and the editor is ready.
  // Guard against bridge-detached state (cleanup runs before React re-renders).
  useEffect(() => {
    if (!iframeReady || !bridgeRef.current || !diagram) {
      return;
    }
    if (diagram.xml === xmlRef.current) {
      return;
    }
    xmlRef.current = diagram.xml;
    bridgeRef.current.load(diagram.xml);
  }, [iframeReady, diagram]);

  if (!diagram) {
    return (
      <Card>
        <Empty
          description={
            <>
              <div>{t('No diagram selected')}</div>
              <div style={{ color: '#999', fontSize: 12 }}>
                {t('Ask the AI to create a diagram, then open it from the chat.')}
              </div>
            </>
          }
        />
      </Card>
    );
  }

  return (
    <Card title={diagram.title} bodyStyle={{ padding: 0, position: 'relative', overflow: 'hidden' }}>
      {!iframeReady && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(255,255,255,0.6)',
            zIndex: 10,
            pointerEvents: 'none',
          }}
        >
          <Spin tip={t('Drawio is loading…')} />
        </div>
      )}
      <iframe
        ref={iframeRef}
        title="drawio-editor"
        src={embedUrl}
        style={{ width: '100%', height, border: 0, display: 'block' }}
        allow="clipboard-read; clipboard-write; fullscreen"
      />
    </Card>
  );
};
