import { useFlowContext } from '@nocobase/flow-engine';
import { useRequest } from 'ahooks';
import { Alert, Button, Card, Input, Space, Table } from 'antd';
import React, { useState } from 'react';
import { runSql, unwrapResponse } from '../api/database-plus';
import { useT } from '../locale';

interface Row {
  [key: string]: unknown;
}

export default function SqlConsolePane() {
  const ctx = useFlowContext();
  const t = useT();
  const api = ctx.api;

  const [sql, setSql] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string>();

  const { run, loading } = useRequest(
    async (query: string) => unwrapResponse<{ rows: Row[]; rowCount: number; limit: number }>(await runSql(api, query)),
    {
      manual: true,
      onSuccess: (result) => {
        setError(undefined);
        setRows(Array.isArray(result.rows) ? result.rows : []);
      },
      onError: (err: unknown) => {
        setRows([]);
        setError(err instanceof Error ? err.message : String(err));
      },
    },
  );

  const columns = rows.length
    ? Object.keys(rows[0]).map((key) => ({ title: key, dataIndex: key, key, ellipsis: true }))
    : [];

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Card title={t('SQL Console')} size="small">
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Input.TextArea
            rows={4}
            value={sql}
            onChange={(event) => setSql(event.target.value)}
            placeholder="SELECT * FROM users LIMIT 10"
          />
          <Button type="primary" loading={loading} disabled={!sql.trim()} onClick={() => run(sql)}>
            {t('Run query')}
          </Button>
        </Space>
      </Card>
      {error ? <Alert type="error" message={error} showIcon /> : null}
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
