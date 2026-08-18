import React from 'react';
import { Card, Collapse, Space, Table, type TableColumnsType, Tag, Typography } from 'antd';

import { useT } from '../locale';
import { API_DOC_SECTIONS, COLLECTION_RESOURCES, type ApiEndpointDoc, type ApiFieldDoc } from './api-docs-data';

const METHOD_COLORS: Record<string, string> = {
  GET: 'blue',
  POST: 'green',
};

function CodeBlock({ children }: { children: string }) {
  return (
    <pre
      style={{
        background: 'rgba(150, 150, 150, 0.1)',
        border: '1px solid rgba(150, 150, 150, 0.25)',
        borderRadius: 6,
        padding: 12,
        margin: 0,
        overflow: 'auto',
        fontFamily: 'var(--font-family-code, monospace)',
        fontSize: 12,
        lineHeight: 1.5,
        whiteSpace: 'pre',
      }}
    >
      {children}
    </pre>
  );
}

function EndpointPanel({ endpoint }: { endpoint: ApiEndpointDoc }) {
  const t = useT();

  const fieldColumns: TableColumnsType<ApiFieldDoc> = [
    {
      title: t('Field'),
      dataIndex: 'name',
      key: 'name',
      render: (value: string) => <Typography.Text code>{value}</Typography.Text>,
    },
    {
      title: t('Type'),
      dataIndex: 'type',
      key: 'type',
      render: (value: string) => <Typography.Text type="secondary">{value}</Typography.Text>,
    },
    {
      title: t('Required'),
      dataIndex: 'required',
      key: 'required',
      render: (value: boolean | undefined) =>
        value ? <Tag color="red">{t('Required')}</Tag> : <Tag>{t('Optional')}</Tag>,
    },
    {
      title: t('Description'),
      dataIndex: 'description',
      key: 'description',
      render: (value: string) => t(value),
    },
  ];

  return (
    <Space direction="vertical" size="middle" style={{ display: 'flex' }}>
      <Typography.Paragraph style={{ marginBottom: 0 }}>
        <Tag color={METHOD_COLORS[endpoint.method] ?? 'default'}>{endpoint.method}</Tag>
        <Typography.Text code copyable>
          {endpoint.path}
        </Typography.Text>
      </Typography.Paragraph>

      <Typography.Paragraph style={{ marginBottom: 0 }}>{t(endpoint.summary)}</Typography.Paragraph>

      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
        {t(endpoint.description)}
      </Typography.Paragraph>

      <Typography.Paragraph style={{ marginBottom: 0 }}>
        <Tag color="gold">{t('Authentication')}</Tag>
        <Typography.Text type="secondary">{t(endpoint.auth)}</Typography.Text>
      </Typography.Paragraph>

      {endpoint.requestFields.length > 0 ? (
        <Space direction="vertical" size={4} style={{ display: 'flex' }}>
          <Typography.Text strong>{t('Request Body')}</Typography.Text>
          <Table
            aria-label={t('Request Body')}
            rowKey="name"
            size="small"
            dataSource={endpoint.requestFields}
            pagination={false}
            columns={fieldColumns}
          />
        </Space>
      ) : (
        <Typography.Text type="secondary">{t('No request body')}</Typography.Text>
      )}

      <Space direction="vertical" size={4} style={{ display: 'flex' }}>
        <Typography.Text strong>{t('Response')}</Typography.Text>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          {t(endpoint.responseNote)}
        </Typography.Paragraph>
      </Space>

      {endpoint.exampleRequest ? (
        <Space direction="vertical" size={4} style={{ display: 'flex' }}>
          <Typography.Text strong>{t('Example Request')}</Typography.Text>
          <CodeBlock>{endpoint.exampleRequest}</CodeBlock>
        </Space>
      ) : null}

      {endpoint.exampleResponse ? (
        <Space direction="vertical" size={4} style={{ display: 'flex' }}>
          <Typography.Text strong>{t('Example Response')}</Typography.Text>
          <CodeBlock>{endpoint.exampleResponse}</CodeBlock>
        </Space>
      ) : null}
    </Space>
  );
}

export default function ApiDocsPage() {
  const t = useT();

  const collectionColumns: TableColumnsType<(typeof COLLECTION_RESOURCES)[number]> = [
    {
      title: t('Collection'),
      dataIndex: 'name',
      key: 'name',
      render: (value: string) => <Typography.Text code>{value}</Typography.Text>,
    },
    {
      title: t('Description'),
      dataIndex: 'purpose',
      key: 'purpose',
      render: (value: string) => t(value),
    },
  ];

  return (
    <Card title={t('API Reference')}>
      <Space direction="vertical" size="large" style={{ display: 'flex' }}>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          {t(
            'Every endpoint exposed by the Selector Registry, with usage guidance, request fields and examples. Client endpoints are called by automation bots; admin endpoints power this UI.',
          )}
        </Typography.Paragraph>

        {API_DOC_SECTIONS.map((section) => (
          <Space key={section.id} direction="vertical" size="small" style={{ display: 'flex' }}>
            <Typography.Title level={5} style={{ marginBottom: 0 }}>
              {t(section.title)}
            </Typography.Title>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
              {t(section.intro)}
            </Typography.Paragraph>
            <Collapse
              accordion
              items={section.endpoints.map((endpoint) => ({
                key: endpoint.id,
                label: (
                  <Space>
                    <Tag color={METHOD_COLORS[endpoint.method] ?? 'default'}>{endpoint.method}</Tag>
                    <Typography.Text code>{endpoint.path}</Typography.Text>
                    <Typography.Text type="secondary">{t(endpoint.title)}</Typography.Text>
                  </Space>
                ),
                children: <EndpointPanel endpoint={endpoint} />,
              }))}
            />
          </Space>
        ))}

        <Space direction="vertical" size="small" style={{ display: 'flex' }}>
          <Typography.Title level={5} style={{ marginBottom: 0 }}>
            {t('Collection resources')}
          </Typography.Title>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            {t(
              'These collections are also exposed as standard NocoBase resources supporting list, get, create, update and destroy. Reading needs the "read" snippet; writing needs the "manage" snippet.',
            )}
          </Typography.Paragraph>
          <Table
            aria-label={t('Collection resources')}
            rowKey="name"
            size="small"
            dataSource={COLLECTION_RESOURCES}
            pagination={false}
            columns={collectionColumns}
          />
        </Space>
      </Space>
    </Card>
  );
}
