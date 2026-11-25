// SPDX-License-Identifier: Apache-2.0

import React, { useMemo, useState } from 'react';
import { App, Button, Empty, Modal, Select } from 'antd';
import { useFlowContext } from '@nocobase/flow-engine';
import type { DataSourceCollectionActionProps } from '@nocobase/plugin-data-source-manager/client-v2';
import { useTranslation } from 'react-i18next';
import { toCollectionOptions } from './components/MssqlConfigForm';

interface RuntimeCollectionLike {
  name?: string;
  options?: {
    tableName?: string;
  };
}

function getLoadedTableSet(collections: unknown): Set<string> {
  if (!Array.isArray(collections)) {
    return new Set();
  }
  const names = new Set<string>();
  for (const item of collections) {
    if (item && typeof item === 'object') {
      const col = item as RuntimeCollectionLike;
      if (typeof col.name === 'string' && col.name) {
        names.add(col.name);
      }
      if (typeof col.options?.tableName === 'string' && col.options.tableName) {
        names.add(col.options.tableName);
      }
    }
  }
  return names;
}

export function MssqlLoadTables({ dataSourceKey, onSubmitted, children }: DataSourceCollectionActionProps) {
  const ctx = useFlowContext();
  const { message: appMessage } = App.useApp();
  const notify = ctx?.message ?? appMessage;
  const { t } = useTranslation('plugin-data-source-mssql');
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [allOptions, setAllOptions] = useState<{ label: string; value: string }[]>([]);
  const [selectedTables, setSelectedTables] = useState<string[]>([]);

  const availableOptions = useMemo(() => {
    const runtimeDs = ctx?.dataSourceManager?.getDataSource?.(dataSourceKey) as
      | { collectionManager?: { getCollections?: () => unknown } }
      | undefined;
    const loadedSet = getLoadedTableSet(runtimeDs?.collectionManager?.getCollections?.());
    return allOptions.filter((option) => !loadedSet.has(option.value));
  }, [allOptions, ctx?.dataSourceManager, dataSourceKey]);

  async function handleOpen() {
    setSelectedTables([]);
    setOpen(true);
    setLoading(true);
    try {
      const response = await ctx.api.resource('dataSources').readTables({
        values: { dataSourceKey },
      });
      setAllOptions(toCollectionOptions(response));
    } catch {
      notify?.error?.(String(t('Failed to load tables')));
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmit() {
    if (!selectedTables.length) {
      notify?.warning?.(String(t('Please select at least one table')));
      return;
    }
    setSubmitting(true);
    try {
      await ctx.api.resource('dataSources').loadTables({
        values: {
          dataSourceKey,
          tables: selectedTables,
        },
      });
      await ctx.dataSourceManager?.getDataSource?.(dataSourceKey)?.reload?.();
      notify?.success?.(String(t('Tables loaded successfully')));
      setOpen(false);
      onSubmitted?.();
    } catch {
      notify?.error?.(String(t('Failed to load tables')));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <Button type="primary" onClick={handleOpen}>
        {children || t('Load tables')}
      </Button>
      <Modal
        open={open}
        title={t('Load tables')}
        confirmLoading={submitting}
        onOk={handleSubmit}
        onCancel={() => setOpen(false)}
        destroyOnClose
      >
        {!loading && availableOptions.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('All tables are already loaded')} />
        ) : (
          <Select
            mode="multiple"
            allowClear
            showSearch
            style={{ width: '100%' }}
            aria-label={String(t('Select tables to load'))}
            placeholder={String(t('Select tables to load'))}
            loading={loading}
            value={selectedTables}
            onChange={setSelectedTables}
            options={availableOptions}
            optionFilterProp="label"
          />
        )}
      </Modal>
    </>
  );
}
