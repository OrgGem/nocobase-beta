import { useApp } from '@nocobase/client-v2';
import { Alert, Spin } from 'antd';
import React, { useEffect, useRef, useState } from 'react';
import { useT } from '../locale';
import type { OcrItem } from '../types';
import { getOverlayPoints } from './pdfGeometry';
import { getPdfSource } from './pdfSource';

type PdfLoadingTask = {
  promise: Promise<{
    numPages: number;
    getPage: (number: number) => Promise<{
      getViewport: (options: { scale: number }) => { width: number; height: number };
      render: (options: { canvasContext: CanvasRenderingContext2D; viewport: { width: number; height: number } }) => {
        promise: Promise<unknown>;
      };
    }>;
  }>;
  destroy: () => Promise<unknown>;
};
type PdfJsModule = {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument: (options: {
    url: string;
    httpHeaders?: Record<string, string>;
    withCredentials?: boolean;
  }) => PdfLoadingTask;
};

export function PdfJsViewer({
  url,
  pdfjsCdnUrl,
  pdfjsWorkerUrl,
  selected,
  scale = 1.25,
}: {
  url?: string;
  pdfjsCdnUrl?: string;
  pdfjsWorkerUrl?: string;
  selected?: OcrItem;
  scale?: number;
}) {
  const api = useApp().apiClient;
  const t = useT();
  const containerRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [renderVersion, setRenderVersion] = useState(0);
  const token = api.auth.token,
    role = api.auth.role;

  useEffect(() => {
    const container = containerRef.current;
    if (!url || !pdfjsCdnUrl || !pdfjsWorkerUrl || !container) return;
    const sourceUrl = url,
      moduleUrl = pdfjsCdnUrl,
      workerUrl = pdfjsWorkerUrl;
    let cancelled = false,
      task: PdfLoadingTask | undefined;
    async function render() {
      setLoading(true);
      setError('');
      container.replaceChildren();
      try {
        const pdfjs = (await import(/* webpackIgnore: true */ moduleUrl)) as PdfJsModule;
        if (cancelled) return;
        pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
        task = pdfjs.getDocument(getPdfSource(sourceUrl, window.location.origin, api.getHeaders()));
        const pdf = await task.promise;
        for (let number = 1; number <= pdf.numPages; number++) {
          if (cancelled) return;
          const page = await pdf.getPage(number),
            viewport = page.getViewport({ scale });
          const wrap = document.createElement('div');
          Object.assign(wrap.style, {
            position: 'relative',
            margin: '0 auto 16px',
            width: `${viewport.width}px`,
            height: `${viewport.height}px`,
          });
          wrap.dataset.page = String(number);
          const canvas = document.createElement('canvas');
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          canvas.style.display = 'block';
          const canvasContext = canvas.getContext('2d');
          if (!canvasContext) throw new Error(t('Canvas context is unavailable'));
          wrap.appendChild(canvas);
          await page.render({ canvasContext, viewport }).promise;
          if (cancelled) return;
          container.appendChild(wrap);
        }
      } catch (failure) {
        if (!cancelled) setError(failure instanceof Error ? failure.message : String(failure));
      } finally {
        if (!cancelled) {
          setRenderVersion((version) => version + 1);
          setLoading(false);
        }
      }
    }
    render();
    return () => {
      cancelled = true;
      task?.destroy().catch(() => {});
      container.replaceChildren();
    };
  }, [api, url, pdfjsCdnUrl, pdfjsWorkerUrl, scale, token, role, t]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.querySelectorAll('.ocr-verify-overlay').forEach((node) => node.remove());
    if (!selected) return;
    const page = container.querySelector<HTMLDivElement>(`[data-page="${selected.page || 1}"]`);
    if (!page) return;
    const points = getOverlayPoints(selected, page.clientWidth, page.clientHeight, scale);
    if (!points) return;
    const overlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    overlay.setAttribute('class', 'ocr-verify-overlay');
    overlay.setAttribute('width', String(page.clientWidth));
    overlay.setAttribute('height', String(page.clientHeight));
    Object.assign(overlay.style, { position: 'absolute', inset: '0', pointerEvents: 'none' });
    const polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    polygon.setAttribute('points', points);
    polygon.setAttribute('fill', 'rgba(255, 193, 7, 0.22)');
    polygon.setAttribute('stroke', '#faad14');
    polygon.setAttribute('stroke-width', '2');
    overlay.appendChild(polygon);
    page.appendChild(overlay);
    page.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [selected, scale, renderVersion]);

  if (!url) return <Alert type="warning" message={t('PDF attachment is missing')} />;
  return (
    <div style={{ position: 'relative', height: '70vh', overflow: 'auto', background: '#f5f5f5', padding: 16 }}>
      {loading && <Spin style={{ position: 'absolute', top: 16, right: 16, zIndex: 1 }} />}
      {error && (
        <Alert type="error" message={t('PDF.js render failed')} description={error} style={{ marginBottom: 12 }} />
      )}
      <div ref={containerRef} />
    </div>
  );
}
