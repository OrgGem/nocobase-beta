import React, { useMemo } from 'react';
import { Select } from 'antd';
import { DEFAULT_DATA_SOURCE_KEY, useDataSourceManager } from '@nocobase/client';

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
  const dataSourceManager = useDataSourceManager();
  const options = useMemo(
    () =>
      dataSourceManager
        .getAllCollections()
        .map((dataSource: any) => ({
          label: dataSource.displayName || dataSource.key,
          options: (dataSource.collections || [])
            .map((collection: any) => {
              const collectionOptions = collection.getOptions?.() || collection.options || collection;
              return {
                label: collectionOptions.title || collectionOptions.name,
                value: encodeCollectionPath(dataSource.key, collectionOptions.name),
              };
            })
            .sort((a, b) => String(a.label).localeCompare(String(b.label))),
        }))
        .filter((dataSource: any) => dataSource.options.length),
    [dataSourceManager],
  );

  return <Select {...props} allowClear showSearch optionFilterProp="label" options={options} />;
};
