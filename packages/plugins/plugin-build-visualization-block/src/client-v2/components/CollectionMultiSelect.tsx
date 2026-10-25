/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { useFlowContext } from '@nocobase/flow-engine';
import { Select, Space } from 'antd';
import React from 'react';
import { MAX_COLLECTIONS } from '../../shared/constants';
import { useT } from '../locale';

export type CollectionSelection = { dataSource?: string; collections?: string[] };
export function CollectionMultiSelect({
  value = {},
  onChange,
  disabled,
}: {
  value?: CollectionSelection;
  onChange?: (value: CollectionSelection) => void;
  disabled?: boolean;
}) {
  const ctx = useFlowContext();
  const t = useT();
  const sources = ctx.dataSourceManager.getDataSources();
  const collections = value.dataSource
    ? ctx.dataSourceManager.getDataSource(value.dataSource)?.getCollections() || []
    : [];
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Select
        aria-label={t('Data source')}
        placeholder={t('Data source')}
        style={{ width: '100%' }}
        disabled={disabled}
        value={value.dataSource}
        showSearch
        optionFilterProp="label"
        options={sources.map((source) => ({ value: source.key, label: ctx.t(source.displayName || source.key) }))}
        onChange={(dataSource: string) => onChange?.({ dataSource, collections: [] })}
      />
      <Select
        aria-label={t('Collections')}
        placeholder={t('Collections')}
        mode="multiple"
        style={{ width: '100%' }}
        disabled={disabled || !value.dataSource}
        value={value.collections || []}
        showSearch
        optionFilterProp="label"
        maxCount={MAX_COLLECTIONS}
        options={collections
          .filter((collection) =>
            ctx.acl.can({
              dataSourceKey: value.dataSource,
              resourceName: collection.name,
              actionName: 'list',
            }),
          )
          .map((collection) => ({ value: collection.name, label: ctx.t(collection.title || collection.name) }))}
        onChange={(selected: string[]) =>
          onChange?.({ dataSource: value.dataSource, collections: selected.slice(0, MAX_COLLECTIONS) })
        }
      />
    </Space>
  );
}
