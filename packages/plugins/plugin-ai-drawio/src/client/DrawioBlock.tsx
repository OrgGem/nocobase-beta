import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Card, Empty, Spin, App as AntApp } from 'antd';
import { useAPIClient, useRequest } from '@nocobase/client';
import { useFieldSchema } from '@formily/react';
import { useT } from './locale';
import { DrawioBridge, buildDrawioEmbedUrl } from './lib/drawioBridge';
import { useOptionalDrawioContext } from './context/DrawioContext';
import { registerActiveHandle, setActiveBlockUid } from './lib/activeRegistry';

type Props = {
  diagramId?: string;
  height?: number | string;
  ui?: 'min' | 'kennedy' | 'sketch' | 'atlas';
  baseUrlOverride?: string;
};

function getXmlFromResponse(response: unknown): string {
  if (typeof response === 'string') return response;
  if (response && typeof response === 'object' && 'data' in response) {
    const data = (response as { data?: unknown }).data;
    if (typeof data === 'string') return data;
  }
  return '';
}

export const DrawioBlock: React.FC<Props> = ({ diagramId, height = 640, ui = 'kennedy', baseUrlOverride }) => {
  const t = useT();
  const api = useAPIClient();
  const { message } = AntApp.useApp();
  const fieldSchema = useFieldSchema();
  const drawioCtx = useOptionalDrawioContext();
  const [fallbackUid] = useState(() => `inline-${Math.random().toString(36).slice(2, 10)}`);
  const blockUid = String(fieldSchema?.['x-uid'] || fallbackUid);

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const bridgeRef = useRef<DrawioBridge | null>(null);
  const xmlRef = useRef<string>('');
  const [iframeReady, setIframeReady] = useState(false);

  const { data: settingsData } = useRequest<any>(
    {
      resource: 'aiDrawio',
      action: 'getConfig',
    },
    { manual: !!baseUrlOverride },
  );

  const baseUrl =
    baseUrlOverride ||
    settingsData?.data?.drawioBaseUrl ||
    drawioCtx?.baseUrl ||
    'https://embed.diagrams.net';

  const embedUrl = useMemo(() => buildDrawioEmbedUrl(baseUrl, { ui }), [baseUrl, ui]);

  const { data: xmlData, loading: loadingXml } = useRequest<any>(
    {
      resource: 'aiDiagrams',
      action: 'loadXml',
      params: { filterByTk: diagramId },
    },
    { refreshDeps: [diagramId], manual: !diagramId },
  );

  const { data: metaData } = useRequest<any>(
    {
      resource: 'aiDiagrams',
      action: 'get',
      params: { filterByTk: diagramId, fields: ['id', 'title'] },
    },
    { refreshDeps: [diagramId], manual: !diagramId },
  );

  const diagramTitle: string | undefined = metaData?.data?.title;

  const initialXml = getXmlFromResponse(xmlData);

  useEffect(() => {
    if (xmlData !== undefined) {
      xmlRef.current = getXmlFromResponse(xmlData);
    }
  }, [xmlData]);

  const persistXml = useCallback(
    async (xml: string, thumbnailSvg?: string) => {
      if (!diagramId) return;
      try {
        await api.request({
          url: `aiDiagrams:saveXml/${encodeURIComponent(diagramId)}`,
          method: 'post',
          data: { xml, thumbnailSvg },
        });
        xmlRef.current = xml;
      } catch (err: any) {
        message.error(err?.message || t('Save failed'));
      }
    },
    [api, diagramId, message, t],
  );

  useEffect(() => {
    if (!diagramId) {
      setIframeReady(false);
      return;
    }
    if (!iframeRef.current) {
      return;
    }

    const bridge = new DrawioBridge({ baseUrl });
    bridgeRef.current = bridge;

    bridge.attach(
      iframeRef.current,
      {
        onInit: () => setIframeReady(true),
        onLoad: (xml) => {
          xmlRef.current = xml;
        },
        onSave: async (xml) => {
          xmlRef.current = xml;
          await persistXml(xml);
          // Trigger an svg export so the thumbnail stays fresh.
          bridge.export('xmlsvg');
        },
        onAutosave: async (xml) => {
          xmlRef.current = xml;
          await persistXml(xml);
        },
        onExport: async (data, format) => {
          if (format === 'xmlsvg' || format.includes('svg')) {
            await persistXml(xmlRef.current, data);
          } else if (data) {
            const a = document.createElement('a');
            a.href = data;
            a.download = `diagram-${diagramId}.${format === 'png' ? 'png' : format === 'pdf' ? 'pdf' : 'xml'}`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
          }
        },
      },
      initialXml,
    );

    const unregisterCtx = drawioCtx?.registerHandle({
      blockUid,
      diagramId,
      bridge,
      getXml: () => xmlRef.current,
    });

    const unregisterActive = registerActiveHandle({
      blockUid,
      diagramId,
      diagramTitle,
      bridge,
      getXml: () => xmlRef.current,
      setXml: (xml: string) => {
        xmlRef.current = xml;
      },
      persist: persistXml,
    });

    setActiveBlockUid(blockUid);

    return () => {
      bridge.detach();
      bridgeRef.current = null;
      unregisterCtx?.();
      unregisterActive();
      setIframeReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diagramId, baseUrl, diagramTitle]);

  useEffect(() => {
    if (iframeReady && bridgeRef.current && initialXml) {
      bridgeRef.current.load(initialXml);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialXml, iframeReady]);

  if (!diagramId) {
    return (
      <Card>
        <Empty
          description={
            <>
              <div>{t('No diagram selected')}</div>
              <div style={{ color: '#999', fontSize: 12 }}>
                {t('Open the block toolbar to pick a diagram or create one in plugin settings')}
              </div>
            </>
          }
        />
      </Card>
    );
  }

  return (
    <Card bodyStyle={{ padding: 0, position: 'relative', overflow: 'hidden' }}>
      {(loadingXml || !iframeReady) && (
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
