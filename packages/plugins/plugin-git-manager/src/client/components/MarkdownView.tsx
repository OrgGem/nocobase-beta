import React from 'react';
import ReactMarkdown from 'react-markdown';
import { theme } from 'antd';

const { useToken } = theme;

/**
 * Lightweight markdown renderer used for displaying review reports.
 * We avoid the full plugin-field-markdown-vditor `Display` component because
 * it is tightly coupled to formily field context.
 */
export const MarkdownView: React.FC<{ content?: string; maxHeight?: number | string }> = ({
  content,
  maxHeight,
}) => {
  const { token } = useToken();
  if (!content) return null;
  return (
    <div
      style={{
        fontSize: 13,
        lineHeight: 1.65,
        color: token.colorText,
        maxHeight,
        overflow: maxHeight ? 'auto' : undefined,
      }}
    >
      <ReactMarkdown
        components={{
          code({ inline, children, ...props }: any) {
            const text = String(children).replace(/\n$/, '');
            if (inline) {
              return (
                <code
                  {...props}
                  style={{
                    background: token.colorBgLayout,
                    padding: '1px 6px',
                    borderRadius: 4,
                    fontSize: 12,
                    fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
                  }}
                >
                  {text}
                </code>
              );
            }
            return (
              <pre
                style={{
                  background: token.colorBgLayout,
                  padding: '10px 14px',
                  borderRadius: 6,
                  overflowX: 'auto',
                  fontSize: 12,
                  fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
                }}
              >
                <code>{text}</code>
              </pre>
            );
          },
          blockquote({ children }) {
            return (
              <blockquote
                style={{
                  borderLeft: `3px solid ${token.colorBorder}`,
                  paddingLeft: 12,
                  color: token.colorTextSecondary,
                  margin: '8px 0',
                }}
              >
                {children}
              </blockquote>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
};
