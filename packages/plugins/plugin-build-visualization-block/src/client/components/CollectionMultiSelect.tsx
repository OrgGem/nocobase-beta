import React, { useCallback, useMemo } from 'react';
import { Select, Space, Typography } from 'antd';
import { useACLRoleContext, useCompile, useDataSourceManager, DEFAULT_DATA_SOURCE_KEY } from '@nocobase/client';
import { MAX_COLLECTIONS } from '../../shared/constants';
import { useT } from '../locale';

interface SelectOption {
  label: string;
  value: string;
}

/**
 * The combined value managed by {@link CollectionMultiSelect}: the chosen data
 * source key plus the selected collection names within it.
 */
export interface CollectionMultiSelectValue {
  dataSource?: string;
  collections?: string[];
}

export interface CollectionMultiSelectProps {
  /** Current value (supplied by Formily's field decorator or a parent). */
  value?: CollectionMultiSelectValue;
  /** Change handler (supplied by Formily's field decorator or a parent). */
  onChange?: (value: CollectionMultiSelectValue) => void;
  disabled?: boolean;
}

/**
 * Two linked selects: a data source picker (Req 1.1) and a multiple-collection
 * picker scoped to the chosen data source. The collection list is filtered to
 * collections the current user can `list` (Req 1.2, 1.5), and the selection is
 * capped at {@link MAX_COLLECTIONS}. Changing the data source clears the
 * previously selected collections.
 */
export const CollectionMultiSelect = (props: CollectionMultiSelectProps) => {
  const { value, onChange, disabled } = props;
  const t = useT();
  const compile = useCompile();
  const dataSourceManager = useDataSourceManager();
  const { parseAction } = useACLRoleContext();

  const dataSourceKey = value?.dataSource;
  const selectedCollections = value?.collections ?? [];

  const dataSourceOptions = useMemo<SelectOption[]>(() => {
    const dataSources = dataSourceManager?.getDataSources() ?? [];
    return dataSources.map((dataSource) => ({
      label: compile(dataSource.displayName) || dataSource.key,
      value: dataSource.key,
    }));
  }, [dataSourceManager, compile]);

  const canList = useCallback(
    (collectionName: string) => Boolean(parseAction(`${collectionName}:list`)),
    [parseAction],
  );

  const collectionOptions = useMemo<SelectOption[]>(() => {
    if (!dataSourceKey) {
      return [];
    }
    const dataSource = dataSourceManager?.getDataSource(dataSourceKey);
    const collections = dataSource?.collectionManager?.getCollections() ?? [];
    return collections
      .filter((collection) => canList(collection.name))
      .map((collection) => ({
        label: compile(collection.title) || collection.name,
        value: collection.name,
      }));
  }, [dataSourceManager, dataSourceKey, compile, canList]);

  const handleDataSourceChange = useCallback(
    (nextDataSource: string) => {
      // Switching data source invalidates any previously selected collections.
      onChange?.({ dataSource: nextDataSource, collections: [] });
    },
    [onChange],
  );

  const handleCollectionsChange = useCallback(
    (nextCollections: string[]) => {
      // Enforce the upper bound (Req 1.3) regardless of how many were picked.
      const capped = nextCollections.slice(0, MAX_COLLECTIONS);
      onChange?.({ dataSource: dataSourceKey, collections: capped });
    },
    [onChange, dataSourceKey],
  );

  const atLimit = selectedCollections.length >= MAX_COLLECTIONS;

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="small">
      <Select<string>
        aria-label={t('Data source')}
        placeholder={t('Data source')}
        style={{ width: '100%' }}
        options={dataSourceOptions}
        value={dataSourceKey ?? (dataSourceOptions.length ? undefined : DEFAULT_DATA_SOURCE_KEY)}
        onChange={handleDataSourceChange}
        disabled={disabled}
        showSearch
        optionFilterProp="label"
      />
      <Select<string[]>
        aria-label={t('Collections')}
        placeholder={t('Collections')}
        style={{ width: '100%' }}
        mode="multiple"
        options={collectionOptions}
        value={selectedCollections}
        onChange={handleCollectionsChange}
        disabled={disabled || !dataSourceKey}
        showSearch
        optionFilterProp="label"
      />
      {atLimit ? (
        <Typography.Text type="warning">
          {t('You can select at most {{max}} collections', { max: MAX_COLLECTIONS })}
        </Typography.Text>
      ) : null}
    </Space>
  );
};
