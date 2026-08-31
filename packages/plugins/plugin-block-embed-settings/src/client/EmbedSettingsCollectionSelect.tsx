import React, { useEffect, useMemo, useState } from 'react';
import { Select, Spin } from 'antd';
import { DEFAULT_DATA_SOURCE_KEY, useApp } from '@nocobase/client-v2';
import type { CollectionSelectGroupOption, DataSourceEntry, CollectionEntry } from './types';

const collectionPathSeparator = '::';

export const encodeCollectionPath = (dataSourceName = DEFAULT_DATA_SOURCE_KEY, collectionName?: string) =>
  collectionName
    ? `${dataSourceName || DEFAULT_DATA_SOURCE_KEY}${collectionPathSeparator}${collectionName}`
    : undefined;

export const decodeCollectionPath = (value?: string) => {
  if (!value) {
    return { dataSourceName: DEFAULT_DATA_SOURCE_KEY, collectionName: undefined };
  }
  const [dataSourceName, ...collectionParts] = value.split(collectionPathSeparator);
  return {
    dataSourceName: dataSourceName || DEFAULT_DATA_SOURCE_KEY,
    collectionName: collectionParts.join(collectionPathSeparator) || undefined,
  };
};

export const EmbedSettingsCollectionSelect: React.FC<{
  value?: string;
  onChange?: (value: string | undefined) => void;
  disabled?: boolean;
  placeholder?: string;
  [key: string]: unknown;
}> = (props) => {
  const app = useApp();
  const dataSourceManager = app.dataSourceManager;
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        await dataSourceManager?.ensureLoaded?.();
      } catch {
        // ignore load failures; options will simply be empty
      }
      if (!cancelled) {
        setLoaded(true);
        setLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [dataSourceManager]);

  const options = useMemo<CollectionSelectGroupOption[]>(
    () =>
      (dataSourceManager?.getDataSources?.() || [])
        .map((dataSource: DataSourceEntry) => ({
          label: dataSource.displayName || dataSource.key,
          options: (dataSource.getCollections?.() || [])
            .map((collection: CollectionEntry) => ({
              label: collection.title || collection.name,
              value: encodeCollectionPath(dataSource.key, collection.name),
            }))
            .sort((a, b) => String(a.label).localeCompare(String(b.label))),
        }))
        .filter((dataSource: CollectionSelectGroupOption) => dataSource.options.length > 0),
    // `loaded` is intentionally included: it forces recompute once async ensureLoaded resolves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dataSourceManager, loaded],
  );

  if (loading) {
    return <Spin size="small" />;
  }

  return <Select {...props} allowClear showSearch optionFilterProp="label" options={options} />;
};
