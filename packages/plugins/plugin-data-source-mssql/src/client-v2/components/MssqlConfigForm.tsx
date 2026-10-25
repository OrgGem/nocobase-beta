/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React, { useCallback, useState } from 'react';
import { Checkbox, Form, Input, InputNumber, Select } from 'antd';
import { useFlowContext } from '@nocobase/flow-engine';
import type { DataSourceSettingsFormProps } from '@nocobase/plugin-data-source-manager/client-v2';
import { useTranslation } from 'react-i18next';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
export function toCollectionOptions(result: unknown): { label: string; value: string }[] {
  const data = isRecord(result) ? result.data : result;
  const list = isRecord(data) ? data.data : data;
  if (!Array.isArray(list)) return [];
  return list.flatMap((item: unknown) => {
    const name = typeof item === 'string' ? item : isRecord(item) ? item.name : undefined;
    return typeof name === 'string' ? [{ label: name, value: name }] : [];
  });
}

export const MssqlConfigForm: React.FC<DataSourceSettingsFormProps> = ({ mode, initialValues, loadCollections }) => {
  const { t } = useTranslation();
  const form = Form.useFormInstance();
  const ctx = useFlowContext();
  const addAllCollections = Form.useWatch(['options', 'addAllCollections'], form);
  const [collectionOptions, setCollectionOptions] = useState<{ label: string; value: string }[]>([]);
  const [loading, setLoading] = useState(false);

  const handleLoadCollections = useCallback(async () => {
    setLoading(true);
    try {
      const values = form.getFieldsValue(true);
      const result =
        mode === 'create'
          ? (
              await ctx.api
                .resource('dataSources')
                .readTables({ values: { dataSourceKey: values.key, dbOptions: { ...values.options, type: 'mssql' } } })
            ).data
          : await loadCollections(String(initialValues.key));
      setCollectionOptions(toCollectionOptions(result));
    } catch {
      ctx.message.error(String(t('Unable to load collections')));
    } finally {
      setLoading(false);
    }
  }, [ctx, form, loadCollections, initialValues?.key, mode, t]);

  return (
    <>
      <Form.Item name={['options', 'host']} label={t('Host')} rules={[{ required: true }]}>
        <Input placeholder="localhost" />
      </Form.Item>
      <Form.Item name={['options', 'port']} label={t('Port')} rules={[{ required: true }]} initialValue={1433}>
        <InputNumber min={1} max={65535} style={{ width: '100%' }} />
      </Form.Item>
      <Form.Item name={['options', 'database']} label={t('Database')} rules={[{ required: true }]}>
        <Input />
      </Form.Item>
      <Form.Item name={['options', 'schema']} label={t('Schema')}>
        <Input />
      </Form.Item>
      <Form.Item name={['options', 'username']} label={t('Username')} rules={[{ required: true }]}>
        <Input />
      </Form.Item>
      <Form.Item name={['options', 'password']} label={t('Password')}>
        <Input.Password />
      </Form.Item>
      <Form.Item name={['options', 'encrypt']} label={t('Encrypt')} valuePropName="checked">
        <Checkbox />
      </Form.Item>
      <Form.Item name={['options', 'tablePrefix']} label={t('Table prefix')}>
        <Input />
      </Form.Item>
      <Form.Item
        name={['options', 'addAllCollections']}
        label={t('Load all collections')}
        valuePropName="checked"
        initialValue={initialValues?.options?.addAllCollections ?? initialValues?.addAllCollections ?? true}
      >
        <Checkbox />
      </Form.Item>
      {!addAllCollections ? (
        <Form.Item name="collections" label={t('Collections')}>
          <Select
            mode="multiple"
            allowClear
            loading={loading}
            options={collectionOptions}
            onFocus={handleLoadCollections}
            optionFilterProp="label"
          />
        </Form.Item>
      ) : null}
    </>
  );
};

export default MssqlConfigForm;
