import { useApp } from '@nocobase/client-v2';
import { useFlowContext } from '@nocobase/flow-engine';
import { useRequest } from 'ahooks';
import { Select, type SelectProps } from 'antd';
import React from 'react';
import { useT } from '../locale';
import type { BrowserSession } from '../session';

export function SessionSelect(props: SelectProps<string>) {
  const api = useApp().apiClient;
  const t = useT();
  const ownerId = useFlowContext().user?.id;
  const { data, loading, error } = useRequest(
    async () => {
      const response = await api.request<{ data: BrowserSession[] }>({
        url: 'aiBrowserSessions:list',
        method: 'get',
        params: { filter: { status: 'running', ownerId }, pageSize: 50, sort: ['-createdAt'] },
      });
      return response.data.data;
    },
    { ready: ownerId != null, refreshDeps: [ownerId] },
  );
  return (
    <Select
      {...props}
      loading={loading}
      status={error ? 'error' : undefined}
      placeholder={props.placeholder || t('Select an active browser session...')}
      options={data
        ?.filter((row) => row.liveUrl)
        .map((row) => ({
          label: row.title || t('Session {{id}}', { id: row.id }),
          value: `${row.liveUrl}#id=${encodeURIComponent(row.id)}`,
        }))}
      showSearch
      allowClear
      optionFilterProp="label"
    />
  );
}
