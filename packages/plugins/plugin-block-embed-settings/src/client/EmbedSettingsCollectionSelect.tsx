import React, { useEffect, useMemo, useState } from 'react';
import { Select } from 'antd';
import { DEFAULT_DATA_SOURCE_KEY, useApp } from '@nocobase/client-v2';

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

export const EmbedSettingsCollectionSelect = (props: any) => {
  const app = useApp();
  const dataSourceManager = app.dataSourceManager;
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        await dataSourceManager?.ensureLoaded?.();
      } catch {
        // ignore load failures; options will simply be empty
      }
      if (!cancelled) setLoaded(true);
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [dataSourceManager]);

  const options = useMemo(
    () =>
      (dataSourceManager?.getDataSources?.() || [])
        .map((dataSource: any) => ({
          label: dataSource.displayName || dataSource.key,
          options: (dataSource.getCollections?.() || [])
            .map((collection: any) => ({
              label: collection.title || collection.name,
              value: encodeCollectionPath(dataSource.key, collection.name),
            }))
            .sort((a, b) => String(a.label).localeCompare(String(b.label))),
        }))
        .filter((dataSource: any) => dataSource.options.length),
    // `loaded` is intentionally included: it forces recompute once async ensureLoaded resolves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dataSourceManager, loaded],
  );

  return <Select {...props} allowClear showSearch optionFilterProp="label" options={options} />;
};
