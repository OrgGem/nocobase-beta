import React from 'react';
import { Card, Empty, Spin } from 'antd';
import { useRequest } from '@nocobase/client';
import { observer, useFieldSchema } from '@formily/react';
import { useTranslation } from 'react-i18next';
import DOMPurify from 'dompurify';
import { marked } from 'marked';

type TocItem = {
  id: string;
  text: string;
  level: number;
};

function getHtmlContent(response: unknown) {
  if (typeof response === 'string') {
    return response;
  }

  if (response && typeof response === 'object' && 'data' in response) {
    const data = (response as { data?: unknown }).data;
    return typeof data === 'string' ? data : '';
  }

  return '';
}

function decodeHtml(text: string) {
  if (typeof document === 'undefined') return text;
  const textarea = document.createElement('textarea');
  textarea.innerHTML = text;
  return textarea.value;
}

function extractTextFromContentArray(value: unknown) {
  if (!Array.isArray(value)) return '';
  return value
    .map((item: any) => {
      if (typeof item === 'string') return item;
      if (typeof item?.text === 'string') return item.text;
      if (typeof item?.content === 'string') return item.content;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function extractLegacyMarkdown(html: string) {
  const trimmed = html.trim();
  const paragraphMatch = trimmed.match(/^<p>([\s\S]*)<\/p>$/i);
  const maybeJson = decodeHtml(paragraphMatch?.[1] || trimmed);

  if (!maybeJson.startsWith('[')) {
    return '';
  }

  try {
    return extractTextFromContentArray(JSON.parse(maybeJson));
  } catch {
    return '';
  }
}

function normalizeGuideHtml(html: string) {
  const legacyMarkdown = extractLegacyMarkdown(html);
  if (legacyMarkdown) {
    return marked.parse(legacyMarkdown) as string;
  }
  return html;
}

function slugify(text: string, fallback: string) {
  const slug = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || fallback;
}

function parseGuideContent(html: string): { html: string; toc: TocItem[] } {
  if (typeof DOMParser === 'undefined') {
    return { html, toc: [] };
  }

  const document = new DOMParser().parseFromString(`<article>${html}</article>`, 'text/html');
  const article = document.querySelector('article');
  if (!article) {
    return { html, toc: [] };
  }

  const usedIds = new Set<string>();
  const toc = Array.from(article.querySelectorAll('h2, h3'))
    .map((heading, index) => {
      const text = heading.textContent?.trim() || '';
      if (!text) return null;

      const baseId = slugify(text, `section-${index + 1}`);
      let id = baseId;
      let suffix = 2;
      while (usedIds.has(id)) {
        id = `${baseId}-${suffix}`;
        suffix++;
      }
      usedIds.add(id);
      heading.setAttribute('id', id);

      return {
        id,
        text,
        level: heading.tagName === 'H3' ? 3 : 2,
      };
    })
    .filter(Boolean) as TocItem[];

  return {
    html: article.innerHTML,
    toc,
  };
}

const guideStyles = `
  .user-guide-block .ant-card-body {
    padding: 0;
  }

  .user-guide-shell {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    max-width: 1180px;
    margin: 0 auto;
  }

  .user-guide-shell.has-toc {
    grid-template-columns: 220px minmax(0, 1fr);
  }

  .user-guide-toc {
    position: sticky;
    top: 16px;
    align-self: start;
    max-height: calc(100vh - 120px);
    overflow: auto;
    padding: 32px 0 32px 24px;
    border-right: 1px solid #eef0f2;
  }

  .user-guide-toc-title {
    margin-bottom: 10px;
    color: rgba(0, 0, 0, 0.45);
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
  }

  .user-guide-toc a {
    display: block;
    padding: 5px 10px;
    border-radius: 4px;
    color: rgba(0, 0, 0, 0.66);
    font-size: 13px;
    line-height: 1.42;
    text-decoration: none;
  }

  .user-guide-toc a:hover {
    background: #f5f7fa;
    color: #1677ff;
  }

  .user-guide-toc .level-3 {
    padding-left: 22px;
    font-size: 12px;
  }

  .user-guide-content {
    max-width: 920px;
    margin: 0 auto;
    padding: 32px;
    color: rgba(0, 0, 0, 0.82);
    font-size: 15px;
    line-height: 1.78;
  }

  .user-guide-content h1,
  .user-guide-content h2,
  .user-guide-content h3,
  .user-guide-content h4 {
    color: rgba(0, 0, 0, 0.92);
    font-weight: 650;
    line-height: 1.28;
    margin: 28px 0 12px;
  }

  .user-guide-content h1:first-child,
  .user-guide-content h2:first-child,
  .user-guide-content h3:first-child {
    margin-top: 0;
  }

  .user-guide-content h1 {
    font-size: 30px;
  }

  .user-guide-content h2 {
    font-size: 24px;
    padding-bottom: 8px;
    border-bottom: 1px solid #e6e8eb;
  }

  .user-guide-content h3 {
    font-size: 19px;
  }

  .user-guide-content p,
  .user-guide-content ul,
  .user-guide-content ol,
  .user-guide-content table,
  .user-guide-content blockquote,
  .user-guide-content pre {
    margin: 0 0 16px;
  }

  .user-guide-content ul,
  .user-guide-content ol {
    padding-left: 24px;
  }

  .user-guide-content li + li {
    margin-top: 6px;
  }

  .user-guide-content table {
    width: 100%;
    border-collapse: collapse;
    overflow: hidden;
    border: 1px solid #e6e8eb;
    border-radius: 6px;
  }

  .user-guide-content th,
  .user-guide-content td {
    padding: 10px 12px;
    border: 1px solid #e6e8eb;
    vertical-align: top;
  }

  .user-guide-content th {
    background: #f7f8fa;
    font-weight: 600;
  }

  .user-guide-content blockquote {
    padding: 12px 16px;
    border-left: 4px solid #1677ff;
    background: #f3f8ff;
    color: rgba(0, 0, 0, 0.76);
  }

  .user-guide-content code {
    padding: 2px 5px;
    border-radius: 4px;
    background: #f2f4f7;
    font-size: 0.92em;
  }

  .user-guide-content pre {
    padding: 14px 16px;
    overflow: auto;
    border-radius: 6px;
    background: #111827;
    color: #f9fafb;
  }

  .user-guide-content pre code {
    padding: 0;
    background: transparent;
    color: inherit;
  }

  .user-guide-content hr {
    border: 0;
    border-top: 1px solid #e6e8eb;
    margin: 28px 0;
  }

  @media (max-width: 900px) {
    .user-guide-shell.has-toc {
      grid-template-columns: minmax(0, 1fr);
    }

    .user-guide-toc {
      position: static;
      max-height: none;
      padding: 20px 24px 0;
      border-right: 0;
    }

    .user-guide-content {
      padding: 24px;
    }
  }
`;

export const UserGuideBlock = observer(
  (props: any) => {
    const fieldSchema = useFieldSchema();
    const spaceId = props.spaceId || fieldSchema?.['x-component-props']?.spaceId;
    const { t } = useTranslation();

    const { loading, data: htmlContent } = useRequest<string>(
      {
        url: `aiBuildGuideSpaces:getHtml/${spaceId}`,
      },
      {
        refreshDeps: [spaceId],
        ready: !!spaceId,
      },
    );

    if (!spaceId) {
      return (
        <Card style={{ padding: 24, textAlign: 'center', color: '#888' }}>
          {t('Please select a User Guide Space in block settings')}
        </Card>
      );
    }

    if (loading) {
      return (
        <Card style={{ padding: 24, textAlign: 'center' }}>
          <Spin size="large" />
        </Card>
      );
    }

    const guide = parseGuideContent(normalizeGuideHtml(getHtmlContent(htmlContent)));
    const showToc = guide.toc.length > 2;

    return (
      <Card bordered={false} className="user-guide-block" style={{ width: '100%', minHeight: 300 }}>
        <style>{guideStyles}</style>
        {guide.html ? (
          <div className={`user-guide-shell${showToc ? ' has-toc' : ''}`}>
            {showToc && (
              <nav className="user-guide-toc">
                <div className="user-guide-toc-title">{t('Contents')}</div>
                {guide.toc.map((item) => (
                  <a key={item.id} href={`#${item.id}`} className={`level-${item.level}`}>
                    {item.text}
                  </a>
                ))}
              </nav>
            )}
            <article
              className="user-guide-content"
              dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(guide.html) }}
            />
          </div>
        ) : (
          <Empty description={t('No guide content available')} style={{ padding: 32 }} />
        )}
      </Card>
    );
  },
  { displayName: 'UserGuideBlock' },
);
