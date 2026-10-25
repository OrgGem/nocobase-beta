/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { useApp } from '@nocobase/client-v2';
import { useRequest } from 'ahooks';
import { Select } from 'antd';
import React from 'react';
import { useT } from '../locale';

export function ServiceSelect({
  value,
  onChange,
  disabled,
}: {
  value?: string;
  onChange?: (value?: string) => void;
  disabled?: boolean;
}) {
  const api = useApp().apiClient;
  const t = useT();
  const list = useRequest(async () => {
    const response = await api.resource('ai').listLLMServices();
    return response.data.data as Array<{ name: string; title?: string }>;
  });
  return (
    <Select
      value={value}
      onChange={onChange}
      disabled={disabled}
      loading={list.loading}
      allowClear
      showSearch
      aria-label={t('AI service')}
      style={{ width: '100%' }}
      optionFilterProp="label"
      status={list.error ? 'error' : undefined}
      notFoundContent={list.error ? t('Failed to load the list') : undefined}
      options={list.data?.map((service) => ({ label: service.title || service.name, value: service.name }))}
    />
  );
}

export function ModelSelect({
  service,
  value,
  onChange,
  disabled,
}: {
  service?: string;
  value?: string;
  onChange?: (value?: string) => void;
  disabled?: boolean;
}) {
  const api = useApp().apiClient;
  const t = useT();
  const list = useRequest(
    async () => {
      const response = await api.resource('ai').listModels({ llmService: service });
      return response.data.data as Array<{ id?: string; name?: string }>;
    },
    { ready: !!service, refreshDeps: [service] },
  );
  return (
    <Select
      value={value}
      onChange={onChange}
      disabled={disabled || !service}
      loading={!!service && list.loading}
      aria-label={t('Model')}
      style={{ width: '100%' }}
      allowClear
      showSearch
      optionFilterProp="label"
      status={list.error ? 'error' : undefined}
      notFoundContent={list.error ? t('Failed to load the list') : undefined}
      options={
        service
          ? list.data?.flatMap((model) => {
              const name = model.id || model.name;
              return name ? [{ label: name, value: name }] : [];
            })
          : []
      }
    />
  );
}
