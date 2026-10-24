/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { App, Modal, Tabs, Form, Select, Button, Radio, Input, Table, Checkbox, Typography } from 'antd';
import { PlusOutlined, DeleteOutlined } from '@ant-design/icons';
import { useFlowContext } from '@nocobase/flow-engine';
import { useTranslation } from 'react-i18next';

const { Text } = Typography;

interface JoinDef {
  dataSource: string;
  collection: string;
  joinType: 'left' | 'inner';
  leftField: string;
  rightField: string;
}

interface ColumnDef {
  source: number;
  field: string;
  alias?: string;
  jsonExpand?: string[];
  selected?: boolean;
}

interface CrossJoinConfig {
  primarySource: { dataSource: string; collection: string };
  joins: JoinDef[];
  columns: ColumnDef[];
}

interface Props {
  visible: boolean;
  onCancel: () => void;
  onSubmit: (config: CrossJoinConfig) => void | Promise<void>;
  initialConfig?: CrossJoinConfig;
}

function useDataSourceOptions() {
  const { dataSourceManager } = useFlowContext();
  return dataSourceManager.getDataSources().map((ds) => ({
    label: ds.displayName || ds.key,
    value: ds.key,
  }));
}

function useCollectionOptions(dsKey: string) {
  const { dataSourceManager } = useFlowContext();
  return useMemo(() => {
    if (!dsKey) return [];
    const ds = dataSourceManager.getDataSource(dsKey);
    if (!ds) return [];
    const collections = ds.collectionManager.getCollections() || [];
    return collections.map((c) => ({
      label: c.title || c.name,
      value: c.name,
    }));
  }, [dataSourceManager, dsKey]);
}

function useFieldOptions(dsKey: string, collectionName: string) {
  const { dataSourceManager } = useFlowContext();
  return useMemo(() => {
    if (!dsKey || !collectionName) return [];
    const ds = dataSourceManager.getDataSource(dsKey);
    if (!ds) return [];
    const collection = ds.collectionManager.getCollection(collectionName);
    if (!collection) return [];
    const fields = collection.getFields() || [];
    return fields.map((f) => ({
      label: f.uiSchema?.title || f.name,
      value: f.name,
      type: f.type,
      interface: f.interface,
    }));
  }, [dataSourceManager, dsKey, collectionName]);
}

// Tab 1: Primary Source
const PrimarySourceTab: React.FC<{
  value: { dataSource: string; collection: string };
  onChange: (val: { dataSource: string; collection: string }) => void;
}> = ({ value, onChange }) => {
  const { t } = useTranslation('plugin-block-cross-join');
  const dsOptions = useDataSourceOptions();
  const collectionOptions = useCollectionOptions(value.dataSource);

  return (
    <Form layout="vertical">
      <Form.Item label={t('Datasource')}>
        <Select
          value={value.dataSource}
          options={dsOptions}
          placeholder={t('Select datasource')}
          onChange={(v) => onChange({ dataSource: v, collection: '' })}
          showSearch
          filterOption={(input, option) =>
            String(option?.label ?? '')
              .toLowerCase()
              .includes(input.toLowerCase())
          }
        />
      </Form.Item>
      <Form.Item label={t('Collection')}>
        <Select
          value={value.collection || undefined}
          options={collectionOptions}
          placeholder={t('Select collection')}
          onChange={(v) => onChange({ ...value, collection: v })}
          showSearch
          filterOption={(input, option) =>
            String(option?.label ?? '')
              .toLowerCase()
              .includes(input.toLowerCase())
          }
          disabled={!value.dataSource}
        />
      </Form.Item>
    </Form>
  );
};

