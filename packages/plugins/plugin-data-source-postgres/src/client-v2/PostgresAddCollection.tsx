/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React, { useState } from 'react';
import { App, Button, Checkbox, Drawer, Dropdown, Form, Input, Modal, Select, Space } from 'antd';
import { DeleteOutlined, DownOutlined, PlusOutlined } from '@ant-design/icons';
import { useFlowContext } from '@nocobase/flow-engine';
import type { DataSourceCollectionActionProps } from '@nocobase/plugin-data-source-manager/client-v2';
import { useTranslation } from 'react-i18next';
import { NAMESPACE } from '../constants';
import { toCollectionOptions } from './collection-options';

interface CollectionFormValues {
  name: string;
  title: string;
  timestamps: boolean;
  template: 'general' | 'calendar' | 'file' | 'tree' | 'sql';
  sql?: string;
  sqlFields?: Array<{ name: string; type: SqlFieldType }>;
}

type SqlFieldType = 'string' | 'text' | 'integer' | 'bigInt' | 'decimal' | 'boolean' | 'date' | 'json' | 'uuid';

const SQL_FIELD_INTERFACES: Record<SqlFieldType, string> = {
  string: 'input',
  text: 'textarea',
  integer: 'integer',
  bigInt: 'integer',
  decimal: 'number',
  boolean: 'checkbox',
  date: 'datetime',
  json: 'json',
  uuid: 'uuid',
};

interface CollectionField {
  name: string;
  type: string;
  interface: string;
  primaryKey?: boolean;
  autoIncrement?: boolean;
  allowNull?: boolean;
  field?: string;
  target?: string;
  foreignKey?: string;
  targetKey?: string;
  sourceKey?: string;
  treeParent?: boolean;
  treeChildren?: boolean;
  uiSchema?: Record<string, unknown>;
}

