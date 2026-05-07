import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useFieldSchema } from '@formily/react';
import { useAPIClient } from '@nocobase/client';
import { Empty, Spin, Typography, Alert, Button } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { css } from '@emotion/css';
import { useT } from './locale';

const { Text } = Typography;

export interface ProxyBlockProps {
  slug?: string;
  height?: number;
  renderMode?: 'iframe' | 'embed';
}

/**
 * ProxyBlock — dual render mode:
 *
 * - "iframe" (default):  renders <iframe src="/proxy/<slug>/"> — full SPA support
 * - "embed":  fetches HTML via backend API, renders in Shadow DOM — seamless integration
 */
export const ProxyBlock = ({ slug: slugProp, height: heightProp, renderMode: modeProp }: ProxyBlockProps) => {
  const fieldSchema = useFieldSchema();
  const t = useT();

  const slug = slugProp || fieldSchema?.['x-component-props']?.slug;
  const height = heightProp || fieldSchema?.['x-component-props']?.height || 600;
  const renderMode = modeProp || fieldSchema?.['x-component-props']?.renderMode || 'iframe';

  if (!slug) {
    return (
      <Empty
        description={
          <>
            <div>{t('Please select a proxy service')}</div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {t('Click the gear icon to configure')}
            </Text>
          </>
        }
      />
    );
  }

  if (renderMode === 'embed') {
    return <EmbedRenderer slug={slug} height={height} />;
  }

  return <IframeRenderer slug={slug} height={height} />;
};

// ---------- iframe mode ----------
function IframeRenderer({ slug, height }: { slug: string; height: number }) {
  const proxyUrl = `/proxy/${slug}/`;

  return (
    <div
      className={css`
        width: 100%;
        border: 1px solid var(--nb-border-color-split, #f0f0f0);
        border-radius: 4px;
        overflow: hidden;
      `}
    >
      <iframe
        src={proxyUrl}
        style={{
          width: '100%',
          height: `${height}px`,
          border: 'none',
          display: 'block',
        }}
        title={`Proxy: ${slug}`}
        sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"
      />
    </div>
  );
}

// ---------- embed mode (Shadow DOM) ----------
function EmbedRenderer({ slug, height }: { slug: string; height: number }) {
  const api = useAPIClient();
  const t = useT();
  const containerRef = useRef<HTMLDivElement>(null);
  const shadowRef = useRef<ShadowRoot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchAndRender = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const res = await api.request({
        url: 'proxyServices:fetchPage',
        params: { slug, path: '/', keepScripts: 'false' },
      });

      const data = res?.data?.data;
      if (!data) {
        setError(t('Empty response from service'));
        return;
      }

      const container = containerRef.current;
      if (!container) return;

      // Create or reuse Shadow DOM
      if (!shadowRef.current) {
        shadowRef.current = container.attachShadow({ mode: 'open' });
      }
      const shadow = shadowRef.current;

      // Build shadow content
      // 1. Reset styles — prevent NocoBase styles from leaking in
      const resetStyle = `
        <style>
          :host {
            all: initial;
            display: block;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            font-size: 14px;
            color: #333;
            line-height: 1.5;
          }
          *, *::before, *::after {
            box-sizing: border-box;
          }
          img { max-width: 100%; height: auto; }
          a { color: #1890ff; }
        </style>
      `;

      // 2. Service stylesheets (extracted from <head>)
      const serviceStyles = data.styles || '';

      // 3. Rewrite <link> hrefs that are relative to use the proxy prefix
      const rewrittenStyles = serviceStyles.replace(
        /href=["'](?!https?:\/\/|\/\/|\/proxy\/)/g,
        `href="/proxy/${slug}/`,
      );

      // 4. Body content
      shadow.innerHTML = `${resetStyle}${rewrittenStyles}<div class="proxy-embed-root">${data.body}</div>`;

      // 5. Handle click navigation within embed — intercept <a> clicks
      shadow.addEventListener('click', (e: Event) => {
        const target = e.target as HTMLElement;
        const anchor = target.closest('a');
        if (anchor) {
          const href = anchor.getAttribute('href');
          if (href && !href.startsWith('http') && !href.startsWith('//') && !href.startsWith('#')) {
            e.preventDefault();
            // Reload embed with new path
            loadSubpath(href);
          }
        }
      });

    } catch (err: any) {
      setError(err?.response?.data?.error || err.message || t('Fetch failed'));
    } finally {
      setLoading(false);
    }
  }, [slug, api]);

  // Navigate within embed
  const loadSubpath = useCallback(async (subPath: string) => {
    setLoading(true);
    try {
      const res = await api.request({
        url: 'proxyServices:fetchPage',
        params: { slug, path: subPath, keepScripts: 'false' },
      });
      const data = res?.data?.data;
      if (data && shadowRef.current) {
        const root = shadowRef.current.querySelector('.proxy-embed-root');
        if (root) {
          root.innerHTML = data.body;
        }
      }
    } catch (err: any) {
      // keep existing content
    } finally {
      setLoading(false);
    }
  }, [slug, api]);

  useEffect(() => {
    fetchAndRender();
  }, [slug]);

  if (error) {
    return (
      <Alert
        type="error"
        showIcon
        message={t('Embed Error')}
        description={error}
        action={
          <Button size="small" icon={<ReloadOutlined />} onClick={fetchAndRender}>
            {t('Retry')}
          </Button>
        }
      />
    );
  }

  return (
    <div
      className={css`
        width: 100%;
        border: 1px solid var(--nb-border-color-split, #f0f0f0);
        border-radius: 4px;
        overflow: auto;
        position: relative;
      `}
      style={{ minHeight: 100, maxHeight: height || undefined }}
    >
      {loading && (
        <div
          className={css`
            position: absolute;
            inset: 0;
            display: flex;
            align-items: center;
            justify-content: center;
            background: rgba(255, 255, 255, 0.7);
            z-index: 10;
          `}
        >
          <Spin />
        </div>
      )}
      <div ref={containerRef} />
    </div>
  );
}
