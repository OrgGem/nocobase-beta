import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Card, Empty, Spin, App as AntApp } from 'antd';
import { useRequest } from 'ahooks';
import { useApp } from '@nocobase/client-v2';
import { useFieldSchema } from '@formily/react';
import { useT } from './locale';
import { DrawioBridge, buildDrawioEmbedUrl } from './lib/drawioBridge';
import { registerActiveHandle, setActiveBlockUid } from './lib/activeRegistry';
import { notifyDiagramXmlUpdated, subscribeDiagramXmlUpdated } from './diagramEvents';
import { getWrappedData } from './apiResponse';

type Props = {
  diagramId?: string;
  height?: number | string;
  ui?: 'min' | 'kennedy' | 'sketch' | 'atlas';
  baseUrlOverride?: string;
};

type DrawioConfig = {
  drawioBaseUrl?: string;
};

type DiagramMeta = {
  title?: string;
  mode?: string;
};

function getXmlFromResponse(response: unknown): string {
  const xml = getWrappedData<string>(response);
  return typeof xml === 'string' ? xml : '';
}

export const DrawioBlock: React.FC<Props> = ({ diagramId, height = 640, ui = 'kennedy', baseUrlOverride }) => {
  const t = useT();
  const api = useApp().apiClient;
  const { message } = AntApp.useApp();
  const fieldSchema = useFieldSchema();
  const [fallbackUid] = useState(() => `inline-${Math.random().toString(36).slice(2, 10)}`);
  const blockUid = String(fieldSchema?.['x-uid'] || fallbackUid);

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const bridgeRef = useRef<DrawioBridge | null>(null);
  const xmlRef = useRef<string>('');
  const [iframeReady, setIframeReady] = useState(false);

  const { data: settingsData } = useRequest(() => api.resource('aiDrawio').getConfig(), { manual: !!baseUrlOverride });

  const settings = getWrappedData<DrawioConfig>(settingsData);
  const baseUrl = baseUrlOverride || settings?.drawioBaseUrl || 'https://embed.diagrams.net';

  const embedUrl = useMemo(() => buildDrawioEmbedUrl(baseUrl, { ui }), [baseUrl, ui]);

  const { data: xmlData, loading: loadingXml } = useRequest(
    () => api.resource('aiDiagrams').loadXml({ filterByTk: diagramId }),
    { refreshDeps: [diagramId], manual: !diagramId },
  );

  const { data: metaData } = useRequest(() => api.resource('aiDiagrams').getMeta({ filterByTk: diagramId }), {
    refreshDeps: [diagramId],
    manual: !diagramId,
  });

  const diagramMeta = getWrappedData<DiagramMeta>(metaData);
  const diagramTitle = diagramMeta?.title;
  const diagramMode = diagramMeta?.mode || 'editable';
  const readonly = diagramMode === 'readonly';

  const initialXml = getXmlFromResponse(xmlData);

  const loadIntoEditor = useCallback((xml: string) => {
    bridgeRef.current?.load(xml);
  }, []);

  useEffect(() => {
    if (xmlData !== undefined) {
      xmlRef.current = getXmlFromResponse(xmlData);
    }
  }, [xmlData]);

  const persistXml = useCallback(
    async (xml: string, thumbnailSvg?: string) => {
      if (!diagramId || readonly) return;
      try {
        await api.request({
          url: `aiDiagrams:saveXml/${encodeURIComponent(diagramId)}`,
          method: 'post',
          data: { xml, thumbnailSvg },
        });
        xmlRef.current = xml;
        notifyDiagramXmlUpdated({ diagramId, xml, sourceBlockUid: blockUid });
      } catch (err: unknown) {
        message.error(err instanceof Error ? err.message : t('Save failed'));
      }
    },
    [api, blockUid, diagramId, message, readonly, t],
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
        onInit: () => {
          setIframeReady(true);
          setActiveBlockUid(blockUid);
        },
        onLoad: (xml) => {
          xmlRef.current = xml;
        },
        onSave: async (xml) => {
          xmlRef.current = xml;
          await persistXml(xml);
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

    return () => {
      bridge.detach();
      bridgeRef.current = null;
      setIframeReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diagramId, baseUrl, persistXml]);

  useEffect(() => {
    if (!diagramId || !bridgeRef.current) return;

    const unregisterActive = registerActiveHandle({
      blockUid,
      diagramId,
      diagramTitle,
      getXml: () => xmlRef.current,
      setXml: (xml: string) => {
        xmlRef.current = xml;
      },
      persist: persistXml,
      load: loadIntoEditor,
    });

    setActiveBlockUid(blockUid);

    return () => {
      unregisterActive();
    };
  }, [diagramId, blockUid, diagramTitle, loadIntoEditor, persistXml]);

  useEffect(() => {
    if (!diagramId) return;

    return subscribeDiagramXmlUpdated((event) => {
      if (event.diagramId !== diagramId || event.sourceBlockUid === blockUid) {
        return;
      }
      if (event.xml === xmlRef.current) {
        return;
      }
      xmlRef.current = event.xml;
      bridgeRef.current?.load(event.xml);
    });
  }, [blockUid, diagramId]);

  const handleInteraction = useCallback(() => {
    setActiveBlockUid(blockUid);
  }, [blockUid]);

  useEffect(() => {
    if (iframeReady && bridgeRef.current && xmlData !== undefined) {
      bridgeRef.current.load(initialXml);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialXml, iframeReady, xmlData]);

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
    <Card
      bodyStyle={{ padding: 0, position: 'relative', overflow: 'hidden' }}
      onClick={handleInteraction}
      onMouseEnter={handleInteraction}
    >
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