export function PostgresAddCollection({ dataSourceKey, onSubmitted, children }: DataSourceCollectionActionProps) {
  const { t } = useTranslation(NAMESPACE);
  const ctx = useFlowContext();
  const { notification } = App.useApp();
  const [form] = Form.useForm<CollectionFormValues>();
  const template = Form.useWatch('template', form);
  const [creating, setCreating] = useState(false);
  const [loadingTables, setLoadingTables] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [loadOpen, setLoadOpen] = useState(false);
  const [tables, setTables] = useState<{ label: string; value: string }[]>([]);
  const [selectedTables, setSelectedTables] = useState<string[]>([]);

  const refresh = async () => {
    await ctx.dataSourceManager.getDataSource(dataSourceKey)?.reload();
    onSubmitted?.();
  };

  const createCollection = async (values: CollectionFormValues) => {
    const isSql = values.template === 'sql';
    const fields: CollectionField[] = isSql
      ? (values.sqlFields || []).map(({ name, type }) => ({
          name: name.trim(),
          type,
          interface: SQL_FIELD_INTERFACES[type],
        }))
      : [{ name: 'id', type: 'bigInt', interface: 'id', primaryKey: true, autoIncrement: true, allowNull: false }];
    if (values.template === 'calendar') {
      fields.push(
        {
          name: 'title',
          type: 'string',
          interface: 'input',
          uiSchema: {
            title: `{{t("Title", { ns: "${NAMESPACE}" })}}`,
            type: 'string',
            'x-component': 'Input',
          },
        },
        {
          name: 'start',
          type: 'date',
          interface: 'datetime',
          uiSchema: {
            title: `{{t("Start date", { ns: "${NAMESPACE}" })}}`,
            type: 'datetime',
            'x-component': 'DatePicker',
            'x-component-props': { showTime: true },
          },
        },
        {
          name: 'end',
          type: 'date',
          interface: 'datetime',
          uiSchema: {
            title: `{{t("End date", { ns: "${NAMESPACE}" })}}`,
            type: 'datetime',
            'x-component': 'DatePicker',
            'x-component-props': { showTime: true },
          },
        },
      );
    }
    if (values.template === 'file') {
      fields.push(
        {
          name: 'filename',
          type: 'string',
          interface: 'input',
          uiSchema: {
            title: `{{t("Filename", { ns: "${NAMESPACE}" })}}`,
            type: 'string',
            'x-component': 'Input',
          },
        },
        {
          name: 'title',
          type: 'string',
          interface: 'input',
          uiSchema: {
            title: `{{t("Title", { ns: "${NAMESPACE}" })}}`,
            type: 'string',
            'x-component': 'Input',
          },
        },
        {
          name: 'url',
          type: 'string',
          interface: 'url',
          uiSchema: {
            title: `{{t("URL", { ns: "${NAMESPACE}" })}}`,
            type: 'string',
            'x-component': 'Input.URL',
          },
        },
        {
          name: 'mimetype',
          type: 'string',
          interface: 'input',
          uiSchema: {
            title: `{{t("MIME type", { ns: "${NAMESPACE}" })}}`,
            type: 'string',
            'x-component': 'Input',
          },
        },
        {
          name: 'size',
          type: 'bigInt',
          interface: 'integer',
          uiSchema: {
            title: `{{t("File size", { ns: "${NAMESPACE}" })}}`,
            type: 'number',
            'x-component': 'InputNumber',
          },
        },
      );
    }
    if (values.template === 'tree') {
      fields.push(
        {
          name: 'name',
          type: 'string',
          interface: 'input',
          uiSchema: {
            title: `{{t("Name", { ns: "${NAMESPACE}" })}}`,
            type: 'string',
            'x-component': 'Input',
          },
        },
        { name: 'parentId', type: 'bigInt', interface: 'integer' },
        {
          name: 'parent',
          type: 'belongsTo',
          interface: 'm2o',
          target: values.name,
          foreignKey: 'parentId',
          targetKey: 'id',
          treeParent: true,
        },
        {
          name: 'children',
          type: 'hasMany',
          interface: 'o2m',
          target: values.name,
          foreignKey: 'parentId',
          sourceKey: 'id',
          treeChildren: true,
        },
      );
    }
    if (!isSql && values.timestamps) {
      fields.push(
        { name: 'createdAt', type: 'date', interface: 'createdAt', field: 'createdAt' },
        { name: 'updatedAt', type: 'date', interface: 'updatedAt', field: 'updatedAt' },
      );
    }
    setCreating(true);
    try {
      await ctx.api.request({
        url: `dataSources/${encodeURIComponent(dataSourceKey)}/collections:create`,
        method: 'post',
        data: {
          name: values.name,
          title: values.title,
          template: values.template,
          autoGenId: !isSql,
          createdAt: !isSql && values.timestamps,
          updatedAt: !isSql && values.timestamps,
          createdBy: false,
          updatedBy: false,
          fields,
          ...(values.template === 'tree' ? { tree: 'parentId' } : {}),
          ...(isSql ? { sql: values.sql } : {}),
        },
      });
      setCreateOpen(false);
      form.resetFields();
      await refresh();
    } catch (error) {
      notification.error({ message: String(t('Failed to create collection')), description: getErrorMessage(error) });
    } finally {
      setCreating(false);
    }
  };

  const openTables = async () => {
    setSelectedTables([]);
    setTables([]);
    setLoadOpen(true);
    setLoadingTables(true);
    try {
      const response = await ctx.api.resource('dataSources').readTables({ values: { dataSourceKey } });
      setTables(toCollectionOptions(response.data));
    } catch (error) {
      notification.error({ message: String(t('Unable to load collections')), description: getErrorMessage(error) });
    } finally {
      setLoadingTables(false);
    }
  };

  const loadTables = async () => {
    if (!selectedTables.length) return;
    setSubmitting(true);
    try {
      await ctx.api.resource('dataSources').loadTables({ values: { dataSourceKey, tables: selectedTables } });
      setLoadOpen(false);
      await refresh();
    } catch (error) {
      notification.error({ message: String(t('Unable to load collections')), description: getErrorMessage(error) });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <Dropdown
        menu={{
          items: [
            { key: 'create', label: t('Create collection') },
            { key: 'load', label: t('Load existing tables and views') },
          ],
          onClick: ({ key }) => {
            if (key === 'create') setCreateOpen(true);
            if (key === 'load') openTables();
          },
        }}
      >
        <Button icon={<PlusOutlined />}>
          {children || t('Add collection')} <DownOutlined />
        </Button>
      </Dropdown>
      <Drawer
        open={createOpen}
        title={t('Create collection')}
        onClose={() => setCreateOpen(false)}
        extra={
          <Button type="primary" loading={creating} onClick={() => form.submit()}>
            {t('Create')}
          </Button>
        }
        destroyOnClose
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={createCollection}
          initialValues={{ timestamps: true, template: 'general', sqlFields: [{ name: '', type: 'string' }] }}
        >
          <Form.Item name="template" label={t('Collection template')} rules={[{ required: true }]}>
            <Select
              options={[
                { value: 'general', label: t('General collection') },
                { value: 'calendar', label: t('Calendar collection') },
                { value: 'file', label: t('File collection') },
                { value: 'tree', label: t('Tree collection') },
                { value: 'sql', label: t('SQL collection') },
              ]}
            />
          </Form.Item>
          <Form.Item name="name" label={t('Collection name')} rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="title" label={t('Collection display name')} rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          {template === 'sql' ? (
            <>
              <Form.Item
                name="sql"
                label={t('SQL query')}
                extra={t('Use a SELECT query. SQL collections are read-only.')}
                rules={[{ required: true, whitespace: true }]}
              >
                <Input.TextArea autoSize={{ minRows: 5, maxRows: 12 }} />
              </Form.Item>
              <Form.List
                name="sqlFields"
                rules={[
                  {
                    validator: async (_, fields: Array<{ name?: string }> = []) => {
                      if (!fields.length) throw new Error(String(t('Add at least one query column')));
                      const names = fields.map((field) => field?.name?.trim()).filter(Boolean);
                      if (new Set(names).size !== names.length)
                        throw new Error(String(t('Column names must be unique')));
                    },
                  },
                ]}
              >
                {(fields, { add, remove }, { errors }) => (
                  <>
                    {fields.map((field, index) => (
                      <Space key={field.key} align="start" style={{ display: 'flex' }}>
                        <Form.Item name={[field.name, 'name']} rules={[{ required: true, whitespace: true }]}>
                          <Input aria-label={String(t('Column name {{number}}', { number: index + 1 }))} />
                        </Form.Item>
                        <Form.Item name={[field.name, 'type']} rules={[{ required: true }]}>
                          <Select
                            aria-label={String(t('Column type {{number}}', { number: index + 1 }))}
                            style={{ width: 150 }}
                            options={[
                              { value: 'string', label: t('Text') },
                              { value: 'text', label: t('Long text') },
                              { value: 'integer', label: t('Integer') },
                              { value: 'bigInt', label: t('Big integer') },
                              { value: 'decimal', label: t('Decimal') },
                              { value: 'boolean', label: t('Boolean') },
                              { value: 'date', label: t('Date and time') },
                              { value: 'json', label: t('JSON') },
                              { value: 'uuid', label: t('UUID') },
                            ]}
                          />
                        </Form.Item>
                        <Button
                          aria-label={String(t('Remove query column {{number}}', { number: index + 1 }))}
                          icon={<DeleteOutlined />}
                          onClick={() => remove(field.name)}
                        />
                      </Space>
                    ))}
                    <Form.ErrorList errors={errors} />
                    <Button type="dashed" icon={<PlusOutlined />} onClick={() => add({ name: '', type: 'string' })}>
                      {t('Add query column')}
                    </Button>
                  </>
                )}
              </Form.List>
            </>
          ) : (
            <Form.Item name="timestamps" valuePropName="checked">
              <Checkbox>{t('Create timestamp fields')}</Checkbox>
            </Form.Item>
          )}
        </Form>
      </Drawer>
      <Modal
        open={loadOpen}
        title={t('Load existing tables and views')}
        okText={t('Load')}
        okButtonProps={{ disabled: !selectedTables.length || loadingTables }}
        confirmLoading={submitting}
        onOk={loadTables}
        onCancel={() => setLoadOpen(false)}
      >
        <Select
          aria-label={String(t('Collections'))}
          mode="multiple"
          allowClear
          loading={loadingTables}
          options={tables}
          optionFilterProp="label"
          value={selectedTables}
          onChange={setSelectedTables}
          style={{ width: '100%' }}
        />
      </Modal>
    </>
  );
}

function getErrorMessage(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}
