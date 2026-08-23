import { useFlowContext } from '@nocobase/flow-engine';
import { useRequest } from 'ahooks';
import { Button, Card, Form, Input, Popconfirm, Select, Space, Table, message } from 'antd';
import React, { useState } from 'react';
import {
  createIndex,
  dropIndex,
  fetchIndexes,
  fetchStatistics,
  unwrapResponse,
  type IndexInfo,
} from '../api/database-plus';
import { useT } from '../locale';

interface CollectionSummary {
  name: string;
  title: string;
  tableName: string;
}

export default function IndexesPane() {
  const ctx = useFlowContext();
  const t = useT();
  const api = ctx.api;

  const [selected, setSelected] = useState<string>();
  const [name, setName] = useState('');
  const [fields, setFields] = useState<string[]>([]);

  const { data: summaries } = useRequest(async () =>
    unwrapResponse<{ collections: CollectionSummary[] }>(await fetchStatistics(api, '')),
  );

  const {
    data: indexes,
    loading,
    run: loadIndexes,
  } = useRequest(
    async (tableName: string) => unwrapResponse<{ indexes: IndexInfo[] }>(await fetchIndexes(api, tableName)),
    { manual: true },
  );

  const { run: addIndex, loading: adding } = useRequest(
    async () => {
      if (!selected) return;
      await createIndex(api, selected, name, fields);
      loadIndexes(selected);
    },
    {
      manual: true,
      onSuccess: () => {
        message.success(t('Index added'));
        setName('');
        setFields([]);
      },
      onError: (error: unknown) => message.error(error instanceof Error ? error.message : String(error)),
    },
  );

  const { run: removeIndex } = useRequest(
    async (indexName: string) => {
      if (!selected) return;
      await dropIndex(api, selected, indexName);
      loadIndexes(selected);
    },
    {
      manual: true,
      onError: (error: unknown) => message.error(error instanceof Error ? error.message : String(error)),
    },
  );

  function onSelect(value: string) {
    setSelected(value);
    loadIndexes(value);
  }

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Card title={t('Indexes')} size="small">
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Select
            style={{ maxWidth: 400 }}
            placeholder={t('Select a collection')}
            value={selected}
            onChange={onSelect}
            options={(summaries?.collections ?? []).map((item) => ({
              value: item.tableName,
              label: `${item.title} (${item.tableName})`,
            }))}
          />
          <Table<IndexInfo>
            rowKey="name"
            size="small"
            loading={loading}
            dataSource={selected ? indexes?.indexes ?? [] : []}
            columns={[
              { title: t('Index name'), dataIndex: 'name', key: 'name' },
              {
                title: t('Columns'),
                dataIndex: 'fields',
                key: 'fields',
                render: (value: unknown) => (Array.isArray(value) ? value.join(', ') : String(value ?? '')),
              },
              {
                title: t('Unique'),
                dataIndex: 'unique',
                key: 'unique',
                render: (value: boolean) => (value ? t('Yes') : t('No')),
              },
              {
                title: '',
                key: 'action',
                render: (_, record) => (
                  <Popconfirm title={t('Remove this index?')} onConfirm={() => removeIndex(record.name)}>
                    <Button danger size="small">
                      {t('Remove index')}
                    </Button>
                  </Popconfirm>
                ),
              },
            ]}
          />
        </Space>
      </Card>

      <Card title={t('Add index')} size="small">
        <Form layout="inline">
          <Form.Item label={t('Index name')}>
            <Input value={name} onChange={(event) => setName(event.target.value)} style={{ width: 220 }} />
          </Form.Item>
          <Form.Item label={t('Columns')}>
            <Select
              mode="tags"
              style={{ minWidth: 260 }}
              placeholder={t('Type column names')}
              value={fields}
              onChange={(value: string[]) => setFields(value)}
            />
          </Form.Item>
          <Form.Item>
            <Button
              type="primary"
              loading={adding}
              disabled={!selected || !name || !fields.length}
              onClick={() => addIndex()}
            >
              {t('Add index')}
            </Button>
          </Form.Item>
        </Form>
      </Card>
    </Space>
  );
}
