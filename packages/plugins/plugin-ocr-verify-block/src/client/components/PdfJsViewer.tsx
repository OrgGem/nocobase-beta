import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Spin } from 'antd';
import { NormalizedOcrItem, OcrPoint, OcrRect } from '../../shared/types';

type Props = {
  url?: string;
  pdfjsCdnUrl?: string;
  pdfjsWorkerUrl?: string;
  selected?: NormalizedOcrItem | null;
  scale?: number;
};

function rectToPoints(rect: OcrRect, pageWidth: number, pageHeight: number, scale: number): OcrPoint[] {
  const factor = rect.unit === 'normalized' ? 1 : rect.unit === 'point' ? scale : scale;
  const x = rect.unit === 'normalized' ? rect.x * pageWidth : rect.x * factor;
  const y = rect.unit === 'normalized' ? rect.y * pageHeight : rect.y * factor;
  const width = rect.unit === 'normalized' ? rect.width * pageWidth : rect.width * factor;
  const height = rect.unit === 'normalized' ? rect.height * pageHeight : rect.height * factor;
  return [
    { x, y },
    { x: x + width, y },
    { x: x + width, y: y + height },
    { x, y: y + height },
  ];
}

function pointsToCss(points: OcrPoint[] | undefined, pageWidth: number, pageHeight: number, scale: number) {
  if (!points?.length) return '';
  return points
    .map((point) => {
      const x = point.x <= 1 ? point.x * pageWidth : point.x * scale;
      const y = point.y <= 1 ? point.y * pageHeight : point.y * scale;
      return `${x},${y}`;
    })
    .join(' ');
}

export const PdfJsViewer = ({ url, pdfjsCdnUrl, pdfjsWorkerUrl, selected, scale = 1.25 }: Props) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [renderVersion, setRenderVersion] = useState(0);
  const selectedPage = selected?.page || 1;

  const selectedKey = useMemo(() => JSON.stringify(selected || null), [selected]);

  useEffect(() => {
    if (!url || !pdfjsCdnUrl || !pdfjsWorkerUrl || !containerRef.current) return;
    let cancelled = false;
    const container = containerRef.current;

    async function render() {
      setLoading(true);
      setError('');
      container.innerHTML = '';

      try {
        setRenderVersion((version) => version + 1);
        const pdfjs = await import(/* webpackIgnore: true */ pdfjsCdnUrl);
        pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;
        const pdf = await pdfjs.getDocument(url).promise;

        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
          if (cancelled) return;
          const page = await pdf.getPage(pageNumber);
          const viewport = page.getViewport({ scale });

          const pageWrap = document.createElement('div');
          pageWrap.style.position = 'relative';
          pageWrap.style.margin = '0 auto 16px';
          pageWrap.style.width = `${viewport.width}px`;
          pageWrap.style.height = `${viewport.height}px`;
          pageWrap.dataset.page = String(pageNumber);

          const canvas = document.createElement('canvas');
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          canvas.style.width = `${viewport.width}px`;
          canvas.style.height = `${viewport.height}px`;
          canvas.style.display = 'block';
          pageWrap.appendChild(canvas);

          await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
          container.appendChild(pageWrap);
        }
      } catch (err: any) {
        if (!cancelled) setError(err?.message || String(err));
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
      container.innerHTML = '';
    };
  }, [url, pdfjsCdnUrl, pdfjsWorkerUrl, scale]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    container.querySelectorAll('.ocr-verify-overlay').forEach((node) => node.remove());
    if (!selected) return;

    const pageWrap = container.querySelector<HTMLDivElement>(`[data-page="${selectedPage}"]`);
    if (!pageWrap) return;
    const width = pageWrap.clientWidth;
    const height = pageWrap.clientHeight;
    const points = selected.points || (selected.rect ? rectToPoints(selected.rect, width, height, scale) : undefined);
    const pointCss = pointsToCss(points, width, height, scale);
    if (!pointCss) return;

    const overlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    overlay.setAttribute('class', 'ocr-verify-overlay');
    overlay.setAttribute('width', String(width));
    overlay.setAttribute('height', String(height));
    overlay.style.position = 'absolute';
    overlay.style.inset = '0';
    overlay.style.pointerEvents = 'none';

    const polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    polygon.setAttribute('points', pointCss);
    polygon.setAttribute('fill', 'rgba(255, 193, 7, 0.22)');
    polygon.setAttribute('stroke', '#faad14');
    polygon.setAttribute('stroke-width', '2');
    overlay.appendChild(polygon);
    pageWrap.appendChild(overlay);
    pageWrap.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [selectedKey, selectedPage, scale, renderVersion]);

  if (!url) return <Alert type="warning" message="PDF attachment is missing" />;

  return (
    <div style={{ position: 'relative', height: '70vh', overflow: 'auto', background: '#f5f5f5', padding: 16 }}>
      {loading && <Spin style={{ position: 'absolute', top: 16, right: 16, zIndex: 1 }} />}
      {error && <Alert type="error" message="PDF.js render failed" description={error} style={{ marginBottom: 12 }} />}
      <div ref={containerRef} />
    </div>
  );
};
