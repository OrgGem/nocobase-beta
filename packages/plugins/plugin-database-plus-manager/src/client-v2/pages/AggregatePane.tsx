import { useFlowContext } from '@nocobase/flow-engine';
import { useRequest } from 'ahooks';
import { Button, Card, Input, Select, Space, Table, message } from 'antd';
import React, { useState } from 'react';
import { fetchStatistics, runAggregate, unwrapResponse, type AggregateMeasure } from '../api/database-plus';
import { useT } from '../locale';

const AGGREGATIONS = ['count', 'sum', 'avg', 'min', 'max'] as const;
type Aggregation = (typeof AGGREGATIONS)[number];

interface CollectionSummary {
  name: string;
  title: string;
}

interface Row {
  [key: string]: unknown;
}

export default function AggregatePane() {
  const ctx = useFlowContext();
  const t = useT();
  const api = ctx.api;

  const [collection, setCollection] = useState<string>();
  const [measures, setMeasures] = useState<AggregateMeasure[]>([]);
  const [dimensions, setDimensions] = useState<string[]>([]);
  const [field, setField] = useState('');
  const [aggregation, setAggregation] = useState<Aggregation>('count');
  const [dimension, setDimension] = useState('');
  const [rows, setRows] = useState<Row[]>([]);

  const { data: summaries } = useRequest(async () =>
    unwrapResponse<{ collections: CollectionSummary[] }>(await fetchStatistics(api, '')),
  );

  const { run, loading } = useRequest(
    async () => unwrapResponse<Row[]>(await runAggregate(api, { collection, measures, dimensions })),
    {
      manual: true,
      onSuccess: (result) => setRows(Array.isArray(result) ? result : []),
      onError: (err: unknown) => message.error(err instanceof Error ? err.message : String(err)),
    },
  );

  function addMeasure() {
    if (!field) return;
    setMeasures((current) => [...current, { field, aggregation }]);
    setField('');
  }

  function addDimension() {
    if (!dimension) return;
    setDimensions((current) => [...current, dimension]);
    setDimension('');
  }

  const columns = rows.length
    ? Object.keys(rows[0]).map((key) => ({ title: key, dataIndex: key, key, ellipsis: true }))
    : [];

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Card title={t('Aggregate')} size="small">
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Select
            style={{ maxWidth: 400 }}
            placeholder={t('Select a collection')}
            value={collection}
            onChange={setCollection}
            options={(summaries?.collections ?? []).map((item) => ({
              value: item.name,
              label: `${item.title} (${item.name})`,
            }))}
          />

          <Space wrap>
            <Input
              placeholder={t('Field')}
              value={field}
              onChange={(event) => setField(event.target.value)}
              style={{ width: 200 }}
            />
            <Select
              style={{ width: 120 }}
              value={aggregation}
              onChange={setAggregation}
              options={AGGREGATIONS.map((value) => ({ value, label: value }))}
            />
            <Button onClick={addMeasure} disabled={!field}>
              {t('Add measure')}
            </Button>
          </Space>

          <Space wrap>
            <Input
              placeholder={t('Dimension field')}
              value={dimension}
              onChange={(event) => setDimension(event.target.value)}
              style={{ width: 200 }}
            />
            <Button onClick={addDimension} disabled={!dimension}>
              {t('Add dimension')}
            </Button>
          </Space>

          <Space wrap>
            <Button
              type="primary"
              loading={loading}
              disabled={!collection || (!measures.length && !dimensions.length)}
              onClick={() => run()}
            >
              {t('Run query')}
            </Button>
          </Space>

          <div>
            {measures.map((measure, index) => (
              <span key={index} style={{ marginRight: 8 }}>
                {`${measure.aggregation}(${measure.field})`}
              </span>
            ))}
          </div>
        </Space>
      </Card>

      <Card title={t('Results')} size="small">
        <Table<Row>
          rowKey={(_, index) => String(index)}
          size="small"
          dataSource={rows}
          columns={columns}
          pagination={false}
        />
      </Card>
    </Space>
  );
}
