import React from 'react';
import { Empty, Tag, Tooltip, Tree } from 'antd';
import { useCarboneTranslation } from '../locale';

export interface PlaceholderNodeView {
  name: string;
  type: string;
  path: string;
  formatters?: string[];
  children?: PlaceholderNodeView[];
}

export interface PlaceholderSchemaView {
  d?: PlaceholderNodeView[];
  c?: PlaceholderNodeView[];
  warnings?: string[];
}

const TYPE_COLORS: Record<string, string> = {
  string: 'blue',
  number: 'gold',
  date: 'purple',
  boolean: 'green',
  array: 'magenta',
  object: 'default',
};

export const PlaceholderTree: React.FC<{ schema?: PlaceholderSchemaView | null }> = ({ schema }) => {
  const { t } = useCarboneTranslation();

  if (!schema || ((!schema.d || !schema.d.length) && (!schema.c || !schema.c.length))) {
    return <Empty description={t('No placeholders detected')} />;
  }

  const treeData = [
    ...(schema.d?.length ? [{ key: 'd', title: <strong>d</strong>, children: toNodes(schema.d, 'd') }] : []),
    ...(schema.c?.length ? [{ key: 'c', title: <strong>c</strong>, children: toNodes(schema.c, 'c') }] : []),
  ];

  return (
    <div>
      {schema.warnings?.length ? (
        <div style={{ marginBottom: 8, color: '#ad6800' }}>⚠ {schema.warnings.join(' · ')}</div>
      ) : null}
      <Tree treeData={treeData} defaultExpandAll selectable={false} />
    </div>
  );
};

function toNodes(nodes: PlaceholderNodeView[], parentKey: string): any[] {
  return nodes.map((n) => ({
    key: `${parentKey}.${n.name}`,
    title: (
      <span>
        {n.name}{' '}
        <Tag color={TYPE_COLORS[n.type] || 'default'} style={{ marginLeft: 4 }}>
          {n.type}
        </Tag>
        {n.formatters?.length ? (
          <Tooltip title={n.formatters.join(' · ')}>
            <Tag color="cyan">{`:${n.formatters[0]}${n.formatters.length > 1 ? '…' : ''}`}</Tag>
          </Tooltip>
        ) : null}
      </span>
    ),
    children: n.children?.length ? toNodes(n.children, `${parentKey}.${n.name}`) : undefined,
  }));
}