// Tab 2: Joins
const JoinRow: React.FC<{
  join: JoinDef;
  index: number;
  primaryDs: string;
  primaryCollection: string;
  onChange: (index: number, join: JoinDef) => void;
  onRemove: (index: number) => void;
}> = ({ join, index, primaryDs, primaryCollection, onChange, onRemove }) => {
  const { t } = useTranslation('plugin-block-cross-join');
  const dsOptions = useDataSourceOptions();
  const collectionOptions = useCollectionOptions(join.dataSource);
  const leftFieldOptions = useFieldOptions(primaryDs, primaryCollection);
  const rightFieldOptions = useFieldOptions(join.dataSource, join.collection);

  return (
    <div style={{ border: '1px solid #d9d9d9', borderRadius: 6, padding: 16, marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
        <Text strong>{t('Join #{{number}}', { number: index + 1 })}</Text>
        <Button
          type="text"
          danger
          aria-label={t('Remove join')}
          icon={<DeleteOutlined />}
          onClick={() => onRemove(index)}
        />
      </div>
      <Form layout="vertical" size="small">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Form.Item label={t('Datasource')} style={{ marginBottom: 8 }}>
            <Select
              value={join.dataSource}
              options={dsOptions}
              onChange={(v) => onChange(index, { ...join, dataSource: v, collection: '', rightField: '' })}
              showSearch
              filterOption={(input, option) =>
                String(option?.label ?? '')
                  .toLowerCase()
                  .includes(input.toLowerCase())
              }
            />
          </Form.Item>
          <Form.Item label={t('Collection')} style={{ marginBottom: 8 }}>
            <Select
              value={join.collection || undefined}
              options={collectionOptions}
              onChange={(v) => onChange(index, { ...join, collection: v, rightField: '' })}
              disabled={!join.dataSource}
              showSearch
              filterOption={(input, option) =>
                String(option?.label ?? '')
                  .toLowerCase()
                  .includes(input.toLowerCase())
              }
            />
          </Form.Item>
        </div>
        <Form.Item label={t('Join Type')} style={{ marginBottom: 8 }}>
          <Radio.Group value={join.joinType} onChange={(e) => onChange(index, { ...join, joinType: e.target.value })}>
            <Radio value="left">{t('Left Join')}</Radio>
            <Radio value="inner">{t('Inner Join')}</Radio>
          </Radio.Group>
        </Form.Item>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Form.Item label={t('Left Field (primary)')} style={{ marginBottom: 0 }}>
            <Select
              value={join.leftField || undefined}
              options={leftFieldOptions}
              onChange={(v) => onChange(index, { ...join, leftField: v })}
              placeholder={t('Field from primary')}
              showSearch
              filterOption={(input, option) =>
                String(option?.label ?? '')
                  .toLowerCase()
                  .includes(input.toLowerCase())
              }
            />
          </Form.Item>
          <Form.Item label={t('Right Field (join)')} style={{ marginBottom: 0 }}>
            <Select
              value={join.rightField || undefined}
              options={rightFieldOptions}
              onChange={(v) => onChange(index, { ...join, rightField: v })}
              placeholder={t('Field from join table')}
              disabled={!join.collection}
              showSearch
              filterOption={(input, option) =>
                String(option?.label ?? '')
                  .toLowerCase()
                  .includes(input.toLowerCase())
              }
            />
          </Form.Item>
        </div>
      </Form>
    </div>
  );
};

const JoinsTab: React.FC<{
  joins: JoinDef[];
  primaryDs: string;
  primaryCollection: string;
  onChange: (joins: JoinDef[]) => void;
}> = ({ joins, primaryDs, primaryCollection, onChange }) => {
  const { t } = useTranslation('plugin-block-cross-join');
  const handleAdd = () => {
    onChange([...joins, { dataSource: 'main', collection: '', joinType: 'left', leftField: '', rightField: '' }]);
  };
  const handleChange = (index: number, join: JoinDef) => {
    const next = [...joins];
    next[index] = join;
    onChange(next);
  };
  const handleRemove = (index: number) => {
    onChange(joins.filter((_, i) => i !== index));
  };

  return (
    <div>
      {joins.map((join, i) => (
        <JoinRow
          key={i}
          join={join}
          index={i}
          primaryDs={primaryDs}
          primaryCollection={primaryCollection}
          onChange={handleChange}
          onRemove={handleRemove}
        />
      ))}
      <Button type="dashed" icon={<PlusOutlined />} onClick={handleAdd} block>
        {t('Add Join')}
      </Button>
    </div>
  );
};

// Tab 3: Columns
const ColumnsTab: React.FC<{
  columns: ColumnDef[];
  primaryDs: string;
  primaryCollection: string;
  joins: JoinDef[];
  onChange: (cols: ColumnDef[]) => void;
}> = ({ columns, primaryDs, primaryCollection, joins, onChange }) => {
  const { t } = useTranslation('plugin-block-cross-join');
  const { dataSourceManager } = useFlowContext();

  // Build all available fields from all sources
  const allFields = useMemo(() => {
    const fields: { source: number; sourceName: string; field: string; label: string; type: string }[] = [];

    const sources = [{ dataSource: primaryDs, collection: primaryCollection }, ...joins];
    for (const [source, item] of sources.entries()) {
      const collection = dataSourceManager.getCollection(item.dataSource, item.collection);
      for (const field of collection?.getFields() || []) {
        fields.push({
          source,
          sourceName: item.collection,
          field: field.name,
          label: `${item.collection}.${field.title || field.name}`,
          type: field.type,
        });
      }
    }

    return fields;
  }, [dataSourceManager, primaryDs, primaryCollection, joins]);

  // Auto-populate columns if empty
  const handleAutoPopulate = useCallback(() => {
    const cols: ColumnDef[] = allFields.map((f) => ({
      source: f.source,
      field: f.field,
      selected: true,
    }));
    onChange(cols);
  }, [allFields, onChange]);

  const tableColumns = [
    {
      title: t('Include'),
      dataIndex: 'selected',
      width: 70,
      render: (_: unknown, record: ColumnDef, index: number) => (
        <Checkbox
          checked={record.selected !== false}
          onChange={(e) => {
            const next = [...columns];
            next[index] = { ...next[index], selected: e.target.checked };
            onChange(next);
          }}
        />
      ),
    },
    {
      title: t('Source'),
      dataIndex: 'source',
      width: 100,
      render: (val: number) => (val === 0 ? t('Primary Source') : t('Join #{{number}}', { number: val })),
    },
    { title: t('Field'), dataIndex: 'field', width: 150 },
    {
      title: t('Alias'),
      dataIndex: 'alias',
      width: 150,
      render: (_: unknown, record: ColumnDef, index: number) => (
        <Input
          size="small"
          value={record.alias || ''}
          placeholder={record.field}
          onChange={(e) => {
            const next = [...columns];
            next[index] = { ...next[index], alias: e.target.value || undefined };
            onChange(next);
          }}
        />
      ),
    },
  ];

  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <Button size="small" onClick={handleAutoPopulate}>
          {t('Auto-populate from sources')}
        </Button>
      </div>
      {columns.length > 0 ? (
        <Table
          dataSource={columns}
          columns={tableColumns}
          rowKey={(_, i) => String(i)}
          size="small"
          pagination={false}
          scroll={{ y: 300 }}
        />
      ) : (
        <Text type="secondary">
          {t('Auto-populate fields from the configured sources, or leave empty to detect columns at runtime.')}
        </Text>
      )}
    </div>
  );
};

export const CrossJoinConfigurator: React.FC<Props> = ({ visible, onCancel, onSubmit, initialConfig }) => {
  const { t } = useTranslation('plugin-block-cross-join');
  const { message } = App.useApp();
  const [saving, setSaving] = useState(false);
  const [primarySource, setPrimarySource] = useState<{ dataSource: string; collection: string }>(
    initialConfig?.primarySource || { dataSource: 'main', collection: '' },
  );
  const [joins, setJoins] = useState<JoinDef[]>(initialConfig?.joins || []);
  const [columns, setColumns] = useState<ColumnDef[]>(initialConfig?.columns || []);

  useEffect(() => {
    if (!visible) return;
    setPrimarySource(initialConfig?.primarySource || { dataSource: 'main', collection: '' });
    setJoins(initialConfig?.joins || []);
    setColumns(initialConfig?.columns || []);
  }, [visible, initialConfig]);

  const handleOk = async () => {
    const selectedColumns = columns.filter((c) => c.selected !== false);
    setSaving(true);
    try {
      await onSubmit({
        primarySource,
        joins,
        columns: selectedColumns.map(({ selected, ...rest }) => rest),
      });
    } catch (error) {
      message.error(error instanceof Error ? error.message : t('Operation failed'));
    } finally {
      setSaving(false);
    }
  };

  const isValid = primarySource.dataSource && primarySource.collection;

  return (
    <Modal
      title={t('Configure cross join')}
      open={visible}
      onCancel={onCancel}
      onOk={handleOk}
      confirmLoading={saving}
      okButtonProps={{ disabled: !isValid }}
      width={720}
      destroyOnClose
    >
      <Tabs
        items={[
          {
            key: 'primary',
            label: t('Primary Source'),
            children: <PrimarySourceTab value={primarySource} onChange={setPrimarySource} />,
          },
          {
            key: 'joins',
            label: `${t('Joins')} (${joins.length})`,
            children: (
              <JoinsTab
                joins={joins}
                primaryDs={primarySource.dataSource}
                primaryCollection={primarySource.collection}
                onChange={setJoins}
              />
            ),
          },
          {
            key: 'columns',
            label: t('Columns'),
            children: (
              <ColumnsTab
                columns={columns}
                primaryDs={primarySource.dataSource}
                primaryCollection={primarySource.collection}
                joins={joins}
                onChange={setColumns}
              />
            ),
          },
        ]}
      />
    </Modal>
  );
};
